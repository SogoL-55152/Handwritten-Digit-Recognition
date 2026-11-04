package com.hdr.v2.auth;

import com.hdr.auth.JwtUtil;
import com.hdr.v2.V2Exception;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class V2TokenServiceTest {
    static final String SECRET = "v2-test-key-0123456789abcdef0123456789abcdef";
    static final String LEGACY = "v1-test-key-0123456789abcdef0123456789abcdef";
    private final V2TokenService tokens = new V2TokenService(SECRET, 24, LEGACY);

    @Test
    void issuesUnpredictableServerSessionIdentityWithoutCachedRoles() {
        var issued = tokens.issue(9007199254740993L);
        var parsed = tokens.parse(issued.token());
        assertEquals(9007199254740993L, parsed.userId());
        assertEquals(issued.sessionId(), parsed.sessionId());
        assertNotEquals(issued.sessionId(), tokens.issue(parsed.userId()).sessionId());
        var claims = Jwts.parser().verifyWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8)))
                .build().parseSignedClaims(issued.token()).getPayload();
        assertEquals(2, claims.get("ver", Integer.class));
        assertTrue(claims.getAudience().contains("hdr-v2"));
        assertFalse(claims.containsKey("role"));
        assertFalse(claims.containsKey("password"));
    }

    @Test
    void tokenGenerationsRejectEachOtherEvenIfLegacyParserHasV2Key() {
        assertEquals(401, assertThrows(V2Exception.class,
                () -> tokens.parse(new JwtUtil(LEGACY, 1).generate(1L, "alice", "ADMIN"))).getStatus());
        assertThrows(JwtException.class, () -> new JwtUtil(SECRET, 1).parse(tokens.issue(1).token()));
        assertThrows(JwtException.class, () -> new JwtUtil(LEGACY, 1).parse(tokens.issue(1).token()));
    }

    @Test
    void rejectsMissingWrongAudienceVersionSessionOrLifetime() {
        for (String token : new String[]{
                signed("hdr-v1", 2, "1", UUID.randomUUID().toString(), true),
                signed("hdr-v2", 1, "1", UUID.randomUUID().toString(), true),
                signed("hdr-v2", 2, "not-a-number", UUID.randomUUID().toString(), true),
                signed("hdr-v2", 2, "0", UUID.randomUUID().toString(), true),
                signed("hdr-v2", 2, "1", "1-1-1-1-1", true),
                signed("hdr-v2", 2, "1", UUID.randomUUID().toString(), false),
                "not-a-token"}) {
            assertEquals(401, assertThrows(V2Exception.class, () -> tokens.parse(token)).getStatus());
        }
    }

    @Test
    void expiredSignatureAndIndependentKeyConfigurationAreEnforced() {
        String expired = Jwts.builder().subject("1").audience().add("hdr-v2").and().claim("ver", 2)
                .claim("sid", UUID.randomUUID().toString()).issuedAt(Date.from(Instant.now().minusSeconds(100)))
                .expiration(Date.from(Instant.now().minusSeconds(1)))
                .signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8))).compact();
        assertEquals(401, assertThrows(V2Exception.class, () -> tokens.parse(expired)).getStatus());
        assertThrows(IllegalStateException.class, () -> new V2TokenService("", 24, LEGACY));
        assertThrows(IllegalStateException.class, () -> new V2TokenService(LEGACY, 24, LEGACY));
        assertThrows(IllegalStateException.class, () -> new V2TokenService(SECRET, 0, LEGACY));
    }

    private String signed(String audience, int version, String subject, String sid, boolean expiry) {
        var builder = Jwts.builder().subject(subject).audience().add(audience).and().claim("ver", version)
                .claim("sid", sid).issuedAt(new Date());
        if (expiry) builder.expiration(Date.from(Instant.now().plusSeconds(60)));
        return builder.signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8))).compact();
    }
}
