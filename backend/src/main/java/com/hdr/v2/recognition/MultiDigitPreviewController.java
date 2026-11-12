package com.hdr.v2.recognition;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 多位数字**预览**：切分 + 逐字识别，直接返回结果。
 * 明确不写数据库、不做幂等、不计入统计——用于验证多位数体验与准确率，不替代正式契约。
 */
@RestController
@RequestMapping("/api/v2/workspaces/{workspaceId}/recognitions")
public class MultiDigitPreviewController {
    private final ModelClient client;
    private final CatalogueService catalogue;
    private final WorkspaceService spaces;
    private final ImageValidator images;
    private final RateLimiter limiter;

    public MultiDigitPreviewController(ModelClient client, CatalogueService catalogue, WorkspaceService spaces,
                                       ImageValidator images, RateLimiter limiter) {
        this.client = client; this.catalogue = catalogue; this.spaces = spaces;
        this.images = images; this.limiter = limiter;
    }

    @PostMapping(value = "/multi-preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> preview(@PathVariable long workspaceId,
                                               @RequestPart("image") MultipartFile image,
                                               @RequestParam(defaultValue = "3") int maxDigits,
                                               HttpServletRequest request) {
        long user = V2Principal.require(request).userId();
        spaces.requireMember(workspaceId, user);
        if (maxDigits < 1 || maxDigits > 4) throw new V2Exception(400, "maxDigits 必须是 1–4", "VALIDATION");
        limiter.check("multi-preview:user:" + user, 30, 60);
        String requestId = java.util.UUID.randomUUID().toString();
        CatalogueService.Model model = catalogue.defaultModel(workspaceId);
        ModelClient.MultiPrediction prediction = client.predictMulti(workspaceId, requestId, model,
                images.validate(image), maxDigits);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("preview", true);
        body.put("text", prediction.text());
        body.put("accepted", prediction.accepted());
        body.put("maxDigits", prediction.maxDigits());
        body.put("requestId", requestId);
        body.put("modelId", model.externalId());
        body.put("modelVersion", model.version());
        body.put("digits", prediction.digits().stream().map(item -> Map.of(
                "digit", item.digit(), "confidence", item.confidence(),
                "margin", item.margin(), "left", item.left(), "right", item.right())).toList());
        return Result.ok(body);
    }
}
