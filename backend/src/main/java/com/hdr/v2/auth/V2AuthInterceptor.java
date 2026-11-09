package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class V2AuthInterceptor implements HandlerInterceptor {
    private final V2AuthService auth;

    public V2AuthInterceptor(V2AuthService auth) {
        this.auth = auth;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        request.removeAttribute(V2Principal.ATTRIBUTE);
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())
                || ("POST".equals(request.getMethod()) &&
                ("/api/v2/auth/login".equals(path) || "/api/v2/auth/register".equals(path)))) {
            return true;
        }
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ") || header.length() > 4096) {
            throw new V2Exception(401, "未登录或登录已过期");
        }
        V2Principal principal = auth.authenticate(header.substring(7));
        request.setAttribute(V2Principal.ATTRIBUTE, principal);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        request.removeAttribute(V2Principal.ATTRIBUTE);
    }
}
