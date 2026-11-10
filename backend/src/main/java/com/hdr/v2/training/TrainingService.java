package com.hdr.v2.training;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.model.ModelAdminService;
import com.hdr.v2.recognition.ModelClient;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 训练任务状态机。数据库是唯一事实来源；Python 通过内部回调推进状态，
 * 回调参数只接受约定字段，未注册/未校验的产物不会进入模型目录。
 */
@Service
public class TrainingService {
    public record CreateRequest(Integer epochs, Integer samples, Integer batchSize, Double learningRate,
                                Long seed, Double photoRatio, Boolean useEmnist, String initFrom) {}
    public record TaskView(String id, String status, int attempt, String celeryTaskId, int epochs, int samples,
                           int batchSize, double learningRate, long seed, double photoRatio, boolean useEmnist,
                           String initFrom, String targetModelId, String modelVersion, String artifact, String sha256, Long sizeBytes,
                           String errorCategory, String errorMessage, String queuedAt, String startedAt,
                           String finishedAt, JsonNode metrics) {}
    private static final List<String> STATES = List.of("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED");
    private final JdbcTemplate jdbc;
    private final ModelClient client;
    private final ModelAdminService models;
    private final CatalogueService catalogue;
    private final ObjectMapper mapper;
    private final TrainingEventBus events;

    public TrainingService(JdbcTemplate jdbc, ModelClient client, ModelAdminService models,
                           CatalogueService catalogue, ObjectMapper mapper, TrainingEventBus events) {
        this.jdbc = jdbc; this.client = client; this.models = models; this.catalogue = catalogue;
        this.mapper = mapper; this.events = events;
    }

