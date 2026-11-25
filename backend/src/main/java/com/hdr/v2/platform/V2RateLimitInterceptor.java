package com.hdr.v2.platform;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class V2RateLimitInterceptor implements HandlerInterceptor {
    private final RateLimiter limiter;
    /** 注册接口按 IP 的配额：默认 5 次 / 15 分钟。压测或联调环境可放大，生产不建议调高。 */
    private final int registerPerIp;
    private final int registerWindowSeconds;

    public V2RateLimitInterceptor(RateLimiter limiter) {
        this(limiter, 5, 900);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public V2RateLimitInterceptor(RateLimiter limiter,
                                  @Value("${hdr.v2.limits.register-per-ip:5}") int registerPerIp,
                                  @Value("${hdr.v2.limits.register-window-seconds:900}") int registerWindowSeconds) {
        if (registerPerIp < 1 || registerWindowSeconds < 1)
            throw new IllegalArgumentException("Register limits must be positive");
        this.limiter = limiter;
        this.registerPerIp = registerPerIp;
        this.registerWindowSeconds = registerWindowSeconds;
    }

    @Override
    public boolean preHandle(HttpServletRequest request,HttpServletResponse response,Object handler) {
        if(!"POST".equals(request.getMethod())) return true;
        String path=request.getRequestURI().substring(request.getContextPath().length());
        if(path.matches("/api/v2/workspaces/[^/]+/recognitions")) {
            // Bound uploads before lazy multipart parsing and image decoding, including replays.
            limiter.check("upload:global",240,60);
            limiter.check("upload:ip:"+request.getRemoteAddr(),120,60);
        }
        if(path.equals("/api/v2/auth/password")) {
            limiter.check("password:global",100,60);
            limiter.check("password:ip:"+request.getRemoteAddr(),20,60);
        }
        if(path.equals("/api/v2/auth/register") || path.equals("/api/v2/auth/login")) {
            limiter.check("auth:global",300,60);
            // Forwarded headers are untrusted; development uses the actual peer address.
            limiter.check("auth:ip:"+request.getRemoteAddr(),30,60);
            if(path.endsWith("/register"))
                limiter.check("register:"+request.getRemoteAddr(),registerPerIp,registerWindowSeconds);
        }
        return true;
    }
}
