package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

@Component
public class V2TokenService {
    private static final String AUDIENCE = "hdr-v2";
    private final SecretKey key;
    private final long expireHours;

    public V2TokenService(@Value("${hdr.v2.jwt.secret:}") String secret,
                          @Value("${hdr.v2.jwt.expire-hours:24}") long expireHours,
                          @Value("${hdr.jwt.secret}") String legacySecret) {
        if (secret == null || secret.isBlank() || secret.equals(legacySecret)
                || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("Configure a distinct V2_JWT_SECRET of at least 32 bytes");
        }
        if (expireHours < 1 || expireHours > 168) {
            throw new IllegalStateException("V2 JWT lifetime must be between 1 and 168 hours");
        }
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.expireHours = expireHours;
    }

    public IssuedToken issue(long userId) {
        Instant now = Instant.now();
        Instant expiresAt = now.plusSeconds(expireHours * 3600);
        String sessionId = UUID.randomUUID().toString();
        String token = Jwts.builder().subject(Long.toString(userId))
                .audience().add(AUDIENCE).and()
                .claim("ver", 2).claim("sid", sessionId)
                .issuedAt(Date.from(now)).expiration(Date.from(expiresAt))
                .signWith(key).compact();
        return new IssuedToken(token, sessionId, expiresAt);
    }

    public TokenIdentity parse(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).requireAudience(AUDIENCE)
                    .require("ver", 2).build().parseSignedClaims(token).getPayload();
            if (claims.getExpiration() == null || claims.getIssuedAt() == null) {
                throw new IllegalArgumentException("Missing lifetime");
            }
            long userId = Long.parseLong(claims.getSubject());
            String sessionId = claims.get("sid", String.class);
            if (userId <= 0 || sessionId == null || !UUID.fromString(sessionId).toString().equals(sessionId)) {
                throw new IllegalArgumentException("Invalid identity");
            }
            return new TokenIdentity(userId, sessionId);
        } catch (JwtException | IllegalArgumentException e) {
            throw new V2Exception(401, "登录状态无效，请重新登录");
        }
    }

    public record IssuedToken(String token, String sessionId, Instant expiresAt) {}
    public record TokenIdentity(long userId, String sessionId) {}
}
