package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import jakarta.servlet.http.HttpServletRequest;

/** Identity is rebuilt from the database on every authenticated request. */
public record V2Principal(long userId, String sessionId, String platformRole) {
    public static final String ATTRIBUTE = V2Principal.class.getName();

    public static V2Principal require(HttpServletRequest request) {
        Object principal = request.getAttribute(ATTRIBUTE);
        if (principal instanceof V2Principal authenticated) {
            return authenticated;
        }
        throw new V2Exception(401, "未登录或登录已过期");
    }
}
