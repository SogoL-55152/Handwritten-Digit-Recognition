package com.hdr.v2.training;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** 训练任务管理接口（SUPER_ADMIN）。创建即入队，Python worker 通过内部回调推进状态。 */
@RestController
@RequestMapping("/api/v2/admin/training/tasks")
public class TrainingController {
    private static final int MAX_LIMIT = 50;
    private final TrainingService service;

    public TrainingController(TrainingService service) { this.service = service; }

    @GetMapping
    public Result<List<TrainingService.TaskView>> list(@RequestParam(defaultValue = "20") int limit,
                                                       HttpServletRequest request) {
        requireOperator(request);
        if (limit < 1 || limit > MAX_LIMIT) throw new V2Exception(400, "limit 必须在 1.." + MAX_LIMIT, "VALIDATION");
        return Result.ok(service.list(limit));
    }

    @GetMapping("/{id}")
    public Result<TrainingService.TaskView> detail(@PathVariable long id, HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.view(id));
    }

    @PostMapping
    public Result<TrainingService.TaskView> create(@RequestParam(defaultValue = "1") long datasetId,
                                                   @RequestBody(required = false) TrainingService.CreateRequest body,
                                                   HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.create(V2Principal.require(request).userId(), datasetId, body));
    }

    @GetMapping("/datasets")
    public Result<List<Map<String, Object>>> datasets(HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.datasets());
    }

    private void requireOperator(HttpServletRequest request) {
        if (!"SUPER_ADMIN".equals(V2Principal.require(request).platformRole()))
            throw new V2Exception(403, "无平台运营权限", "FORBIDDEN");
    }
}
