package com.hdr.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 空的数据库没有管理员：注册接口固定写入 platform_role='USER'，
 * 因此模型管理、训练参数向导、平台状态这些页面在全新部署时无人可进。
 *
 * 本组件在显式配置 HDR_BOOTSTRAP_ADMIN_USERNAME / HDR_BOOTSTRAP_ADMIN_PASSWORD 时，
 * 在 Flyway 迁移完成后补一个 SUPER_ADMIN：
 *   - 账号不存在 → 直接创建（bcrypt 存储，不发会话、不写 cookie）；
 *   - 账号已存在但不是 SUPER_ADMIN → 提升为 SUPER_ADMIN（不改密码）；
 *   - 账号已是 SUPER_ADMIN → 什么都不做。
 * 两个变量任一为空时组件完全不动作，默认部署行为不变；创建后请立即改密码。
 */
@Component
public class V2AdminBootstrap implements ApplicationRunner {
    private static final Logger LOG = LoggerFactory.getLogger(V2AdminBootstrap.class);
    private static final int MIN_USERNAME = 3;
    private static final int MAX_USERNAME = 32;
    private static final int MIN_PASSWORD = 6;
    private static final int MAX_PASSWORD = 32;

    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwords;
    private final String username;
    private final String password;

    public V2AdminBootstrap(JdbcTemplate jdbc, PasswordEncoder passwords,
                            @Value("${hdr.v2.bootstrap-admin.username:}") String username,
                            @Value("${hdr.v2.bootstrap-admin.password:}") String password) {
        this.jdbc = jdbc;
        this.passwords = passwords;
        this.username = username == null ? "" : username.trim();
        this.password = password == null ? "" : password;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        if (username.isBlank() && password.isBlank()) return;
        if (username.length() < MIN_USERNAME || username.length() > MAX_USERNAME
                || password.length() < MIN_PASSWORD || password.length() > MAX_PASSWORD) {
            throw new IllegalStateException(
                    "Bootstrap admin requires a username of 3-32 chars and a password of 6-32 chars");
        }

        List<String> roles = jdbc.query("SELECT platform_role FROM t_user WHERE username=?",
                (rs, row) -> rs.getString(1), username);
        if (roles.isEmpty()) {
            jdbc.update("""
                    INSERT INTO t_user(username,password,nickname,role,status,platform_role)
                    VALUES (?,?,?,'ADMIN',1,'SUPER_ADMIN')
                    """, username, passwords.encode(password), username);
            LOG.warn("已创建引导管理员 '{}'（SUPER_ADMIN）。请立即登录并修改密码，然后移除 HDR_BOOTSTRAP_ADMIN_* 环境变量。", username);
            return;
        }
        if ("SUPER_ADMIN".equals(roles.get(0))) {
            LOG.info("引导管理员 '{}' 已是 SUPER_ADMIN，无需处理。", username);
            return;
        }
        jdbc.update("UPDATE t_user SET platform_role='SUPER_ADMIN' WHERE username=?", username);
        LOG.warn("已把既有账号 '{}' 提升为 SUPER_ADMIN（密码未改动）。", username);
    }
}
