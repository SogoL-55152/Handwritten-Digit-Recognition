package com.hdr.controller;

import com.hdr.common.Result;
import com.hdr.service.StatsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/stats")
@RequiredArgsConstructor
public class StatsController {

    private final StatsService statsService;

    @GetMapping("/overview")
    public Result<Map<String, Object>> overview() {
        return Result.ok(statsService.overview());
    }

    @GetMapping("/call-trend")
    public Result<List<Map<String, Object>>> callTrend() {
        return Result.ok(statsService.callTrend());
    }

    @GetMapping("/model-usage")
    public Result<List<Map<String, Object>>> modelUsage() {
        return Result.ok(statsService.modelUsage());
    }
}
