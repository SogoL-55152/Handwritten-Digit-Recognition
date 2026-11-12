package com.hdr.v2.collection;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.recognition.ImageValidator;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 用户自报"我写的是几"并同意后采集原图。
 * 标签由用户自己给出，不依赖模型预测；未同意一律不保存。
 */
@RestController
@RequestMapping("/api/v2")
public class CollectedSampleController {
    private final CollectedSampleService samples;
    private final ImageValidator images;
    private final RateLimiter limiter;

    public CollectedSampleController(CollectedSampleService samples, ImageValidator images, RateLimiter limiter) {
        this.samples = samples;
        this.images = images;
        this.limiter = limiter;
    }

    @PostMapping(value = "/workspaces/{workspaceId}/collected-samples", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> submit(@PathVariable long workspaceId,
                                              @RequestParam("image") MultipartFile file,
                                              @RequestParam("label") Integer label,
                                              @RequestParam(value = "consent", defaultValue = "false") boolean consent,
                                              @RequestParam(value = "predictedDigit", required = false) Integer predictedDigit,
                                              @RequestParam(value = "confidence", required = false) Double confidence,
                                              @RequestParam(value = "modelVersion", required = false) String modelVersion,
                                              @RequestParam(value = "recognitionId", required = false) Long recognitionId,
                                              @RequestParam(value = "source", defaultValue = "WEB") String source,
                                              HttpServletRequest request) {
        V2Principal principal = V2Principal.require(request);
        if (!consent) throw new V2Exception(400, "未同意采集时不会保存图片", "CONSENT_REQUIRED");
        if (label == null || label < 0 || label > 9) throw new V2Exception(400, "标签必须是 0–9", "VALIDATION");
        if (confidence != null && (!Double.isFinite(confidence) || confidence < 0 || confidence > 1))
            throw new V2Exception(400, "置信度必须在 0–1", "VALIDATION");
        limiter.check("collected:user:" + principal.userId(), 60, 60);
        ImageValidator.Image image = images.validate(file);
        CollectedSampleService.Saved saved = samples.save(workspaceId, principal.userId(), label, true, image,
                predictedDigit, confidence, modelVersion, recognitionId, source);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", Long.toString(saved.id()));
        body.put("duplicate", saved.duplicate());
        body.put("contributedTotal", saved.contributedTotal());
        return Result.ok(body);
    }

    /** 本人贡献统计（不暴露他人采集内容）。 */
    @GetMapping("/workspaces/{workspaceId}/collected-samples/summary")
    public Result<Map<String, Object>> summary(@PathVariable long workspaceId, HttpServletRequest request) {
        V2Principal principal = V2Principal.require(request);
        Map<String, Object> data = new LinkedHashMap<>(samples.summary(principal.userId()));
        data.put("workspaceId", Long.toString(workspaceId));
        return Result.ok(data);
    }
}
