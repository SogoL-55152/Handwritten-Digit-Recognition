package com.hdr.v2.statistics;

import com.hdr.v2.V2Exception;
import com.hdr.v2.workspace.WorkspaceService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 统计只反映系统实际记录到的数据。生产请求没有人工标注，因此不输出"准确率"，
 * 只输出调用量、返回结果数、拒识数、失败数、时延与模型分布；准确率以离线评测报告为准。
 */
@Service
public class StatisticsService {
    public static final String ACCURACY_NOTE =
            "生产请求没有人工标注，本统计不给准确率；准确率请参考离线评测报告（docs/ 下的评估记录）。";
    private static final int MAX_DAYS = 90;
    private static final RowMapper<DayPoint> DAY = (rs, index) ->
            new DayPoint(rs.getDate("day").toLocalDate().toString(), rs.getLong("total"), rs.getLong("accepted"),
                    rs.getLong("declined"), rs.getLong("failed"));
    private static final RowMapper<ModelUsage> MODEL = (rs, index) ->
            new ModelUsage(rs.getString("model_version"), rs.getLong("total"), rs.getLong("accepted"));

    public record DayPoint(String date, long total, long accepted, long declined, long failed) {}
    public record ModelUsage(String modelVersion, long total, long accepted) {}
    public record SpaceStatistics(long workspaceId, int days, long total, long accepted, long declined, long failed,
                                  double averageProcessingMs, List<DayPoint> daily, List<ModelUsage> models,
                                  String note) {}
    public record RecentRecognition(String id, String status, Integer digit, String resultText,
                                    Boolean accepted, Double confidence, String failureCode, Long processingMs,
                                    String modelVersion, String source, String createdAt, String workspaceId) {}
    public record PlatformStatistics(int days, long workspaces, long users, long total, long accepted, long declined,
                                     long failed, double averageProcessingMs, List<DayPoint> daily,
                                     List<ModelUsage> models, long trainingTotal, long trainingSucceeded,
                                     long trainingFailed, String note) {}

    private static final RowMapper<RecentRecognition> RECENT = (rs, index) -> new RecentRecognition(
            rs.getString("id"), rs.getString("status"),
            rs.getObject("digit") == null ? null : rs.getInt("digit"),
            rs.getString("result_text"),
            rs.getObject("accepted") == null ? null : rs.getInt("accepted") == 1,
            rs.getObject("confidence") == null ? null : rs.getDouble("confidence"),
            rs.getString("failure_code"),
            rs.getObject("processing_ms") == null ? null : rs.getLong("processing_ms"),
            rs.getString("model_version"), rs.getString("source"),
            Instant.ofEpochMilli(rs.getTimestamp("created_at").getTime()).toString(),
            rs.getString("workspace_id"));
    private static final String RECENT_COLUMNS = """
            SELECT id,status,digit,result_text,accepted,confidence,failure_code,processing_ms,model_version,source,
                   created_at,workspace_id
            FROM t_recognition_v2
            """;
    private static final String TOTALS = """
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(status='SUCCEEDED' AND accepted=1),0) AS accepted,
                   COALESCE(SUM(failure_code='UNRECOGNIZED_INPUT'),0) AS declined,
                   COALESCE(SUM(status='FAILED' AND (failure_code IS NULL OR failure_code<>'UNRECOGNIZED_INPUT')),0) AS failed,
                   COALESCE(AVG(processing_ms),0) AS average_ms
            FROM t_recognition_v2 WHERE created_at >= NOW() - INTERVAL ? DAY
            """;
    private static final String DAILY = """
            SELECT DATE(created_at) AS day, COUNT(*) AS total,
                   COALESCE(SUM(status='SUCCEEDED' AND accepted=1),0) AS accepted,
                   COALESCE(SUM(failure_code='UNRECOGNIZED_INPUT'),0) AS declined,
                   COALESCE(SUM(status='FAILED' AND (failure_code IS NULL OR failure_code<>'UNRECOGNIZED_INPUT')),0) AS failed
            FROM t_recognition_v2 WHERE created_at >= NOW() - INTERVAL ? DAY
            """;
    private static final String MODEL_USAGE = """
            SELECT model_version, COUNT(*) AS total, COALESCE(SUM(status='SUCCEEDED' AND accepted=1),0) AS accepted
            FROM t_recognition_v2 WHERE created_at >= NOW() - INTERVAL ? DAY
            """;

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;

