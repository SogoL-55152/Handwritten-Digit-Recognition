package com.hdr.controller;

import com.hdr.auth.RequireAdmin;
import com.hdr.common.PageResult;
import com.hdr.common.Result;
import com.hdr.dto.DatasetRequest;
import com.hdr.entity.Dataset;
import com.hdr.service.DatasetService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/datasets")
@RequiredArgsConstructor
public class DatasetController {

    private final DatasetService datasetService;

    @GetMapping
    public Result<PageResult<Dataset>> page(@RequestParam(defaultValue = "1") long page,
                                            @RequestParam(defaultValue = "10") long size) {
        return Result.ok(datasetService.page(page, size));
    }

    @RequireAdmin
    @PostMapping
    public Result<Dataset> create(@Valid @RequestBody DatasetRequest request) {
        return Result.ok(datasetService.create(request));
    }
}
