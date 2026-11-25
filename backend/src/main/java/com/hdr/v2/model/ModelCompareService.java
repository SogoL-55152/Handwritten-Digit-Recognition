package com.hdr.v2.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.hdr.v2.V2Exception;
import com.hdr.v2.collection.CollectedSampleService;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 两个模型版本的并排对比：
 *  1. 元数据（版本、预处理版本、来源、准确率、摘要、是否仍在注册表里）；
 *  2. 各自训练时的三域指标（来自 t_v2_training_task.metrics）；
 *  3. 在同一批**带标签的真实样本**上逐张跑两个模型，给出差异样本与谁对谁错。
 *
 * 只做只读评估：不落库、不改生效模型、不写识别记录。
 */
@Service
public class ModelCompareService {
    private static final Logger LOG = LoggerFactory.getLogger(ModelCompareService.class);
    public static final int MAX_SAMPLES = 200;
    public static final int DEFAULT_SAMPLES = 100;
    /** 单张样本上限：对比是同步请求，过大的图会拖长整体耗时。 */
    private static final long MAX_IMAGE_BYTES = 512 * 1024;

    public record Command(String versionA, String versionB, Long datasetVersionId, Integer limit) {}

    public record Side(String id, String version, String externalId, String preprocessVersion, String status,
                       Double accuracy, String accuracyDataset, String origin, String trainedAt,
                       String sha256, Long sizeBytes, boolean inRegistry, boolean verified,
                       JsonNode trainingMetrics) {}

    public record Row(int index, String sampleId, int label, int digitA, double confidenceA,
                      int digitB, double confidenceB, boolean agree) {}

    public record CompareView(Side modelA, Side modelB, ModelClient.CompareSummary summary,
                              List<Row> rows, long processingMs, long datasetVersionId, int skipped) {}

    private final JdbcTemplate jdbc;
    private final ModelClient client;
    private final WorkspaceService spaces;
    private final CollectedSampleService collected;
    private final ObjectMapper mapper;

    public ModelCompareService(JdbcTemplate jdbc, ModelClient client, WorkspaceService spaces,
                               CollectedSampleService collected, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.client = client;
        this.spaces = spaces;
        this.collected = collected;
        this.mapper = mapper;
    }

