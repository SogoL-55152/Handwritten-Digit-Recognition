package com.hdr.v2.model;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.recognition.ModelClient;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;
import java.util.List;
import java.util.Map;

/**
 * 模型管理接口：仅平台运营（SUPER_ADMIN）可用。
 * 注册与激活都要求模型服务本地注册表已通过摘要校验，避免"数据库说有、文件不对"。
 */
@RestController
@RequestMapping("/api/v2/admin/models")
public class ModelAdminController {
    private final ModelAdminService service;
    private final ModelClient client;
    public ModelAdminController(ModelAdminService service,ModelClient client) {
        this.service=service; this.client=client;
    }
    @GetMapping
    public Result<List<ModelAdminService.ModelView>> list(HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.list());
    }
    @PostMapping("/register")
    public Result<ModelAdminService.ModelView> register(@RequestBody(required=false) ModelAdminService.RegisterCommand command,
                                                        HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.register(command));
    }
    @PostMapping("/{id}/activate")
    public Result<ModelAdminService.ModelView> activate(@PathVariable long id,HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.activate(id));
    }
    @PostMapping("/{id}/disable")
    public Result<ModelAdminService.ModelView> disable(@PathVariable long id,HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(service.disable(id));
    }
    @DeleteMapping("/{id}")
    public Result<Map<String,Object>> delete(@PathVariable long id,HttpServletRequest request) {
        requireOperator(request);
        service.delete(id);
        return Result.ok(Map.of("deleted",Long.toString(id)));
    }
    /** 让模型服务重新读取 registry.json（管理员新增模型文件后使用）。 */
    @PostMapping("/registry/reload")
    public Result<List<ModelClient.RegisteredModel>> reload(HttpServletRequest request) {
        requireOperator(request);
        return Result.ok(client.reloadRegistry());
    }
    private void requireOperator(HttpServletRequest request) {
        if(!"SUPER_ADMIN".equals(V2Principal.require(request).platformRole()))
            throw new V2Exception(403,"无平台运营权限","FORBIDDEN");
    }
}
