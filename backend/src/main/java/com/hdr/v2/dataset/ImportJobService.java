package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/**
 * 异步导入任务：把「扫描 + 逐张导入」从前端请求里挪到后台线程，前端改为轮询进度、可取消。
 *
 * 为什么不用 Celery：导入要做的事全在 Java 侧（目录扫描、标签匹配、写采集库），
 * 交给 Python worker 反而要重新实现一遍。代价是**单实例内存队列**：
 * 多实例部署时任务只在提交它的那个实例上跑（任务表仍然可查），重启会丢失 QUEUED/RUNNING 的任务。
 * 这两点在文档里写明，属于当前规模下的自觉取舍。
 */
@Service
public class ImportJobService {
    private static final Logger LOG = LoggerFactory.getLogger(ImportJobService.class);
    private static final int QUEUE_CAPACITY = 32;
    /** 取消标记的缓存窗口：避免每张图都查一次数据库。 */
    private static final long CANCEL_POLL_MILLIS = 1000;

    public record JobView(String id, String datasetId, String status, String sourceKind,
                          int progressTotal, int progressDone, int imported, int duplicates, int failed,
                          String errorMessage, String importBatchId, boolean cancelRequested,
                          String directory, String createdAt, String startedAt, String finishedAt) {
        public Double percent() {
            if (progressTotal <= 0) return null;
            return Math.round(Math.min(1.0, progressDone / (double) progressTotal) * 1000) / 10.0;
        }
    }

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final ImportWizardService wizard;
    private final ThreadPoolExecutor executor;

    public ImportJobService(JdbcTemplate jdbc, WorkspaceService spaces, ImportWizardService wizard) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.wizard = wizard;
        AtomicInteger counter = new AtomicInteger();
        this.executor = new ThreadPoolExecutor(2, 2, 60, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                runnable -> {
                    Thread thread = new Thread(runnable, "import-job-" + counter.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                },
                new ThreadPoolExecutor.AbortPolicy());
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }

    /**
     * 建任务并立刻返回。真正的扫描与导入在后台线程里跑，进度写回任务表。
     * sourceKind：DIRECTORY（服务器目录）/ ZIP（已解压的 zip 临时目录）/ UPLOAD（浏览器上传的临时目录）。
     */
    public JobView create(long workspaceId, long userId, long datasetId, String sourceKind,
                          String directory, String token, ImportWizardService.CsvMapping mapping) {
        spaces.requireMember(workspaceId, userId);
        wizard.assertDatasetEditable(workspaceId, datasetId);
        String kind = normalizeKind(sourceKind);
        boolean cleanup = !"DIRECTORY".equals(kind);
        String target = "DIRECTORY".equals(kind)
                ? wizard.requireDirectory(directory)
                : wizard.resolveTemp(token, kind).toString();
        long id = insert(workspaceId, userId, datasetId, kind, target, cleanup, mapping);
        try {
            executor.execute(() -> run(id));
        } catch (RejectedExecutionException busy) {
            jdbc.update("UPDATE t_import_job SET status='FAILED', error_message=?, finished_at=UTC_TIMESTAMP(3) WHERE id=?",
                    "导入队列已满，请稍后重试", id);
            throw new V2Exception(429, "导入队列已满，请稍后重试", "IMPORT_QUEUE_FULL", 5);
        }
        return get(workspaceId, userId, id);
    }

    public JobView get(long workspaceId, long userId, long jobId) {
        spaces.requireMember(workspaceId, userId);
        List<JobView> rows = jdbc.query("""
                SELECT id, dataset_id, status, source_kind, progress_total, progress_done, imported, duplicates,
                       failed, error_message, import_batch_id, cancel_requested, directory, created_at,
                       started_at, finished_at
                FROM t_import_job WHERE id=? AND workspace_id=?
                """, (rs, index) -> new JobView(
                        String.valueOf(rs.getLong("id")), String.valueOf(rs.getLong("dataset_id")),
                        rs.getString("status"), rs.getString("source_kind"),
                        rs.getInt("progress_total"), rs.getInt("progress_done"), rs.getInt("imported"),
                        rs.getInt("duplicates"), rs.getInt("failed"), rs.getString("error_message"),
                        rs.getString("import_batch_id") == null ? null : String.valueOf(rs.getString("import_batch_id")),
                        rs.getBoolean("cancel_requested"), rs.getString("directory"),
                        String.valueOf(rs.getTimestamp("created_at")),
                        rs.getTimestamp("started_at") == null ? null : String.valueOf(rs.getTimestamp("started_at")),
                        rs.getTimestamp("finished_at") == null ? null : String.valueOf(rs.getTimestamp("finished_at"))),
                jobId, workspaceId);
        if (rows.isEmpty()) throw new V2Exception(404, "导入任务不存在", "JOB_NOT_FOUND");
        return rows.get(0);
    }

    /** 协作式取消：RUNNING 的任务在下一个文件前停下；QUEUED 的直接标记取消。 */
    public JobView cancel(long workspaceId, long userId, long jobId) {
        JobView job = get(workspaceId, userId, jobId);
        if (!"QUEUED".equals(job.status()) && !"RUNNING".equals(job.status()))
            return job;
        jdbc.update("UPDATE t_import_job SET cancel_requested=1 WHERE id=?", jobId);
        if ("QUEUED".equals(job.status())) {
            // 还没开始跑：直接落终态，避免线程池里排着的任务又跑一遍
            jdbc.update("""
                    UPDATE t_import_job SET status='CANCELED', finished_at=UTC_TIMESTAMP(3)
                    WHERE id=? AND status='QUEUED'
                    """, jobId);
        }
        return get(workspaceId, userId, jobId);
    }