    public CompareView compare(long userId, Command command) {
        if (command == null || command.versionA() == null || command.versionB() == null
                || command.versionA().isBlank() || command.versionB().isBlank())
            throw new V2Exception(400, "请选择要对比的两个模型版本", "VALIDATION");
        if (command.versionA().equals(command.versionB()))
            throw new V2Exception(400, "两个模型版本不能相同", "VALIDATION");
        if (command.datasetVersionId() == null)
            throw new V2Exception(400, "请选择用于对比的数据集版本", "VALIDATION");
        int limit = command.limit() == null ? DEFAULT_SAMPLES : command.limit();
        if (limit < 1 || limit > MAX_SAMPLES)
            throw new V2Exception(400, "对比样本数必须在 1.." + MAX_SAMPLES, "VALIDATION");

        Side sideA = side(command.versionA());
        Side sideB = side(command.versionB());
        long versionId = command.datasetVersionId();
        long workspaceId = requireWorkspace(userId, versionId);

        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT s.id, s.label, c.artifact_path
                FROM t_v2_dataset_sample s
                JOIN t_collected_sample c ON c.id = s.sample_id
                WHERE s.version_id = ? AND s.label IS NOT NULL
                ORDER BY s.id LIMIT ?
                """, versionId, limit);
        if (rows.isEmpty())
            throw new V2Exception(400, "该版本没有带标签的样本，无法对比", "NO_SAMPLES");

        List<byte[]> images = new ArrayList<>();
        List<Integer> labels = new ArrayList<>();
        List<String> sampleIds = new ArrayList<>();
        int skipped = 0;
        for (Map<String, Object> row : rows) {
            // 先把要用的值都取齐，再一起入列：否则中途失败会让 images/labels 长度错位
            Integer label = labelOf(row.get("label"));
            Object path = row.get("artifact_path");
            if (label == null || label < 0 || label > 9 || path == null) { skipped++; continue; }
            byte[] bytes;
            try {
                bytes = collected.readArtifact(String.valueOf(path));
            } catch (RuntimeException unreadable) {
                // 单张样本文件缺失/损坏不应让整次对比失败
                LOG.warn("Sample {} unreadable during compare ({})", row.get("id"),
                        unreadable.getClass().getSimpleName());
                skipped++;
                continue;
            }
            if (bytes == null || bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) { skipped++; continue; }
            images.add(bytes);
            labels.add(label);
            sampleIds.add(String.valueOf(row.get("id")));
        }
        if (images.isEmpty())
            throw new V2Exception(400, "样本图片都读不到，无法对比", "NO_SAMPLES");
        if (images.size() != labels.size() || images.size() != sampleIds.size())
            throw new IllegalStateException("compare sample bookkeeping out of sync");

        ModelClient.CompareSide identityA = new ModelClient.CompareSide(
                sideA.externalId(), sideA.version(), sideA.preprocessVersion());
        ModelClient.CompareSide identityB = new ModelClient.CompareSide(
                sideB.externalId(), sideB.version(), sideB.preprocessVersion());
        ModelClient.CompareResult result = client.compare(identityA, identityB, images, labels);

        List<Row> viewRows = new ArrayList<>(result.rows().size());
        for (int index = 0; index < result.rows().size(); index++) {
            ModelClient.CompareRow row = result.rows().get(index);
            viewRows.add(new Row(index, sampleIds.get(index), row.label(), row.digitA(), row.confidenceA(),
                    row.digitB(), row.confidenceB(), row.agree()));
        }
        LOG.info("Model compare {} vs {} on {} samples (workspace {})", command.versionA(),
                command.versionB(), viewRows.size(), workspaceId);
        return new CompareView(sideA, sideB, result.summary(), viewRows, result.processingMs(),
                versionId, skipped);
    }

    /** t_v2_dataset_sample.label 是 VARCHAR：可能是 "7"，也可能是数字类型，统一按字符串解析。 */
    static Integer labelOf(Object value) {
        if (value == null) return null;
        if (value instanceof Number number) return number.intValue();
        try {
            return Integer.valueOf(String.valueOf(value).trim());
        } catch (NumberFormatException invalid) {
            return null;
        }
    }

    /** 数据集版本必须存在，且调用方是该工作空间成员。 */
    private long requireWorkspace(long userId, long versionId) {
        List<Long> owners = jdbc.query("""
                SELECT d.workspace_id FROM t_v2_dataset_version v
                JOIN t_v2_dataset d ON d.id = v.dataset_id
                WHERE v.id = ?
                """, (rs, i) -> rs.getLong(1), versionId);
        if (owners.isEmpty()) throw new V2Exception(404, "数据集版本不存在", "VERSION_NOT_FOUND");
        long workspaceId = owners.get(0);
        spaces.requireMember(workspaceId, userId);
        return workspaceId;
    }

    private Side side(String version) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT id, external_id, version, preprocess_version, status, accuracy, accuracy_dataset,
                       origin, trained_at, task_id, sha256, size_bytes
                FROM t_v2_model WHERE version = ?
                """, version);
        if (rows.isEmpty()) throw new V2Exception(404, "模型版本 " + version + " 未在数据库中登记", "MODEL_NOT_FOUND");
        Map<String, Object> row = rows.get(0);
        boolean inRegistry = false;
        boolean verified = false;
        try {
            for (ModelClient.RegisteredModel entry : client.registry()) {
                if (!version.equals(entry.modelVersion())) continue;
                inRegistry = true;
                verified = entry.verified();
                break;
            }
        } catch (RuntimeException unavailable) {
            // 注册表读不到不影响展示元数据，只是标成"不在注册表"
            LOG.warn("Registry unavailable during compare ({})", unavailable.getClass().getSimpleName());
        }
        return new Side(String.valueOf(row.get("id")), String.valueOf(row.get("version")),
                String.valueOf(row.get("external_id")), String.valueOf(row.get("preprocess_version")),
                String.valueOf(row.get("status")),
                row.get("accuracy") == null ? null : ((Number) row.get("accuracy")).doubleValue(),
                row.get("accuracy_dataset") == null ? null : String.valueOf(row.get("accuracy_dataset")),
                row.get("origin") == null ? null : String.valueOf(row.get("origin")),
                row.get("trained_at") == null ? null : String.valueOf(row.get("trained_at")),
                row.get("sha256") == null ? null : String.valueOf(row.get("sha256")),
                row.get("size_bytes") == null ? null : ((Number) row.get("size_bytes")).longValue(),
                inRegistry, verified, trainingMetrics(row.get("task_id")));
    }

    /** 只取对比需要的少量字段，避免把整份 metrics（含 20 条错误样本）塞进响应。 */
    private JsonNode trainingMetrics(Object taskId) {
        if (taskId == null) return null;
        List<String> metrics = jdbc.query("SELECT metrics FROM t_v2_training_task WHERE id = ?",
                (rs, i) -> rs.getString(1), ((Number) taskId).longValue());
        if (metrics.isEmpty() || metrics.get(0) == null || metrics.get(0).isBlank()) return null;
        try {
            JsonNode root = mapper.readTree(metrics.get(0));
            ObjectNode slim = mapper.createObjectNode();
            if (root.hasNonNull("after")) slim.set("after", root.get("after"));
            for (String key : List.of("bestEpoch", "earlyStopped", "recipe")) {
                if (root.hasNonNull(key)) slim.set(key, root.get(key));
            }
            JsonNode detailed = root.path("detailed");
            if (detailed.isObject()) {
                Map<String, JsonNode> domains = new LinkedHashMap<>();
                detailed.fields().forEachRemaining(entry -> domains.put(entry.getKey(), entry.getValue().path("macro")));
                ObjectNode macro = mapper.createObjectNode();
                domains.forEach(macro::set);
                slim.set("macro", macro);
            }
            return slim;
        } catch (Exception invalid) {
            LOG.warn("Stored training metrics for task {} unreadable ({})", taskId, invalid.getClass().getSimpleName());
            return null;
        }
    }
}
