package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.collection.CollectedSampleService;
import com.hdr.v2.workspace.WorkspaceService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 数据集版本与样本归属。版本是快照：同一数据集可多版，每版固定样本与 train/val/test 划分。
 * 按书写者哈希划分，保证同一个人的样本不会同时出现在训练和评测里。
 */
@Service
public class DatasetService {
    public record Version(String id, String datasetId, String version, String status, String splitRule,
                          int sampleCount, int writerCount, int valPercent, int testPercent, String createdAt) {}
    public record Sample(String id, String sampleId, String split, String label, String kind,
                         String writer, String createdAt) {}
    public record BuildCommand(String version, String splitRule, Integer valPercent, Integer testPercent,
                               Integer label, String kind) {}

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final CollectedSampleService collected;

    public DatasetService(JdbcTemplate jdbc, WorkspaceService spaces, CollectedSampleService collected) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.collected = collected;
    }

    /** 建数据集（工作空间级）。版本由后续 buildVersion 生成，建集时样本数为 0。 */
    @Transactional
    public Map<String, Object> createDataset(long workspaceId, long userId, String name, String description) {
        spaces.requireMember(workspaceId, userId);
        if (name == null || name.isBlank() || name.length() > 64)
            throw new V2Exception(400, "数据集名称必须为 1–64 个字符", "VALIDATION");
        String text = description == null ? "" : description.trim();
        if (text.length() > 255) throw new V2Exception(400, "描述最多 255 个字符", "VALIDATION");
        Integer duplicated = jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_dataset WHERE workspace_id=? AND name=? AND status='ACTIVE'",
                Integer.class, workspaceId, name.trim());
        if (duplicated != null && duplicated > 0)
            throw new V2Exception(409, "同名数据集已存在", "DATASET_EXISTS");
        jdbc.update("""
                INSERT INTO t_v2_dataset(name, version, scope, workspace_id, train_samples, test_samples, description, status)
                VALUES(?, 'v0', 'WORKSPACE', ?, 0, 0, ?, 'ACTIVE')
                """, name.trim(), workspaceId, text);
        Long id = jdbc.queryForObject("SELECT MAX(id) FROM t_v2_dataset WHERE workspace_id=? AND name=?", Long.class,
                workspaceId, name.trim());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", id == null ? "0" : Long.toString(id));
        body.put("name", name.trim());
        body.put("description", text);
        body.put("workspaceId", Long.toString(workspaceId));
        return body;
    }

    @Transactional
    public Version createVersion(long workspaceId, long userId, long datasetId, BuildCommand command) {
        spaces.requireMember(workspaceId, userId);
        requireDataset(workspaceId, datasetId);
        String version = token(command == null ? null : command.version());
        String splitRule = command.splitRule() == null || command.splitRule().isBlank() ? "WRITER" : command.splitRule();
        if (!"WRITER".equals(splitRule) && !"RANDOM".equals(splitRule))
            throw new V2Exception(400, "划分方式只支持 WRITER 或 RANDOM", "VALIDATION");
        int val = percent(command.valPercent(), 15);
        int test = percent(command.testPercent(), 15);
        if (val + test > 60) throw new V2Exception(400, "验证集与测试集合计不能超过 60%", "VALIDATION");
        Integer existing = jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_dataset_version WHERE dataset_id=? AND version=?",
                Integer.class, datasetId, version);
        if (existing != null && existing > 0) throw new V2Exception(409, "该版本已存在", "DATASET_VERSION_EXISTS");

        List<Map<String, Object>> selected = selectSamples(workspaceId, command);
        if (selected.isEmpty()) throw new V2Exception(400, "没有符合条件的样本，请先在识别页采集", "NO_SAMPLES");
        Set<String> writerKeys = new HashSet<>();
        for (Map<String, Object> row : selected) writerKeys.add(String.valueOf(row.get("creator_id")));
        // 按书写者划分的前提是有足够多的书写者；只有一两个人时划分会退化成单侧
        if ("WRITER".equals(splitRule) && writerKeys.size() < 3)
            throw new V2Exception(400, "当前样本只有 " + writerKeys.size() + " 位书写者，无法按人划分；请改用 RANDOM 或补充更多人的样本",
                    "TOO_FEW_WRITERS");

        long id = insertVersion(datasetId, version, splitRule, val, test, userId);
        Set<String> writers = new HashSet<>();
        for (Map<String, Object> row : selected) {
            long sampleId = ((Number) row.get("id")).longValue();
            String writer = String.valueOf(row.get("creator_id"));
            String split = splitOf(datasetId, sampleId, writer, val, test, splitRule);
            jdbc.update("""
                    INSERT INTO t_v2_dataset_sample(version_id, sample_id, split, label, kind, writer_key)
                    VALUES(?,?,?,?,?,?)
                    """, id, sampleId, split, labelOf(row), String.valueOf(row.get("sample_kind")), writer);
            writers.add(writer);
        }
        jdbc.update("UPDATE t_v2_dataset_version SET status='READY', sample_count=?, writer_count=? WHERE id=?",
                selected.size(), writers.size(), id);
        jdbc.update("UPDATE t_v2_dataset SET train_samples=?, test_samples=? WHERE id=?",
                countSplit(id, "TRAIN"), countSplit(id, "TEST"), datasetId);
        return version(workspaceId, id);
    }

    public List<Version> versions(long workspaceId, long userId, long datasetId) {
        spaces.requireMember(workspaceId, userId);
        requireDataset(workspaceId, datasetId);
        return jdbc.query("SELECT * FROM t_v2_dataset_version WHERE dataset_id=? ORDER BY id DESC",
                (rs, i) -> mapVersion(rs), datasetId);
    }

    public Version version(long workspaceId, long versionId) {
        requireVersion(workspaceId, versionId);
        return jdbc.query("SELECT * FROM t_v2_dataset_version WHERE id=?", (rs, i) -> mapVersion(rs), versionId)
                .stream().findFirst().orElseThrow(() -> new V2Exception(404, "数据集版本不存在"));
    }

    public Map<String, Object> stats(long workspaceId, long versionId) {
        Version version = version(workspaceId, versionId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("version", version);
        body.put("byLabel", pairs("SELECT label, COUNT(*) c FROM t_v2_dataset_sample WHERE version_id=? GROUP BY label ORDER BY label", versionId));
        body.put("bySplit", pairs("SELECT split, COUNT(*) c FROM t_v2_dataset_sample WHERE version_id=? GROUP BY split", versionId));
        body.put("byKind", pairs("SELECT kind, COUNT(*) c FROM t_v2_dataset_sample WHERE version_id=? GROUP BY kind", versionId));
        Integer leaked = jdbc.queryForObject("""
                SELECT COUNT(*) FROM (
                    SELECT writer_key FROM t_v2_dataset_sample WHERE version_id=? GROUP BY writer_key
                    HAVING COUNT(DISTINCT split) > 1
                ) x
                """, Integer.class, versionId);
        body.put("writerLeak", leaked == null ? 0 : leaked);
        return body;
    }

    public List<Sample> samples(long workspaceId, long versionId, int page, int size, String split, Integer label) {
        requireVersion(workspaceId, versionId);
        int safePage = Math.max(1, page);
        int safeSize = Math.min(60, Math.max(1, size));
        String where = "version_id=?";
        List<Object> args = new ArrayList<>();
        args.add(versionId);
        if (split != null && !split.isBlank()) { where += " AND split=?"; args.add(split); }
        if (label != null) { where += " AND label=?"; args.add(String.valueOf(label)); }
        args.add(safeSize);
        args.add((safePage - 1) * safeSize);
        return jdbc.query("SELECT * FROM t_v2_dataset_sample WHERE " + where + " ORDER BY id LIMIT ? OFFSET ?",
                (rs, i) -> new Sample(rs.getString("id"), rs.getString("sample_id"), rs.getString("split"),
                        rs.getString("label"), rs.getString("kind"), rs.getString("writer_key"),
                        rs.getString("created_at")), args.toArray());
    }

    public int count(long versionId) {
        Integer total = jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_dataset_sample WHERE version_id=?",
                Integer.class, versionId);
        return total == null ? 0 : total;
    }

    /** 读取样本原图（采集库相对路径），供前端缩略图。 */
    public byte[] image(long workspaceId, long versionId, long sampleId) {
        requireVersion(workspaceId, versionId);
        List<String> paths = jdbc.query("""
                SELECT c.artifact_path FROM t_v2_dataset_sample s
                JOIN t_collected_sample c ON c.id = s.sample_id
                WHERE s.version_id=? AND s.id=?
                """, (rs, i) -> rs.getString(1), versionId, sampleId);
        if (paths.isEmpty()) throw new V2Exception(404, "样本不存在");
        return collected.readArtifact(paths.get(0));
    }

    // ---------- 内部 ----------

    private List<Map<String, Object>> selectSamples(long workspaceId, BuildCommand command) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT id, creator_id, label, label_text, sample_kind FROM t_collected_sample
                WHERE workspace_id=? AND consent=1 AND (label IS NOT NULL OR label_text IS NOT NULL)
                ORDER BY id
                """, workspaceId);
        List<Map<String, Object>> selected = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            if (command.label() != null) {
                Object label = row.get("label");
                if (label == null || ((Number) label).intValue() != command.label()) continue;
            }
            if (command.kind() != null && !command.kind().isBlank()
                    && !command.kind().equals(String.valueOf(row.get("sample_kind")))) continue;
            selected.add(row);
        }
        return selected;
    }

    private long insertVersion(long datasetId, String version, String splitRule, int val, int test, long userId) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                    INSERT INTO t_v2_dataset_version(dataset_id, version, split_rule, val_percent, test_percent, created_by)
                    VALUES(?,?,?,?,?,?)
                    """, Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, datasetId);
            statement.setString(2, version);
            statement.setString(3, splitRule);
            statement.setInt(4, val);
            statement.setInt(5, test);
            statement.setLong(6, userId);
            return statement;
        }, keys);
        Number id = keys.getKey();
        if (id == null) throw new IllegalStateException("version id not generated");
        return id.longValue();
    }

    /** WRITER 按书写者哈希（同一个人只会落在一个划分）；RANDOM 按样本哈希（用于对比）。 */
    private String splitOf(long datasetId, long sampleId, String writer, int val, int test, String rule) {
        String seed = rule.equals("RANDOM") ? sampleId + ":" + datasetId : writer + ":" + datasetId;
        int bucket = Math.floorMod(seed.hashCode(), 100);
        if (bucket < test) return "TEST";
        if (bucket < test + val) return "VAL";
        return "TRAIN";
    }

    private String labelOf(Map<String, Object> row) {
        Object text = row.get("label_text");
        if (text != null && !String.valueOf(text).isBlank()) return String.valueOf(text);
        return String.valueOf(row.get("label"));
    }

    private int countSplit(long versionId, String split) {
        Integer value = jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_dataset_sample WHERE version_id=? AND split=?",
                Integer.class, versionId, split);
        return value == null ? 0 : value;
    }

    private List<Map<String, Object>> pairs(String sql, long versionId) {
        return jdbc.query(sql, (rs, i) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", rs.getString(1));
            row.put("count", rs.getInt(2));
            return row;
        }, versionId);
    }

    private Version mapVersion(java.sql.ResultSet rs) {
        try {
            return new Version(rs.getString("id"), rs.getString("dataset_id"), rs.getString("version"),
                    rs.getString("status"), rs.getString("split_rule"), rs.getInt("sample_count"),
                    rs.getInt("writer_count"), rs.getInt("val_percent"), rs.getInt("test_percent"),
                    rs.getTimestamp("created_at").toInstant().toString());
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    private void requireDataset(long workspaceId, long datasetId) {
        Integer found = jdbc.queryForObject("""
                SELECT COUNT(*) FROM t_v2_dataset
                WHERE id=? AND (scope='PUBLIC' OR (scope='WORKSPACE' AND workspace_id=?))
                """, Integer.class, datasetId, workspaceId);
        if (found == null || found == 0) throw new V2Exception(404, "数据集不存在");
    }

    private void requireVersion(long workspaceId, long versionId) {
        Integer found = jdbc.queryForObject("""
                SELECT COUNT(*) FROM t_v2_dataset_version v JOIN t_v2_dataset d ON d.id = v.dataset_id
                WHERE v.id=? AND (d.scope='PUBLIC' OR (d.scope='WORKSPACE' AND d.workspace_id=?))
                """, Integer.class, versionId, workspaceId);
        if (found == null || found == 0) throw new V2Exception(404, "数据集版本不存在");
    }

    private static int percent(Integer value, int fallback) {
        int percent = value == null ? fallback : value;
        if (percent < 0 || percent > 50) throw new V2Exception(400, "划分比例必须在 0–50 之间", "VALIDATION");
        return percent;
    }

    private static String token(String value) {
        if (value == null || value.isBlank() || value.length() > 16 || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]*"))
            throw new V2Exception(400, "字段 version 格式无效", "VALIDATION");
        return value;
    }
}
