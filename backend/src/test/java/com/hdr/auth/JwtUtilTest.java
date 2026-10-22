package com.hdr.auth;

import io.jsonwebtoken.Claims;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class JwtUtilTest {

    @Test
    void shouldGenerateAndParseToken() {
        JwtUtil jwtUtil = new JwtUtil("0123456789abcdef0123456789abcdef", 1);

        String token = jwtUtil.generate(42L, "alice", "USER");
        Claims claims = jwtUtil.parse(token);

        assertEquals("42", claims.getSubject());
        assertEquals("alice", claims.get("username", String.class));
        assertEquals("USER", claims.get("role", String.class));
    }
}
