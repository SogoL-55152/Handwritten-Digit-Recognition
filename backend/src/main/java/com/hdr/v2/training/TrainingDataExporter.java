package com.hdr.v2.training;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import com.hdr.v2.collection.CollectedSampleService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntConsumer;

/**
 * 把数据集版本的训练样本导出成"文件名带标签的 PNG 目录"，交给模型服务读取。
 * 只导出 TRAIN 划分；目录按版本号固定，重复导出覆盖同名文件。
 * 同盘优先硬链接；跨盘回退复制时用线程池并行，并回调 0–100 的进度。
 */
@Component
public class TrainingDataExporter {
    private static final Logger LOG = LoggerFactory.getLogger(TrainingDataExporter.class);

    private final JdbcTemplate jdbc;
    private final CollectedSampleService collected;
    private final ObjectMapper mapper;
    private final Path root;

    public TrainingDataExporter(JdbcTemplate jdbc, CollectedSampleService collected, ObjectMapper mapper,
                               @Value("${hdr.training.data-dir:training-data}") String directory) {
        this.jdbc = jdbc;
        this.collected = collected;
        this.mapper = mapper;
        this.root = Paths.get(directory).toAbsolutePath().normalize();
    }

    public record Exported(String directory, int count, Map<String, Integer> labels, int writers) {}

    private static final String MANIFEST = ".export.json";

    /** 版本样本不可变：清单里的数量与当前 TRAIN 数一致即可复用，避免每次任务重写几万张图。 */
    private Exported readManifest(Path target, long versionId, int expectedCount) {
        Path manifest = target.resolve(MANIFEST);
        if (!Files.isRegularFile(manifest) || expectedCount <= 0) return null;
        try {
            Map<String, Object> data = mapper.readValue(manifest.toFile(), Map.class);
            if (!(data.get("versionId") instanceof Number id) || id.longValue() != versionId) return null;
            if (!(data.get("count") instanceof Number count) || count.intValue() != expectedCount) return null;
            Map<String, Integer> labels = new java.util.LinkedHashMap<>();
            Object rawLabels = data.get("labels");
            if (rawLabels instanceof Map<?, ?> map) {
                map.forEach((key, value) -> labels.put(String.valueOf(key),
                        value instanceof Number number ? number.intValue() : 0));
            }
            int writers = data.get("writers") instanceof Number number ? number.intValue() : 0;
            return new Exported(target.toString(), expectedCount, labels, writers);
        } catch (Exception error) {
            LOG.warn("训练数据清单读取失败，将重新导出 ({})", error.getClass().getSimpleName());
            return null;
        }
    }

    private void writeManifest(Path target, long versionId, int count, Map<String, Integer> labels, int writers) {
        try {
            Map<String, Object> data = new java.util.LinkedHashMap<>();
            data.put("versionId", versionId);
            data.put("count", count);
            data.put("labels", labels);
            data.put("writers", writers);
            data.put("exportedAt", java.time.Instant.now().toString());
            mapper.writeValue(target.resolve(MANIFEST).toFile(), data);
        } catch (Exception error) {
            LOG.warn("训练数据清单写入失败 ({})", error.getClass().getSimpleName());
        }
    }

    private void clearDirectory(Path target) throws java.io.IOException {
        try (var stream = Files.walk(target)) {
            stream.sorted(java.util.Comparator.reverseOrder())
                    .filter(path -> !path.equals(target))
                    .forEach(path -> {
                        try { Files.deleteIfExists(path); } catch (java.io.IOException ignored) { }
                    });
        }
    }

    public Exported export(long versionId) {
        return export(versionId, progress -> { });
    }

