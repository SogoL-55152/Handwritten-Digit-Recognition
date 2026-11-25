package com.hdr.v2.model;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 模型版本对比：仅平台运营（SUPER_ADMIN）可用，只读不落库。
 * 与 {@link ModelAdminController} 共用 /api/v2/admin/models 前缀，但路径不重叠（/compare）。
 */
@RestController
@RequestMapping("/api/v2/admin/models")
public class ModelCompareController {
    private final ModelCompareService service;

    public ModelCompareController(ModelCompareService service) {
        this.service = service;
    }

    @PostMapping("/compare")
    public Result<ModelCompareService.CompareView> compare(
            @RequestBody(required = false) ModelCompareService.Command command,
            HttpServletRequest request) {
        V2Principal principal = V2Principal.require(request);
        if (!"SUPER_ADMIN".equals(principal.platformRole()))
            throw new V2Exception(403, "无平台运营权限", "FORBIDDEN");
        if (command == null) throw new V2Exception(400, "缺少对比参数", "VALIDATION");
        return Result.ok(service.compare(principal.userId(), command));
    }
}
