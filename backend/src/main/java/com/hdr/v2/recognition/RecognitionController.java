package com.hdr.v2.recognition;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.MultipartHttpServletRequest;

@RestController
@RequestMapping("/api/v2/workspaces/{workspaceId}/recognitions")
public class RecognitionController {
    private final RecognitionService service;
    private final WorkspaceService spaces;
    private final ImageValidator images;
    private final RateLimiter limiter;
    public RecognitionController(RecognitionService service,WorkspaceService spaces,ImageValidator images,RateLimiter limiter) {
        this.service=service; this.spaces=spaces; this.images=images; this.limiter=limiter;
    }
    @GetMapping("/request-id")
    public org.springframework.http.ResponseEntity<Result<java.util.Map<String,String>>> requestId(
            @PathVariable long workspaceId,HttpServletRequest request) {
        long user=V2Principal.require(request).userId();
        spaces.requireMember(workspaceId,user);
        limiter.check("request-id:global",240,60);
        limiter.check("request-id:user:"+user,60,60);
        return org.springframework.http.ResponseEntity.ok().header("Cache-Control","no-store")
                .body(Result.ok(java.util.Map.of("requestId",java.util.UUID.randomUUID().toString())));
    }
    @PostMapping(consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<RecognitionService.Recognition> predict(@PathVariable long workspaceId,
            @RequestPart("image") MultipartFile image,@RequestParam String source,
            @RequestHeader("Idempotency-Key") String requestId,HttpServletRequest request) {
        long user=V2Principal.require(request).userId();
        spaces.requireMember(workspaceId,user);
        if(request.getQueryString()!=null || !(request instanceof MultipartHttpServletRequest multipart)
                || multipart.getMultiFileMap().size()!=1 || multipart.getFiles("image").size()!=1
                || request.getParameterMap().size()!=1 || request.getParameterValues("source").length!=1
                || java.util.Collections.list(request.getHeaders("Idempotency-Key")).size()!=1)
            throw new V2Exception(400,"图片与来源必须各提供一次，不能附带其他字段","VALIDATION");
        RecognitionService.validateRequest(requestId,source);
        return Result.ok(service.predict(workspaceId,user,requestId.toLowerCase(java.util.Locale.ROOT),source,images.validate(image)));
    }
    @PostMapping(value = "/multi", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<RecognitionService.MultiResult> multi(@PathVariable long workspaceId,
            @RequestPart("image") MultipartFile image,
            @RequestParam(defaultValue = "3") int maxDigits,
            @RequestParam(defaultValue = "WEB") String source,
            @RequestHeader("Idempotency-Key") String requestId, HttpServletRequest request) {
        long user = V2Principal.require(request).userId();
        spaces.requireMember(workspaceId, user);
        RecognitionService.validateRequest(requestId, source);
        return Result.ok(service.predictMulti(workspaceId, user, requestId.toLowerCase(java.util.Locale.ROOT),
                source, maxDigits, images.validate(image)));
    }

    @GetMapping("/{id}/detail")
    public Result<RecognitionService.Detail> detail(@PathVariable long workspaceId,@PathVariable long id,
            jakarta.servlet.http.HttpServletRequest request) {
        return Result.ok(service.detail(workspaceId,V2Principal.require(request).userId(),id));
    }

    @GetMapping("/{id}/image")
    public org.springframework.http.ResponseEntity<byte[]> image(@PathVariable long workspaceId,@PathVariable long id,
            jakarta.servlet.http.HttpServletRequest request) {
        RecognitionService.StoredImage stored=service.image(workspaceId,V2Principal.require(request).userId(),id);
        return org.springframework.http.ResponseEntity.ok()
                .header("Cache-Control","private, max-age=300")
                .contentType(org.springframework.http.MediaType.parseMediaType(stored.contentType()))
                .body(stored.bytes());
    }

    @GetMapping("/{id}")
    public Result<RecognitionService.Recognition> get(@PathVariable long workspaceId,@PathVariable long id,HttpServletRequest request) {
        return Result.ok(service.get(workspaceId,V2Principal.require(request).userId(),id));
    }
}
