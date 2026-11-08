package com.hdr.v2.training;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

/**
 * Python worker 的内部回调：训练状态与产物信息由此写回数据库。
 * 只接受内部令牌；请求体只读取约定字段，未注册产物不会被当作模型。
 */
@RestController
@RequestMapping("/internal/v2/training")
public class InternalTrainingController {
    private final TrainingService service;
    private final String internalToken;

    public InternalTrainingController(TrainingService service,
                                      @Value("${hdr.model-service.internal-token:}") String internalToken) {
        this.service = service;
        this.internalToken = internalToken;
    }

    @PostMapping("/{id}/state")
    public Result<TrainingService.TaskView> state(@PathVariable long id,
                                                  @RequestBody(required = false) Map<String, Object> body,
                                                  HttpServletRequest request) {
        requireInternal(request);
        if (body == null) throw new V2Exception(400, "缺少回调内容", "VALIDATION");
        Object state = body.get("state");
        Object attempt = body.get("attempt");
        if (!(state instanceof String name) || !(attempt instanceof Number number))
            throw new V2Exception(400, "回调必须包含 state 与 attempt", "VALIDATION");
        return Result.ok(service.applyState(id, name, number.intValue(), body));
    }

    private void requireInternal(HttpServletRequest request) {
        if (internalToken == null || internalToken.isBlank())
            throw new V2Exception(503, "内部认证尚未配置", "NOT_CONFIGURED");
        String provided = request.getHeader("X-HDR-Internal-Token");
        if (provided == null || provided.length() > 4096
                || !MessageDigest.isEqual(provided.getBytes(StandardCharsets.UTF_8),
                        internalToken.getBytes(StandardCharsets.UTF_8)))
            throw new V2Exception(401, "内部认证失败", "UNAUTHORIZED");
    }
}
