package com.hdr.controller;

import com.hdr.auth.RequireAdmin;
import com.hdr.common.PageResult;
import com.hdr.common.Result;
import com.hdr.entity.ModelInfo;
import com.hdr.service.ModelService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/models")
@RequiredArgsConstructor
public class ModelController {

    private final ModelService modelService;

    @GetMapping
    public Result<PageResult<ModelInfo>> page(@RequestParam(defaultValue = "1") long page,
                                              @RequestParam(defaultValue = "10") long size) {
        return Result.ok(modelService.page(page, size));
    }

    @GetMapping("/active")
    public Result<ModelInfo> active() {
        return Result.ok(modelService.activeOrNull());
    }

    @RequireAdmin
    @PostMapping("/{id}/activate")
    public Result<ModelInfo> activate(@PathVariable Long id) {
        return Result.ok(modelService.activate(id));
    }

    @RequireAdmin
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        modelService.delete(id);
        return Result.ok();
    }
}
