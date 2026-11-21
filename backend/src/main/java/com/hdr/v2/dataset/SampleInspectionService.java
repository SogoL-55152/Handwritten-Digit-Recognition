package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.collection.CollectedSampleService;
import com.hdr.v2.recognition.ImageValidator;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 样本巡检：对已导入样本跑一次「单字切分检测」，把疑似多位数标记出来。
 * 只标记不删除，交给用户在样本网格里确认后删除（避免误删）。
 */
@Service
public class SampleInspectionService {
    private static final Logger LOG = LoggerFactory.getLogger(SampleInspectionService.class);
    private static final int MAX_BATCH = 200;

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final CollectedSampleService samples;
    private final ModelClient models;
    private final CatalogueService catalogue;

    public SampleInspectionService(JdbcTemplate jdbc, WorkspaceService spaces, CollectedSampleService samples,
                                   ModelClient models, CatalogueService catalogue) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.samples = samples;
        this.models = models;
        this.catalogue = catalogue;
    }

    /** 每次最多巡检 limit 张；返回本轮结果与剩余未巡检数量，前端可反复点继续。 */
    public Map<String, Object> inspect(long workspaceId, long userId, long datasetId, int limit) {
        spaces.requireMember(workspaceId, userId);
        requireOwnDataset(workspaceId, datasetId);
        int batch = Math.min(MAX_BATCH, Math.max(1, limit));
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT id, artifact_path FROM t_collected_sample
                WHERE source_dataset_id=? AND multi_digit IS NULL AND artifact_path IS NOT NULL
                ORDER BY id LIMIT ?
                """, datasetId, batch);
        int checked = 0;
        int multi = 0;
        int failed = 0;
        CatalogueService.Model model;
        try {
            model = catalogue.activeModel();
        } catch (RuntimeException error) {
            throw new V2Exception(503, "当前没有生效模型，无法巡检", "MODEL_UNAVAILABLE");
        }
        for (Map<String, Object> row : rows) {
            long sampleId = ((Number) row.get("id")).longValue();
            String path = String.valueOf(row.get("artifact_path"));
            try {
                byte[] bytes = samples.readArtifact(path);
                String type = path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                String digest = SampleInspectionService.sha256(bytes);
                ModelClient.MultiPrediction prediction = models.predictMulti(workspaceId,
                        java.util.UUID.randomUUID().toString(), model,
                        new ImageValidator.Image(bytes, digest, type), 2, true);
                boolean isMulti = prediction.digits() != null && prediction.digits().size() > 1;
                jdbc.update("UPDATE t_collected_sample SET multi_digit=? WHERE id=?", isMulti ? 1 : 0, sampleId);
                checked += 1;
                if (isMulti) multi += 1;
            } catch (Exception error) {
                // 拒识（单字也常被拒）与网络失败都不标记，避免误伤
                failed += 1;
            }
        }
        Long remaining = jdbc.queryForObject("""
                SELECT COUNT(*) FROM t_collected_sample
                WHERE source_dataset_id=? AND multi_digit IS NULL AND artifact_path IS NOT NULL
                """, Long.class, datasetId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("checked", checked);
        body.put("multi", multi);
        body.put("failed", failed);
        body.put("remaining", remaining == null ? 0 : remaining);
        body.put("flagged", jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_collected_sample WHERE source_dataset_id=? AND multi_digit=1",
                Long.class, datasetId));
        LOG.info("巡检数据集 {}: 检查 {} 张，多位数 {} 张，失败 {} 张，剩余 {}", datasetId, checked, multi, failed, remaining);
        return body;
    }

    private void requireOwnDataset(long workspaceId, long datasetId) {
        List<Map<String, Object>> found = jdbc.queryForList(
                "SELECT scope, workspace_id FROM t_v2_dataset WHERE id=?", datasetId);
        if (found.isEmpty()) throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
        Map<String, Object> row = found.get(0);
        if ("PUBLIC".equals(row.get("scope")))
            throw new V2Exception(409, "公共数据集只读，不能巡检", "DATASET_PUBLIC");
        Object owner = row.get("workspace_id");
        if (owner == null || ((Number) owner).longValue() != workspaceId)
            throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
    }

    private static String sha256(byte[] bytes) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            StringBuilder builder = new StringBuilder();
            for (byte value : digest.digest(bytes)) builder.append(String.format("%02x", value));
            return builder.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