    /** progress 回调收到 0–100 的百分比；manifest 缓存命中时只回调一次 100。 */
    public Exported export(long versionId, IntConsumer progress) {
        Long expected = jdbc.queryForObject("""
                SELECT COUNT(*) FROM t_v2_dataset_sample WHERE version_id=? AND split='TRAIN'
                """, Long.class, versionId);
        Path cached = root.resolve("v" + versionId);
        Exported reuse = readManifest(cached, versionId, expected == null ? 0 : expected.intValue());
        if (reuse != null) {
            LOG.info("复用已导出的训练数据: v{} ({} 张)", versionId, reuse.count());
            progress.accept(100);
            return reuse;
        }
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT s.sample_id, s.label, s.writer_key, c.artifact_path
                FROM t_v2_dataset_sample s
                JOIN t_collected_sample c ON c.id = s.sample_id
                WHERE s.version_id=? AND s.split='TRAIN'
                ORDER BY s.id
                """, versionId);
        if (rows.isEmpty())
            throw new V2Exception(400, "该版本没有训练集样本，无法用于训练", "NO_TRAIN_SAMPLES");
        Path target = cached;
        try {
            if (Files.isDirectory(target)) clearDirectory(target);
            Files.createDirectories(target);
            // 并行写文件：同盘硬链接仍是首选，跨盘回退复制时线程池能显著缩短准备时间
            int workers = Math.max(2, Math.min(8, Runtime.getRuntime().availableProcessors()));
            int total = rows.size();
            AtomicInteger done = new AtomicInteger();
            AtomicInteger lastReported = new AtomicInteger(-1);
            List<PartResult> parts = new ArrayList<>();
            // Java 17 的 ExecutorService 还不是 AutoCloseable，显式 shutdown
            ExecutorService pool = Executors.newFixedThreadPool(workers);
            try {
                List<Future<PartResult>> futures = new ArrayList<>();
                for (int start = 0; start < rows.size(); start += workers) {
                    int from = start;
                    int to = Math.min(rows.size(), start + workers);
                    futures.add(pool.submit(() -> exportSlice(rows.subList(from, to), target, versionId,
                            done, total, lastReported, progress)));
                }
                for (Future<PartResult> future : futures) parts.add(future.get());
            } finally {
                pool.shutdownNow();
            }
            Map<String, Integer> labels = new LinkedHashMap<>();
            java.util.Set<String> writers = new java.util.HashSet<>();
            int written = 0;
            for (PartResult part : parts) {
                part.labels().forEach((label, count) -> labels.merge(label, count, Integer::sum));
                writers.addAll(part.writers());
                written += part.written();
            }
            if (written == 0) throw new V2Exception(400, "该版本的训练样本没有可读图片", "NO_TRAIN_SAMPLES");
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("versionId", versionId);
            manifest.put("count", written);
            manifest.put("labels", labels);
            manifest.put("writers", writers.size());
            Files.writeString(target.resolve("manifest.json"),
                    mapper.writeValueAsString(manifest) + "\n");
            writeManifest(target, versionId, written, labels, writers.size());
            progress.accept(100);
            return new Exported(target.toString(), written, labels, writers.size());
        } catch (IOException error) {
            LOG.warn("Training data export failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "训练数据导出失败，请稍后重试", "STORAGE_UNAVAILABLE");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new V2Exception(503, "训练数据导出被中断，请稍后重试", "STORAGE_UNAVAILABLE");
        } catch (java.util.concurrent.ExecutionException error) {
            LOG.warn("Training data export worker failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "训练数据导出失败，请稍后重试", "STORAGE_UNAVAILABLE");
        }
    }

    private record PartResult(Map<String, Integer> labels, java.util.Set<String> writers, int written) {}

    /** 一个线程负责的行区间：写文件，完成后推进全局进度计数并节流汇报（每 2% 一次）。 */
    private PartResult exportSlice(List<Map<String, Object>> rows, Path target, long versionId,
                                   AtomicInteger done, int total, AtomicInteger lastReported, IntConsumer progress) {
        Map<String, Integer> labels = new LinkedHashMap<>();
        java.util.Set<String> writers = new java.util.HashSet<>();
        int written = 0;
        for (Map<String, Object> row : rows) {
            String label = String.valueOf(row.get("label"));
            if (!label.matches("[0-9]{1,4}")) continue;
            String name = label + "_" + row.get("sample_id") + ".png";
            Path source;
            try {
                source = collected.artifactPath(String.valueOf(row.get("artifact_path")));
            } catch (V2Exception missing) {
                LOG.warn("Skip unreadable sample {} for version {}", row.get("sample_id"), versionId);
                continue;
            }
            // 同盘优先硬链接：不复制字节，几万张也几乎是秒级
            try {
                if (Files.exists(target.resolve(name))) Files.delete(target.resolve(name));
                Files.createLink(target.resolve(name), source);
            } catch (IOException | UnsupportedOperationException linkFailed) {
                try {
                    Files.write(target.resolve(name), Files.readAllBytes(source));
                } catch (IOException copyFailed) {
                    LOG.warn("Skip uncopiable sample {} for version {}", row.get("sample_id"), versionId);
                    continue;
                }
            }
            labels.merge(label, 1, Integer::sum);
            writers.add(String.valueOf(row.get("writer_key")));
            written += 1;
        }
        int finished = done.addAndGet(rows.size());
        int percent = Math.min(99, (int) Math.round(finished * 100.0 / Math.max(1, total)));
        int last = lastReported.get();
        if (percent >= last + 2 && lastReported.compareAndSet(last, percent)) progress.accept(percent);
        return new PartResult(labels, writers, written);
    }
}