    @Transactional
    public TaskView create(long creatorId, long datasetId, CreateRequest request) {
        Map<String, Object> params = validated(request);
        String initFrom = resolvedInitFrom(request.initFrom());
        params.put("initFrom", initFrom);
        Long datasets = jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_dataset WHERE id=? AND status='ACTIVE'",
                Long.class, datasetId);
        if (datasets == null || datasets == 0) throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
        CatalogueService.Model target = catalogue.activeModel();
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement statement = connection.prepareStatement("""
                    INSERT INTO t_v2_training_task(creator_id,dataset_id,target_model_id,status,epochs,samples,
                        batch_size,learning_rate,seed,photo_ratio,use_emnist,init_from)
                    VALUES(?,?,?,'QUEUED',?,?,?,?,?,?,?,?)
                    """, Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, creatorId);
            statement.setLong(2, datasetId);
            statement.setLong(3, Long.parseLong(target.id()));
            statement.setInt(4, (Integer) params.get("epochs"));
            statement.setInt(5, (Integer) params.get("samples"));
            statement.setInt(6, (Integer) params.get("batchSize"));
            statement.setDouble(7, ((Number) params.get("learningRate")).doubleValue());
            statement.setLong(8, (Long) params.get("seed"));
            statement.setDouble(9, ((Number) params.get("photoRatio")).doubleValue());
            statement.setBoolean(10, (Boolean) params.get("useEmnist"));
            if (initFrom == null) statement.setNull(11, java.sql.Types.VARCHAR); else statement.setString(11, initFrom);
            return statement;
        }, key);
        Number generated = key.getKey();
        if (generated == null) throw new IllegalStateException("Training task id was not generated");
        long taskId = generated.longValue();
        try {
            String celeryTaskId = client.enqueueTraining(Long.toString(taskId), params);
            jdbc.update("UPDATE t_v2_training_task SET celery_task_id=? WHERE id=?", celeryTaskId, taskId);
        } catch (RuntimeException error) {
            // 入队失败必须如实落成 FAILED，不能让任务停在 QUEUED 假装排队。
            jdbc.update("""
                    UPDATE t_v2_training_task SET status='FAILED', error_category='QUEUE_UNAVAILABLE',
                        error_message='训练队列暂不可用', finished_at=UTC_TIMESTAMP() WHERE id=?
                    """, taskId);
            throw error;
        }
        TaskView created = view(taskId);
        events.publish(created);
        return created;
    }

    /** Python 回调：推进状态并（成功时）登记模型。回调只能前进，不能把已成功改回运行。 */
    @Transactional
    public TaskView applyState(long taskId, String state, int attempt, Map<String, Object> rest) {
        if (!STATES.contains(state) || state.equals("QUEUED") || state.equals("CANCELED"))
            throw new V2Exception(400, "回调状态无效", "VALIDATION");
        TaskRow row = requireRow(taskId);
        if ("SUCCEEDED".equals(row.status())) throw new V2Exception(409, "任务已成功，不能再变更", "TASK_TERMINAL");
        if (attempt < 1 || attempt > 99) throw new V2Exception(400, "attempt 无效", "VALIDATION");
        if ("RUNNING".equals(row.status()) && attempt < row.attempt())
            throw new V2Exception(409, "回调 attempt 回退", "TASK_STALE_ATTEMPT");
        switch (state) {
            case "RUNNING" -> {
                jdbc.update("""
                        UPDATE t_v2_training_task SET status='RUNNING', attempt=GREATEST(attempt,?),
                            started_at=COALESCE(started_at, UTC_TIMESTAMP()) WHERE id=?
                        """, attempt, taskId);
                recordEpoch(taskId, attempt, rest.get("metrics"));
            }
            case "FAILED" -> jdbc.update("""
                    UPDATE t_v2_training_task SET status='FAILED', attempt=?, error_category=?, error_message=?,
                        finished_at=UTC_TIMESTAMP() WHERE id=?
                    """, attempt, text(rest.get("errorCategory"), 32), text(rest.get("errorMessage"), 255), taskId);
            case "SUCCEEDED" -> {
                String version = text(rest.get("modelVersion"), 64);
                String artifact = text(rest.get("artifact"), 191);
                String sha256 = text(rest.get("sha256"), 64);
                long sizeBytes = rest.get("sizeBytes") instanceof Number n ? n.longValue() : -1;
                if (version.isBlank() || artifact.isBlank() || !sha256.matches("[0-9a-f]{64}") || sizeBytes <= 0)
                    throw new V2Exception(400, "成功回调缺少产物信息", "VALIDATION");
                jdbc.update("""
                        UPDATE t_v2_training_task SET status='SUCCEEDED', attempt=?, model_version=?, artifact=?,
                            sha256=?, size_bytes=?, metrics=?, finished_at=UTC_TIMESTAMP() WHERE id=?
                        """, attempt, version, artifact, sha256, sizeBytes,
                        rest.get("metrics") instanceof Map<?, ?> m ? mapper.valueToTree(m).toString() : null, taskId);
                writeMetrics(taskId, attempt, rest.get("metrics"));
                registerArtifact(row, version);
            }
            default -> throw new V2Exception(400, "回调状态无效", "VALIDATION");
        }
        TaskView updated = view(taskId);
        events.publish(updated);
        return updated;
    }

    /** 单轮实时指标：Python 每跑完一轮就回调一次，写库并推给前端画曲线。 */
    private void recordEpoch(long taskId, int attempt, Object metrics) {
        if (!(metrics instanceof Map<?, ?> map)) return;
        if (!(map.get("epoch") instanceof Number epochNumber)) return;
        int epoch = epochNumber.intValue();
        if (epoch < 1 || epoch > 99) return;
        jdbc.update("""
                INSERT INTO t_v2_training_metric(task_id,attempt,epoch,loss,raw_mnist,canvas_simulated,photo_simulated)
                VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE loss=VALUES(loss), raw_mnist=VALUES(raw_mnist),
                    canvas_simulated=VALUES(canvas_simulated), photo_simulated=VALUES(photo_simulated)
                """, taskId, attempt, epoch, number(map.get("loss")), number(map.get("raw_mnist")),
                number(map.get("canvas_simulated")), number(map.get("photo_simulated")));
    }

    /** 用 W3 的登记接口把关：摘要必须与注册表一致，落库为 INACTIVE，激活仍是管理员动作。 */
    private void registerArtifact(TaskRow row, String version) {
        try {
            models.register(new ModelAdminService.RegisterCommand(row.externalId(), version));
        } catch (V2Exception conflict) {
            // 训练成功但登记被拒（例如已存在同名版本）不能算训练失败，如实标注。
            jdbc.update("UPDATE t_v2_training_task SET error_category='MODEL_REGISTER_FAILED', error_message=? WHERE id=?",
                    conflict.getMessage() == null ? "登记失败" : conflict.getMessage().substring(0, Math.min(255, conflict.getMessage().length())),
                    Long.parseLong(row.id()));
        }
    }

    private void writeMetrics(long taskId, int attempt, Object metrics) {
        if (!(metrics instanceof Map<?, ?> map) || !(map.get("history") instanceof List<?> history)) return;
        int epoch = 0;
        for (Object item : history) {
            if (!(item instanceof Map<?, ?> entry)) continue;
            epoch++;
            jdbc.update("""
                    INSERT INTO t_v2_training_metric(task_id,attempt,epoch,loss,raw_mnist,canvas_simulated,photo_simulated)
                    VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE loss=VALUES(loss), raw_mnist=VALUES(raw_mnist),
                        canvas_simulated=VALUES(canvas_simulated), photo_simulated=VALUES(photo_simulated)
                    """, taskId, attempt, epoch, number(entry.get("loss")), number(entry.get("raw_mnist")),
                    number(entry.get("canvas_simulated")), number(entry.get("photo_simulated")));
        }
    }

    /** 可选数据集：W4 只用已有元数据，不提供上传。 */
    public List<Map<String, Object>> datasets() {
        return jdbc.query("""
                SELECT id,name,version,train_samples,test_samples,description FROM t_v2_dataset
                WHERE status='ACTIVE' AND scope='PUBLIC' ORDER BY id
                """, (rs, i) -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", rs.getString("id"));
            item.put("name", rs.getString("name"));
            item.put("version", rs.getString("version"));
            item.put("trainSamples", rs.getInt("train_samples"));
            item.put("testSamples", rs.getInt("test_samples"));
            item.put("description", rs.getString("description"));
            return item;
        });
    }

    public List<TaskView> list(int limit) {
        return jdbc.query("SELECT * FROM t_v2_training_task ORDER BY id DESC LIMIT ?", (rs, i) -> view(row(rs, i)), limit);
    }

    public TaskView view(long id) { return view(requireRow(id)); }

    private TaskRow requireRow(long id) {
        return jdbc.query("SELECT * FROM t_v2_training_task WHERE id=?", TrainingService::row, id)
                .stream().findFirst().orElseThrow(() -> new V2Exception(404, "训练任务不存在", "TASK_NOT_FOUND"));
    }

    private TaskView view(TaskRow row) {
        JsonNode metrics = null;
        if (row.metrics() != null && !row.metrics().isBlank()) {
            try { metrics = mapper.readTree(row.metrics()); } catch (Exception ignored) { /* 历史脏数据不影响列表 */ }
        }
        if (metrics == null && ("RUNNING".equals(row.status()) || "FAILED".equals(row.status())))
            metrics = runningMetrics(row.id(), row.attempt());
        return new TaskView(row.id(), row.status(), row.attempt(), row.celeryTaskId(), row.epochs(), row.samples(),
                row.batchSize(), row.learningRate(), row.seed(), row.photoRatio(), row.useEmnist(),
                row.initFrom(), row.targetModelId(), row.modelVersion(), row.artifact(), row.sha256(), row.sizeBytes(),
                row.errorCategory(), row.errorMessage(), row.queuedAt(), row.startedAt(), row.finishedAt(), metrics);
    }

    private static Map<String, Object> validated(CreateRequest request) {
        if (request == null) throw new V2Exception(400, "缺少训练参数", "VALIDATION");
        int epochs = require(request.epochs(), "epochs");
        int samples = require(request.samples(), "samples");
        int batch = require(request.batchSize(), "batchSize");
        if (epochs < 1 || epochs > 5) throw new V2Exception(400, "epochs 必须在 1..5", "VALIDATION");
        if (samples < 1000 || samples > 60000) throw new V2Exception(400, "samples 必须在 1000..60000", "VALIDATION");
        if (batch != 32 && batch != 64 && batch != 128) throw new V2Exception(400, "batchSize 必须是 32/64/128", "VALIDATION");
        if (request.learningRate() == null || !(request.learningRate() > 0) || request.learningRate() > 0.1
                || !Double.isFinite(request.learningRate()))
            throw new V2Exception(400, "learningRate 必须在 (0, 0.1]", "VALIDATION");
        if (request.seed() == null || request.seed() < 0 || request.seed() > 4294967295L)
            throw new V2Exception(400, "seed 必须是 0..4294967295 的整数", "VALIDATION");
        if (request.photoRatio() == null || !Double.isFinite(request.photoRatio())
                || request.photoRatio() < 0 || request.photoRatio() > 1)
            throw new V2Exception(400, "photoRatio 必须在 0..1", "VALIDATION");
        if (request.useEmnist() == null) throw new V2Exception(400, "useEmnist 必须是布尔值", "VALIDATION");
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("epochs", epochs);
        params.put("samples", samples);
        params.put("batchSize", batch);
        params.put("learningRate", request.learningRate());
        params.put("seed", request.seed());
        params.put("photoRatio", request.photoRatio());
        params.put("useEmnist", request.useEmnist());
        return params;
    }

    /** "从哪个模型微调"：null 表示从零训练；非 null 必须是数据库里已登记的公共模型版本。 */
    private String resolvedInitFrom(String version) {
        if (version == null || version.isBlank()) return null;
        if (!version.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}"))
            throw new V2Exception(400, "initFrom 格式无效", "VALIDATION");
        Long found = jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_model WHERE scope='PUBLIC' AND version=?", Long.class, version);
        if (found == null || found == 0)
            throw new V2Exception(400, "initFrom 必须是已登记的模型版本", "MODEL_NOT_FOUND");
        return version;
    }

    private static int require(Integer value, String field) {
        if (value == null) throw new V2Exception(400, "缺少 " + field, "VALIDATION");
        return value;
    }

    private static String text(Object value, int max) {
        String text = value == null ? "" : String.valueOf(value);
        return text.length() > max ? text.substring(0, max) : text;
    }

    private static Double number(Object value) {
        return value instanceof Number n ? n.doubleValue() : null;
    }

    /** 运行中的任务还没有最终指标，用逐轮表拼出曲线，前端才能实时画。 */
    private JsonNode runningMetrics(String taskId, int attempt) {
        var history = mapper.createArrayNode();
        jdbc.query("""
                SELECT epoch,loss,raw_mnist,canvas_simulated,photo_simulated FROM t_v2_training_metric
                WHERE task_id=? AND attempt=? ORDER BY epoch
                """, (rs, index) -> {
            var item = mapper.createObjectNode();
            item.put("epoch", rs.getInt("epoch"));
            item.put("loss", rs.getDouble("loss"));
            item.put("raw_mnist", rs.getDouble("raw_mnist"));
            item.put("canvas_simulated", rs.getDouble("canvas_simulated"));
            item.put("photo_simulated", rs.getDouble("photo_simulated"));
            history.add(item);
            return index;
        }, Long.parseLong(taskId), attempt);
        if (history.isEmpty()) return null;
        var root = mapper.createObjectNode();
        root.set("history", history);
        return root;
    }

    private record TaskRow(String id, String status, int attempt, String celeryTaskId, int epochs, int samples,
                           int batchSize, double learningRate, long seed, double photoRatio, boolean useEmnist,
                           String initFrom, String targetModelId, String modelVersion, String artifact, String sha256, Long sizeBytes,
                           String errorCategory, String errorMessage, String metrics, String queuedAt,
                           String startedAt, String finishedAt) {
        String externalId() { return "mnist-cnn-w1"; }
    }

    private static TaskRow row(ResultSet rs, int index) throws SQLException {
        Object size = rs.getObject("size_bytes");
        Timestamp started = rs.getTimestamp("started_at");
        Timestamp finished = rs.getTimestamp("finished_at");
        return new TaskRow(rs.getString("id"), rs.getString("status"), rs.getInt("attempt"),
                rs.getString("celery_task_id"), rs.getInt("epochs"), rs.getInt("samples"), rs.getInt("batch_size"),
                rs.getDouble("learning_rate"), rs.getLong("seed"), rs.getDouble("photo_ratio"),
                rs.getBoolean("use_emnist"), rs.getString("init_from"),
                rs.getString("target_model_id"), rs.getString("model_version"),
                rs.getString("artifact"), rs.getString("sha256"), size == null ? null : ((Number) size).longValue(),
                rs.getString("error_category"), rs.getString("error_message"), rs.getString("metrics"),
                Instant.ofEpochMilli(rs.getTimestamp("queued_at").getTime()).toString(),
                started == null ? null : Instant.ofEpochMilli(started.getTime()).toString(),
                finished == null ? null : Instant.ofEpochMilli(finished.getTime()).toString());
    }
}
