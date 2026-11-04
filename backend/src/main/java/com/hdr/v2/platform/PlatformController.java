package com.hdr.v2.platform;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/v2")
public class PlatformController {
    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final W2Limits limits;
    private final ModelClient model;
    public PlatformController(JdbcTemplate jdbc,WorkspaceService spaces,W2Limits limits,ModelClient model) {
        this.jdbc=jdbc; this.spaces=spaces; this.limits=limits; this.model=model;
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
    @GetMapping("/platform/health-summary")
    public Result<Map<String,Object>> health(HttpServletRequest request) {
        requireOperator(request);
        var services=new ArrayList<Map<String,Object>>();
        try { jdbc.queryForObject("SELECT 1",Integer.class); services.add(Map.of("name","mysql","status","UP","detail","数据库可查询")); }
        catch(Exception error) { services.add(Map.of("name","mysql","status","DOWN","detail","数据库不可用")); }
        try { services.add(model.ready()); }
        catch(Exception error) { services.add(Map.of("name","model-service","status","DOWN","detail","模型未配置或未就绪")); }
        services.add(Map.of("name","training-worker","status","NOT_CONFIGURED","detail","W2尚未启用在线训练"));
        services.add(Map.of("name","redis","status","NOT_CONFIGURED","detail","W2限流使用MySQL"));
        return Result.ok(Map.of("checkedAt",Instant.now().toString(),"services",services));
    }
    private void requireOperator(HttpServletRequest request) {
        if(!"SUPER_ADMIN".equals(V2Principal.require(request).platformRole())) throw new V2Exception(403,"无平台运营权限");
    }
    private long count(Object value) { return value instanceof Number n ? n.longValue() : 0L; }
}
