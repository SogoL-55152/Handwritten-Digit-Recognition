package com.hdr.controller;

import com.hdr.auth.RequireAdmin;
import com.hdr.auth.UserContext;
import com.hdr.common.PageResult;
import com.hdr.common.Result;
import com.hdr.dto.TrainTaskRequest;
import com.hdr.entity.TrainTask;
import com.hdr.service.TrainTaskService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/train-tasks")
@RequiredArgsConstructor
public class TrainTaskController {

    private final TrainTaskService trainTaskService;

    @RequireAdmin
    @PostMapping
    public Result<TrainTask> create(@Valid @RequestBody TrainTaskRequest request) {
        return Result.ok(trainTaskService.create(request, UserContext.require().id()));
    }

    @GetMapping
    public Result<PageResult<TrainTask>> page(@RequestParam(defaultValue = "1") long page,
                                             @RequestParam(defaultValue = "10") long size) {
        return Result.ok(trainTaskService.page(page, size));
    }

    @GetMapping("/{id}")
    public Result<TrainTask> get(@PathVariable Long id) {
        return Result.ok(trainTaskService.get(id));
    }

    @GetMapping("/{id}/metrics")
    public Result<Map<String, Object>> metrics(@PathVariable Long id) {
        return Result.ok(trainTaskService.metrics(id));
    }
}
