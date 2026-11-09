package com.hdr.v2.model;

import com.hdr.v2.V2Exception;
import com.hdr.v2.recognition.ModelClient;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * 真实 MySQL 上的模型状态机：单一活跃、切换、停用与删除边界。
 * 每个 IT 类使用自己随机命名的 hdr_w2_it_* 库，结束后只删除自己创建的库。
 * 每个用例使用独立模型版本，避免共享库里的注册记录互相干扰。
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ModelAdminIT {
    private static final String SHA = "72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa";
    private String serverUrl;
    private String query;
    private String username;
    private String password;
    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private long userId;
    private long workspaceId;
    private final List<String> ownedSchemas = new ArrayList<>();

    @BeforeAll
    void setup() {
        String url = System.getenv("W2_MYSQL_TEST_URL");
        assertNotNull(url, "mysql-it requires W2_MYSQL_TEST_URL and a dedicated hdr_w2_it_* schema; no silent skip");
        Matcher matcher = Pattern.compile("(jdbc:mysql://[^/]+/)(hdr_w2_it_[A-Za-z0-9_]+)(\\?.*)?").matcher(url);
        assertTrue(matcher.matches(), "Test URL must explicitly name a hdr_w2_it_* schema");
        serverUrl = matcher.group(1);
        query = matcher.group(3) == null ? "?serverTimezone=UTC" : matcher.group(3);
        username = System.getenv("W2_MYSQL_TEST_USERNAME");
        password = System.getenv("W2_MYSQL_TEST_PASSWORD");
        assertNotNull(username, "W2_MYSQL_TEST_USERNAME is required");
        assertNotNull(password, "W2_MYSQL_TEST_PASSWORD is required");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, username, password));
        DataSource dataSource = newSchema();
        Flyway.configure().dataSource(dataSource).locations("classpath:db/migration")
                .baselineOnMigrate(false).cleanDisabled(true).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        // 识别记录需要真实用户与空间（外键约束）。
        jdbc.update("INSERT INTO t_user(username,password,nickname,role,status) VALUES('it-model-admin','x','it','USER',1)");
        userId = jdbc.queryForObject("SELECT id FROM t_user WHERE username='it-model-admin'", Long.class);
        jdbc.update("INSERT INTO t_workspace(owner_id,name,personal_user_id,default_model_id) VALUES(?,?,?,1)",
                userId, "it-workspace", userId);
        workspaceId = jdbc.queryForObject("SELECT id FROM t_workspace WHERE owner_id=?", Long.class, userId);
    }

    @AfterAll
    void cleanupOwnedSchemasOnly() {
        if (admin != null) for (String schema : ownedSchemas) admin.execute("DROP DATABASE `" + schema + "`");
    }

    private DataSource newSchema() {
        String name = "hdr_w2_it_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4");
        ownedSchemas.add(name);
        return new DriverManagerDataSource(serverUrl + name + query, username, password);
    }

    private static String nextVersion() { return "w2-it-" + UUID.randomUUID().toString().substring(0, 8); }

    private ModelClient clientWith(String version, boolean verified, String sha) {
        ModelClient client = mock(ModelClient.class);
        when(client.reloadRegistry()).thenReturn(List.of(new ModelClient.RegisteredModel(
                "mnist-cnn-w1", version, "adaptive-mnist-v2", sha, 1690340L,
                "w2-it/checkpoint.pt", verified, false, verified ? "" : "RegistryInvalid")));
        return client;
    }

    private ModelAdminService service(ModelClient client) { return new ModelAdminService(jdbc, client); }

    private long registerModel(String version, boolean verified, String sha) {
        var registered = service(clientWith(version, verified, sha)).register(
                new ModelAdminService.RegisterCommand("mnist-cnn-w1", version));
        return Long.parseLong(registered.id());
    }

    @Test
    void databaseItselfAllowsOnlyOneActivePublicModel() {
        assertThrows(DuplicateKeyException.class, () -> jdbc.update("""
                INSERT INTO t_v2_model(name,version,scope,external_id,preprocess_version,status,sha256,size_bytes,artifact)
                VALUES('dup','w2-marker-test','PUBLIC','mnist-cnn-w1','adaptive-mnist-v2','ACTIVE',?,?,?)
                """, SHA, 1690340L, "w2-it/checkpoint.pt"));
        assertEquals(1L, jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_model WHERE scope='PUBLIC' AND status='ACTIVE'", Long.class));
    }

    @Test
    void registrationStoresArtifactIdentityAndIsInactive() {
        String version = nextVersion();
        long id = registerModel(version, true, "b".repeat(64));
        var row = jdbc.queryForMap("SELECT * FROM t_v2_model WHERE id=?", id);
        assertEquals("INACTIVE", row.get("status"));
        assertEquals("b".repeat(64), row.get("sha256"));
        assertEquals("w2-it/checkpoint.pt", row.get("artifact"));
        assertEquals(1690340L, ((Number) row.get("size_bytes")).longValue());
        assertEquals(409, assertThrows(V2Exception.class,
                () -> registerModel(version, true, "b".repeat(64))).getStatus());
    }

    @Test
    void registrationRefusesUnverifiedOrMissingArtifacts() {
        ModelClient unverified = clientWith("w2-it-unverified", false, "b".repeat(64));
        assertEquals(409, assertThrows(V2Exception.class, () -> service(unverified).register(
                new ModelAdminService.RegisterCommand("mnist-cnn-w1", "w2-it-unverified"))).getStatus());

        ModelClient missing = mock(ModelClient.class);
        when(missing.reloadRegistry()).thenReturn(List.of());
        assertEquals(400, assertThrows(V2Exception.class, () -> service(missing).register(
                new ModelAdminService.RegisterCommand("mnist-cnn-w1", "w2-it-missing"))).getStatus());
        assertEquals(0L, jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_model WHERE version IN ('w2-it-unverified','w2-it-missing')", Long.class));
    }

    @Test
    void activationMovesTheSingleActiveMarkerAndKeepsHistoryRows() {
        String version = nextVersion();
        long second = registerModel(version, true, "b".repeat(64));
        jdbc.update("INSERT INTO t_recognition_v2(workspace_id,creator_id,request_id,image_digest,source,"
                + "model_id,model_version,preprocess_version,status) VALUES(?,?,?,?,'WEB',1,?,'adaptive-mnist-v2','SUCCEEDED')",
                workspaceId, userId, UUID.randomUUID().toString(), "c".repeat(64), "w2-canvas-photo-3epoch");
        jdbc.update("UPDATE t_v2_model SET sha256=? WHERE id=?", "b".repeat(64), second);

        var activated = service(clientWith(version, true, "b".repeat(64))).activate(second);
        assertEquals("ACTIVE", activated.status());
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_model WHERE status='ACTIVE'", Long.class));
        assertEquals("INACTIVE", jdbc.queryForObject("SELECT status FROM t_v2_model WHERE id=1", String.class));
        assertEquals(1L, jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_recognition_v2 WHERE model_version='w2-canvas-photo-3epoch'", Long.class));

        // 切回原模型，保持其他用例仍以它为活跃模型
        jdbc.update("UPDATE t_v2_model SET status='INACTIVE' WHERE id=?", second);
        jdbc.update("UPDATE t_v2_model SET status='ACTIVE' WHERE id=1");
    }

    @Test
    void activationRejectsDigestMismatchBetweenDatabaseAndRegistry() {
        String version = nextVersion();
        long second = registerModel(version, true, "b".repeat(64));
        assertEquals(409, assertThrows(V2Exception.class,
                () -> service(clientWith(version, true, "d".repeat(64))).activate(second)).getStatus());
        assertEquals("ACTIVE", jdbc.queryForObject("SELECT status FROM t_v2_model WHERE id=1", String.class));
    }

    @Test
    void activeModelCannotBeDisabledOrDeleted() {
        var adminService = service(clientWith("w2-it-any", false, ""));
        assertEquals(409, assertThrows(V2Exception.class, () -> adminService.disable(1)).getStatus());
        assertEquals(409, assertThrows(V2Exception.class, () -> adminService.delete(1)).getStatus());
    }

    @Test
    void referencedModelCanBeDisabledButNotDeleted() {
        String version = nextVersion();
        long second = registerModel(version, true, "b".repeat(64));
        jdbc.update("INSERT INTO t_recognition_v2(workspace_id,creator_id,request_id,image_digest,source,"
                + "model_id,model_version,preprocess_version,status) VALUES(?,?,?,?,'WEB',?,?,'adaptive-mnist-v2','SUCCEEDED')",
                workspaceId, userId, UUID.randomUUID().toString(), "e".repeat(64), second, version);
        var adminService = service(clientWith(version, false, ""));
        assertEquals("DISABLED", adminService.disable(second).status());
        var blocked = assertThrows(V2Exception.class, () -> adminService.delete(second));
        assertEquals(409, blocked.getStatus());
        assertEquals("MODEL_IN_USE", blocked.getCategory());
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_model WHERE id=?", Long.class, second));
    }

    @org.springframework.context.annotation.Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    static class TransactionConfiguration {}
}
