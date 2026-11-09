package com.hdr.config;

import com.hdr.v2.auth.AuthDtos;
import com.hdr.v2.auth.V2AuthService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Explicit local-only W1 compatibility bootstrap. Never grants a platform role. */
@Component
@ConditionalOnProperty(name = "hdr.legacy.bootstrap-enabled", havingValue = "true")
public class DataInitializer implements CommandLineRunner {
    private final V2AuthService auth;
    private final JdbcTemplate jdbc;
    private final boolean legacyEnabled;
    private final String username;
    private final String password;

    public DataInitializer(V2AuthService auth, JdbcTemplate jdbc,
                           @Value("${hdr.legacy.auth-enabled:false}") boolean legacyEnabled,
                           @Value("${hdr.legacy.bootstrap-username:}") String username,
                           @Value("${hdr.legacy.bootstrap-password:}") String password) {
        this.auth = auth;
        this.jdbc = jdbc;
        this.legacyEnabled = legacyEnabled;
        this.username = username;
        this.password = password;
    }

    @Override
    public void run(String... args) {
        if (!legacyEnabled || username.isBlank() || username.length() < 3 || username.length() > 32
                || password.isBlank() || password.length() < 6 || password.length() > 32) {
            throw new IllegalStateException("Legacy bootstrap requires opt-in legacy auth and explicit valid credentials");
        }
        Long exists = jdbc.queryForObject("SELECT COUNT(*) FROM t_user WHERE username=?", Long.class, username);
        // Do not reset credentials or promote an account that already exists.
        if (exists != null && exists > 0) return;
        AuthDtos.Session created = auth.register(new AuthDtos.RegisterRequest(username, password, username));
        jdbc.update("UPDATE t_user SET role='ADMIN' WHERE id=?", Long.parseLong(created.user().id()));
        jdbc.update("UPDATE t_auth_session SET revoked=TRUE WHERE user_id=?", Long.parseLong(created.user().id()));
    }
}
