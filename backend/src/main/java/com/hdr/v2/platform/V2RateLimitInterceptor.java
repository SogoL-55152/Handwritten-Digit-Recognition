package com.hdr.v2.platform;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class V2RateLimitInterceptor implements HandlerInterceptor {
    private final RateLimiter limiter;
    public V2RateLimitInterceptor(RateLimiter limiter) { this.limiter=limiter; }
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
            if(path.endsWith("/register")) limiter.check("register:"+request.getRemoteAddr(),5,900);
        }
        return true;
    }
}
