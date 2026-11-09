package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import com.hdr.v2.platform.PilotPolicy;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.workspace.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.support.TransactionTemplate;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PilotPolicyTest {
    private static final String CODE = "test-only-pilot-code-0123456789";

    @Test
    void pilotAdmissionIsClosedWithoutConfiguredOrCorrectCode() {
        assertEquals(403, assertThrows(V2Exception.class, () -> new PilotPolicy(true, "").requireRegistration(CODE)).getStatus());
        var policy = new PilotPolicy(true, CODE);
        for (String value : new String[]{null, "", "wrong", CODE + " ", "x".repeat(257)}) {
            assertEquals("PILOT_ADMISSION", assertThrows(V2Exception.class, () -> policy.requireRegistration(value)).getCategory());
        }
        assertDoesNotThrow(() -> policy.requireRegistration(CODE));
        assertDoesNotThrow(() -> new PilotPolicy(false, "").requireRegistration(null));
        assertThrows(IllegalStateException.class, () -> new PilotPolicy(true, "short"));
    }

    @Test
    void admissionRejectsBeforeDatabaseOrExpensivePasswordWork() {
        var jdbc = mock(JdbcTemplate.class);
        var encoder = mock(PasswordEncoder.class);
        var auth = new V2AuthService(jdbc, encoder, mock(V2TokenService.class), mock(WorkspaceService.class),
                new PilotPolicy(true, CODE), mock(RateLimiter.class), mock(TransactionTemplate.class));
        clearInvocations(encoder); // Constructor's fixed dummy hash is not request work.
        assertThrows(V2Exception.class, () -> auth.register(new AuthDtos.RegisterRequest("alice", "secret123", null, "wrong")));
        verifyNoInteractions(jdbc, encoder);
    }

    @Test
    void pilotDoesNotAllowDirectWorkspaceCreation() {
        var jdbc = mock(JdbcTemplate.class);
        var spaces = new WorkspaceService(jdbc, 3, new PilotPolicy(true, CODE));
        assertEquals(403, assertThrows(V2Exception.class, () -> spaces.create(1, "extra")).getStatus());
        verifyNoInteractions(jdbc);
    }

    @Test
    void newCredentialsRejectExactCrossClientWhitespaceSet() {
        for (int cp : new int[]{9,10,11,12,13,32,0x85,0xa0,0x1680,0x2000,0x200a,0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff}) {
            assertThrows(V2Exception.class, () -> CredentialRules.validate("abc" + (char)cp + "def", 6, "password"));
        }
        assertDoesNotThrow(() -> CredentialRules.validate("secret123", 6, "password"));
        assertDoesNotThrow(() -> CredentialRules.validate("用户甲", 3, "username"));
        assertEquals("RegisterRequest[redacted]", new AuthDtos.RegisterRequest("alice", "secret123", null, CODE).toString());
        assertFalse(new AuthDtos.PasswordRequest("old123", "new123").toString().contains("old123"));
    }
}
