package com.hdr.v2.platform;

import com.hdr.v2.V2Exception;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

@Component
public class PilotPolicy {
    private final boolean enabled;
    private final byte[] registrationDigest;

    public PilotPolicy(@Value("${hdr.pilot.enabled:false}") boolean enabled,
                       @Value("${hdr.pilot.registration-code:}") String registrationCode) {
        this.enabled = enabled;
        if (enabled && !registrationCode.isBlank() && (registrationCode.length() < 16 || registrationCode.length() > 256)) {
            throw new IllegalStateException("Pilot registration code must contain 16-256 characters or be empty to close admission");
        }
        this.registrationDigest = registrationCode.isBlank() ? null : digest(registrationCode);
    }

    public boolean enabled() { return enabled; }

    public void requireRegistration(String provided) {
        if (!enabled) return;
        if (registrationDigest == null || provided == null || provided.length() > 256
                || !MessageDigest.isEqual(registrationDigest, digest(provided))) {
            throw new V2Exception(403, "体验注册暂不可用或注册码无效，请联系维护者", "PILOT_ADMISSION");
        }
    }

    public void requireWorkspaceCreation() {
        if (enabled) throw new V2Exception(403, "体验版仅提供注册时创建的个人空间", "PILOT_SCOPE");
    }

    private static byte[] digest(String value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}