    public StatisticsService(JdbcTemplate jdbc, WorkspaceService spaces) {
        this.jdbc = jdbc;
        this.spaces = spaces;
    }

    public SpaceStatistics forSpace(long workspaceId, long userId, int days) {
        spaces.requireMember(workspaceId, userId);
        int window = validatedDays(days);
        Map<String, Object> totals = jdbc.queryForMap(TOTALS + " AND workspace_id=?", window, workspaceId);
        return new SpaceStatistics(workspaceId, window, number(totals, "total"), number(totals, "accepted"),
                number(totals, "declined"), number(totals, "failed"), decimal(totals, "average_ms"),
                daily(window, workspaceId), models(window, workspaceId), ACCURACY_NOTE);
    }

    public PlatformStatistics platform(int days) {
        int window = validatedDays(days);
        Map<String, Object> totals = jdbc.queryForMap(TOTALS, window);
        Map<String, Object> training = jdbc.queryForMap("""
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(status='SUCCEEDED'),0) AS succeeded,
                       COALESCE(SUM(status='FAILED'),0) AS failed
                FROM t_v2_training_task WHERE queued_at >= NOW() - INTERVAL ? DAY
                """, window);
        return new PlatformStatistics(window, count("SELECT COUNT(*) FROM t_workspace"),
                count("SELECT COUNT(*) FROM t_user"), number(totals, "total"), number(totals, "accepted"),
                number(totals, "declined"), number(totals, "failed"), decimal(totals, "average_ms"),
                daily(window, null), models(window, null), number(training, "total"),
                number(training, "succeeded"), number(training, "failed"), ACCURACY_NOTE);
    }

    /** 最近识别记录：空间范围只返回本人，避免把其他成员的明细暴露给普通成员。 */
    public List<RecentRecognition> recentForUser(long workspaceId, long userId, int limit) {
        spaces.requireMember(workspaceId, userId);
        return jdbc.query(RECENT_COLUMNS + " WHERE workspace_id=? AND creator_id=? ORDER BY id DESC LIMIT ?",
                RECENT, workspaceId, userId, validatedLimit(limit));
    }

    public List<RecentRecognition> recentPlatform(int limit) {
        return jdbc.query(RECENT_COLUMNS + " ORDER BY id DESC LIMIT ?", RECENT, validatedLimit(limit));
    }

    /** 逐日补齐缺失日期，前端曲线不会因为"某天没有请求"而断开。 */
    private List<DayPoint> daily(int days, Long workspaceId) {
        List<DayPoint> rows = workspaceId == null
                ? jdbc.query(DAILY + " GROUP BY DATE(created_at) ORDER BY day", DAY, days)
                : jdbc.query(DAILY + " AND workspace_id=? GROUP BY DATE(created_at) ORDER BY day", DAY, days, workspaceId);
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        List<DayPoint> complete = new ArrayList<>(days);
        for (int offset = days - 1; offset >= 0; offset--) {
            String key = today.minusDays(offset).toString();
            DayPoint match = null;
            for (DayPoint row : rows) if (key.equals(row.date())) { match = row; break; }
            complete.add(match == null ? new DayPoint(key, 0, 0, 0, 0) : match);
        }
        return complete;
    }

    private List<ModelUsage> models(int days, Long workspaceId) {
        return workspaceId == null
                ? jdbc.query(MODEL_USAGE + " GROUP BY model_version ORDER BY total DESC LIMIT 20", MODEL, days)
                : jdbc.query(MODEL_USAGE + " AND workspace_id=? GROUP BY model_version ORDER BY total DESC LIMIT 20",
                MODEL, days, workspaceId);
    }

    private long count(String sql) {
        Long value = jdbc.queryForObject(sql, Long.class);
        return value == null ? 0 : value;
    }

    private static int validatedLimit(int limit) {
        if (limit < 1 || limit > 50) throw new V2Exception(400, "limit 必须在 1..50", "VALIDATION");
        return limit;
    }

    private static int validatedDays(int days) {
        if (days < 1 || days > MAX_DAYS) throw new V2Exception(400, "days 必须在 1.." + MAX_DAYS, "VALIDATION");
        return days;
    }

    private static long number(Map<String, Object> row, String key) {
        Object value = row.get(key);
        return value instanceof Number number ? number.longValue() : 0;
    }

    private static double decimal(Map<String, Object> row, String key) {
        Object value = row.get(key);
        return value instanceof Number number ? Math.round(number.doubleValue() * 10) / 10.0 : 0;
    }
}
