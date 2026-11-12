package com.hdr.v2.platform;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/v2")
public class PlatformController {
    private static final String WORKER_HEARTBEAT = "training:worker:heartbeat";
    private static final String TRAINING_QUEUE = "training";
    private static final String ACTIVE_SET = "training:active";

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final W2Limits limits;
    private final ModelClient model;
    private final StringRedisTemplate redis;

    public PlatformController(JdbcTemplate jdbc, WorkspaceService spaces, W2Limits limits, ModelClient model,
                              StringRedisTemplate redis) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.limits = limits;
        this.model = model;
        this.redis = redis;
    }

    @GetMapping("/workspaces/{workspaceId}/usage")
    public Result<Map<String,Object>> usage(@PathVariable long workspaceId,HttpServletRequest request) {
        long user=V2Principal.require(request).userId(); spaces.requireMember(workspaceId,user);
        var counts=jdbc.queryForMap("SELECT COUNT(*) AS total,SUM(status='SUCCEEDED') AS success,SUM(status='FAILED') AS failed FROM t_recognition_v2 WHERE workspace_id=? AND creator_id=?",workspaceId,user);
        Map<String,Object> data=new LinkedHashMap<>();
        data.put("workspaceId",Long.toString(workspaceId)); data.put("scope","SELF");
        data.put("totalRequests",count(counts.get("total"))); data.put("successfulRequests",count(counts.get("success"))); data.put("failedRequests",count(counts.get("failed")));
        data.put("limits",limits.view()); return Result.ok(data);
    }

    @GetMapping("/platform/quotas")
    public Result<Map<String,Object>> quotas(HttpServletRequest request) {
        requireOperator(request);
        var data=limits.view(); data.put("source","configuration"); data.put("restartRequired",true);
        return Result.ok(data);
    }

    /** 平台状态：每一项都是现场探测，不再写死占位值。 */
    @GetMapping("/platform/health-summary")
    public Result<Map<String,Object>> health(HttpServletRequest request) {
        requireOperator(request);
        var services = new ArrayList<Map<String,Object>>();
        services.add(mysqlStatus());
        services.add(modelStatus());
        services.add(redisStatus());
        services.add(workerStatus());
        return Result.ok(Map.of("checkedAt", Instant.now().toString(), "services", services));
    }

    private Map<String,Object> mysqlStatus() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            Long workspaces = jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace", Long.class);
            return Map.of("name", "mysql", "status", "UP",
                    "detail", "数据库可查询 · 工作空间 " + (workspaces == null ? 0 : workspaces) + " 个");
        } catch (Exception error) {
            return Map.of("name", "mysql", "status", "DOWN", "detail", "数据库不可用");
        }
    }

    private Map<String,Object> modelStatus() {
        try {
            Map<String,Object> ready = model.ready();
            boolean up = "UP".equals(ready.get("status"));
            return Map.of("name", "model-service", "status", up ? "UP" : "DOWN",
                    "detail", String.valueOf(ready.get("detail")));
        } catch (Exception error) {
            return Map.of("name", "model-service", "status", "DOWN", "detail", "模型服务不可达");
        }
    }

    private Map<String,Object> redisStatus() {
        try {
            String pong = redis.execute((org.springframework.data.redis.core.RedisCallback<String>)
                    connection -> connection.ping());
            if (!"PONG".equalsIgnoreCase(pong)) throw new IllegalStateException("unexpected reply");
            return Map.of("name", "redis", "status", "UP", "detail", "PING 正常 · 训练队列使用中");
        } catch (Exception error) {
            return Map.of("name", "redis", "status", "DOWN", "detail", "无法连接 Redis（训练队列不可用）");
        }
    }

    private Map<String,Object> workerStatus() {
        try {
            boolean alive = Boolean.TRUE.equals(redis.hasKey(WORKER_HEARTBEAT));
            if (!alive) {
                return Map.of("name", "training-worker", "status", "DOWN",
                        "detail", "训练 worker 心跳已超过 15 秒未刷新");
            }
            Long queued = redis.opsForList().size(TRAINING_QUEUE);
            Long active = redis.opsForSet().size(ACTIVE_SET);
            return Map.of("name", "training-worker", "status", "UP",
                    "detail", "心跳正常 · 排队 " + (queued == null ? 0 : queued)
                            + " 个 · 运行中 " + (active == null ? 0 : active) + " 个");
        } catch (Exception error) {
            return Map.of("name", "training-worker", "status", "UNKNOWN", "detail", "无法读取 worker 心跳");
        }
    }

    private void requireOperator(HttpServletRequest request) {
        if(!"SUPER_ADMIN".equals(V2Principal.require(request).platformRole())) throw new V2Exception(403,"无平台运营权限");
    }
    private long count(Object value) { return value instanceof Number n ? n.longValue() : 0L; }
}
