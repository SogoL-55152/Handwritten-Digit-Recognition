package com.hdr.v2.training;

import com.hdr.common.Result;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
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
    private final TrainingEventBus events;
    private final org.springframework.data.redis.core.StringRedisTemplate redis;

    public TrainingController(TrainingService service, TrainingEventBus events,
                              org.springframework.data.redis.core.StringRedisTemplate redis) {
        this.service = service;
        this.events = events;
        this.redis = redis;
    }

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

    /** 事件流不能带 Authorization 头，先换一张单次票据。 */
    @PostMapping("/events/ticket")
    public Result<Map<String, Object>> ticket(HttpServletRequest request) {
        requireOperator(request);
        String ticket = events.issueTicket(V2Principal.require(request).userId());
        return Result.ok(Map.of("ticket", ticket, "expiresInSeconds", 120));
    }

    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(required = false) String ticket) {
        return events.subscribe(events.consumeTicket(ticket));
    }

    /** 训练日志：worker 写入 Redis 环形缓冲（training:log:<id>），最多 2000 行。 */
    @GetMapping("/{id}/logs")
    public Result<Map<String, Object>> logs(@PathVariable long id, HttpServletRequest request) {
        requireOperator(request);
        service.view(id);
        List<String> lines;
        try {
            lines = redis.opsForList().range("training:log:" + id, 0, -1);
        } catch (RuntimeException error) {
            lines = List.of();
        }
        return Result.ok(Map.of("lines", lines == null ? List.of() : lines));
    }

    private void requireOperator(HttpServletRequest request) {
        if (!"SUPER_ADMIN".equals(V2Principal.require(request).platformRole()))
            throw new V2Exception(403, "无平台运营权限", "FORBIDDEN");
    }
}