    public List<JobView> recent(long workspaceId, long userId, int limit) {
        spaces.requireMember(workspaceId, userId);
        return jdbc.query("""
                SELECT id FROM t_import_job WHERE workspace_id=? ORDER BY id DESC LIMIT ?
                """, (rs, index) -> get(workspaceId, userId, rs.getLong(1)),
                workspaceId, Math.min(20, Math.max(1, limit)));
    }

    // ---------- 后台执行 ----------

    private void run(long jobId) {
        Map<String, Object> row = jdbc.queryForMap("""
                SELECT workspace_id, dataset_id, status, directory, file_column, label_column, cleanup
                FROM t_import_job WHERE id=?
                """, jobId);
        if (!"QUEUED".equals(row.get("status"))) return;      // 已被取消
        long workspaceId = ((Number) row.get("workspace_id")).longValue();
        long datasetId = ((Number) row.get("dataset_id")).longValue();
        String directory = String.valueOf(row.get("directory"));
        boolean cleanup = ((Number) row.get("cleanup")).intValue() == 1;
        ImportWizardService.CsvMapping mapping = new ImportWizardService.CsvMapping(
                row.get("file_column") == null ? null : String.valueOf(row.get("file_column")),
                row.get("label_column") == null ? null : String.valueOf(row.get("label_column")));
        jdbc.update("UPDATE t_import_job SET status='RUNNING', started_at=UTC_TIMESTAMP(3) WHERE id=?", jobId);
        try {
            ImportWizardService.PreparedImport prepared =
                    wizard.prepare(workspaceId, creatorOf(jobId), datasetId, directory, mapping);
            jdbc.update("""
                    UPDATE t_import_job SET import_batch_id=?, progress_total=?, progress_done=0 WHERE id=?
                    """, prepared.batchId(), prepared.preview().total(), jobId);
            ImportWizardService.ImportOutcome outcome = wizard.runPrepared(prepared, workspaceId, creatorOf(jobId), datasetId, new JobProgressSink(jobId));
            jdbc.update("""
                    UPDATE t_import_job SET status=?, imported=?, duplicates=?, failed=?,
                           finished_at=UTC_TIMESTAMP(3) WHERE id=?
                    """, outcome.canceled() ? "CANCELED" : "SUCCEEDED",
                    outcome.imported(), outcome.duplicates(), outcome.failed(), jobId);
        } catch (V2Exception expected) {
            fail(jobId, expected.getMessage());
        } catch (RuntimeException unexpected) {
            LOG.warn("导入任务 {} 失败 ({})", jobId, unexpected.getClass().getSimpleName());
            fail(jobId, "导入失败：内部错误，请查看服务端日志");
        } finally {
            if (cleanup) deleteTree(Path.of(directory));
        }
    }

    private long creatorOf(long jobId) {
        Long owner = jdbc.queryForObject("SELECT created_by FROM t_import_job WHERE id=?", Long.class, jobId);
        return owner == null ? 0 : owner;
    }

    private void fail(long jobId, String message) {
        jdbc.update("""
                UPDATE t_import_job SET status='FAILED', error_message=?, finished_at=UTC_TIMESTAMP(3) WHERE id=?
                """, message == null ? null : (message.length() > 1000 ? message.substring(0, 1000) : message), jobId);
    }

    private long insert(long workspaceId, long userId, long datasetId, String kind, String directory,
                        boolean cleanup, ImportWizardService.CsvMapping mapping) {
        var keys = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                    INSERT INTO t_import_job(workspace_id, dataset_id, source_kind, directory, file_column,
                                             label_column, cleanup, status, created_by)
                    VALUES(?,?,?,?,?,?,?,'QUEUED',?)
                    """, java.sql.Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, workspaceId);
            statement.setLong(2, datasetId);
            statement.setString(3, kind);
            statement.setString(4, directory);
            statement.setString(5, mapping == null ? null : mapping.fileColumn());
            statement.setString(6, mapping == null ? null : mapping.labelColumn());
            statement.setInt(7, cleanup ? 1 : 0);
            statement.setLong(8, userId);
            return statement;
        }, keys);
        Number key = keys.getKey();
        if (key == null) throw new IllegalStateException("import job id not generated");
        return key.longValue();
    }

    static String normalizeKind(String kind) {
        String value = kind == null ? "DIRECTORY" : kind.trim().toUpperCase();
        if (!List.of("DIRECTORY", "ZIP", "UPLOAD").contains(value))
            throw new V2Exception(400, "sourceKind 只能是 DIRECTORY/ZIP/UPLOAD", "VALIDATION");
        return value;
    }

    private static void deleteTree(Path root) {
        if (root == null || !Files.isDirectory(root)) return;
        try (Stream<Path> stream = Files.walk(root)) {
            stream.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        } catch (IOException error) {
            LOG.warn("清理导入临时目录失败 ({})", error.getClass().getSimpleName());
        }
    }

    /** 进度写库 + 取消标记轮询（1 秒缓存，避免每张图都查库）。 */
    private final class JobProgressSink implements ImportWizardService.ProgressSink {
        private final long jobId;
        private long lastPoll;
        private boolean canceled;

        private JobProgressSink(long jobId) { this.jobId = jobId; }

        @Override
        public void progress(int done, int total) {
            jdbc.update("UPDATE t_import_job SET progress_done=?, progress_total=? WHERE id=?",
                    done, total, jobId);
        }

        @Override
        public boolean canceled() {
            long now = System.currentTimeMillis();
            if (now - lastPoll < CANCEL_POLL_MILLIS) return canceled;
            lastPoll = now;
            Boolean flag = jdbc.queryForObject("SELECT cancel_requested FROM t_import_job WHERE id=?",
                    Boolean.class, jobId);
            canceled = Boolean.TRUE.equals(flag);
            return canceled;
        }
    }
}
