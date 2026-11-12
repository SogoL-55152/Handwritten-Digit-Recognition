package com.hdr.v2.migration;

import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.AuthDtos;
import com.hdr.v2.auth.V2AuthService;
import com.hdr.v2.auth.V2TokenService;
import com.hdr.v2.workspace.WorkspaceService;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.platform.MySqlRateLimiter;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.platform.W2Limits;
import com.hdr.v2.recognition.ImageValidator;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.recognition.RecognitionService;
import org.springframework.transaction.support.TransactionTemplate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.junit.jupiter.api.*;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/** mysql-it only. Creates/drops only random schemas it successfully created itself. */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class IdentityWorkspaceIT {
    private String serverUrl;
    private String query;
    private String username;
    private String password;
    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private V2AuthService auth;
    private WorkspaceService workspaces;
    private AnnotationConfigApplicationContext context;
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
        migrate(dataSource);
        jdbc = new JdbcTemplate(dataSource);
        context = new AnnotationConfigApplicationContext();
        context.register(TransactionConfiguration.class);
        context.registerBean(DataSource.class, () -> dataSource);
        context.registerBean(JdbcTemplate.class, () -> jdbc);
        context.registerBean(DataSourceTransactionManager.class, () -> new DataSourceTransactionManager(dataSource));
        context.registerBean(PasswordEncoder.class, () -> new BCryptPasswordEncoder());
        context.registerBean(V2TokenService.class, () -> new V2TokenService(
                "v2-it-secret-0123456789abcdef0123456789abcdef", 24,
                "v1-it-secret-0123456789abcdef0123456789abcdef"));
        context.registerBean(WorkspaceService.class, () -> new WorkspaceService(jdbc, 3));
        context.registerBean(V2AuthService.class, () -> new V2AuthService(jdbc, context.getBean(PasswordEncoder.class),
                context.getBean(V2TokenService.class), context.getBean(WorkspaceService.class),
                new com.hdr.v2.platform.PilotPolicy(false, ""), mock(RateLimiter.class),
                new TransactionTemplate(context.getBean(DataSourceTransactionManager.class))));
        context.refresh();
        auth = context.getBean(V2AuthService.class);
        workspaces = context.getBean(WorkspaceService.class);
    }

    @AfterAll
    void cleanupOwnedSchemasOnly() {
        if (context != null) context.close();
        if (admin != null) for (String schema : ownedSchemas) admin.execute("DROP DATABASE `" + schema + "`");
    }

    @Test
    void newDatabaseAndRepeatedMigrationKeepOneTrustedPublicBaseline() {
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_model WHERE scope='PUBLIC'", Long.class));
        assertEquals("w2-canvas-photo-3epoch", jdbc.queryForObject("SELECT version FROM t_v2_model WHERE id=1", String.class));
        assertEquals(0.977, jdbc.queryForObject("SELECT accuracy FROM t_v2_model WHERE id=1", Double.class));
        migrate(context.getBean(DataSource.class));
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_v2_dataset", Long.class));
    }

    @Test
    void registrationPersistsOwnerDefaultSessionAndLogoutRevokesIt() {
        AuthDtos.Session session = register();
        var principal = auth.authenticate(session.token());
        assertEquals("USER", principal.platformRole());
        assertEquals(session.user(), auth.me(principal).user());
        var workspace = workspaces.requireMember(Long.parseLong(session.defaultWorkspaceId()), principal.userId());
        assertEquals("OWNER", workspace.role());
        assertEquals("1", workspace.defaultModelId());
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_auth_session WHERE user_id=?", Long.class, principal.userId()));
        auth.logout(principal);
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(session.token())).getStatus());
    }

    @Test
    void sessionAndAccountStateAndPlatformRoleAreReadEveryRequest() {
        AuthDtos.Session session = register();
        long userId = Long.parseLong(session.user().id());
        jdbc.update("UPDATE t_user SET platform_role='SUPER_ADMIN' WHERE id=?", userId);
        assertEquals("SUPER_ADMIN", auth.authenticate(session.token()).platformRole());
        jdbc.update("UPDATE t_user SET status=0 WHERE id=?", userId);
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(session.token())).getStatus());
        jdbc.update("UPDATE t_user SET status=1,deleted=1 WHERE id=?", userId);
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(session.token())).getStatus());
        jdbc.update("UPDATE t_user SET deleted=0 WHERE id=?", userId);
        jdbc.update("UPDATE t_auth_session SET expires_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE user_id=?", userId);
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(session.token())).getStatus());
    }

    @Test
    void membershipAndWorkspaceDisablingAreRealAndPlatformAdminDoesNotBypassThem() {
        AuthDtos.Session owner = register();
        AuthDtos.Session other = register();
        long workspaceId = Long.parseLong(owner.defaultWorkspaceId());
        long otherId = Long.parseLong(other.user().id());
        jdbc.update("UPDATE t_user SET platform_role='SUPER_ADMIN' WHERE id=?", otherId);
        assertEquals(404, assertThrows(V2Exception.class, () -> workspaces.requireMember(workspaceId, otherId)).getStatus());
        jdbc.update("INSERT INTO t_workspace_member(workspace_id,user_id,role) VALUES (?,?,'MEMBER')", workspaceId, otherId);
        assertEquals("MEMBER", workspaces.requireMember(workspaceId, otherId).role());
        jdbc.update("UPDATE t_workspace_member SET status='DISABLED' WHERE workspace_id=? AND user_id=?", workspaceId, otherId);
        assertEquals(404, assertThrows(V2Exception.class, () -> workspaces.requireMember(workspaceId, otherId)).getStatus());
        jdbc.update("UPDATE t_workspace_member SET status='ACTIVE' WHERE workspace_id=? AND user_id=?", workspaceId, otherId);
        jdbc.update("UPDATE t_workspace SET status='DISABLED' WHERE id=?", workspaceId);
        assertEquals(404, assertThrows(V2Exception.class, () -> workspaces.requireMember(workspaceId, otherId)).getStatus());
    }

    @Test
    void parallelCreationNeverExceedsThreeIncludingPersonalSpace() throws Exception {
        long userId = Long.parseLong(register().user().id());
        List<Integer> codes = parallel(5, () -> {
            try { workspaces.create(userId, "Parallel"); return 201; }
            catch (V2Exception ex) { return ex.getStatus(); }
        });
        assertEquals(2, codes.stream().filter(code -> code == 201).count());
        assertEquals(3, codes.stream().filter(code -> code == 409).count());
        assertEquals(3L, jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace WHERE owner_id=?", Long.class, userId));
    }

    @Test
    void concurrentDuplicateRegistrationCreatesExactlyOneCompleteAccount() throws Exception {
        String name = uniqueName();
        List<Integer> codes = parallel(3, () -> {
            try { auth.register(new AuthDtos.RegisterRequest(name, "secret123", null)); return 201; }
            catch (V2Exception ex) { return ex.getStatus(); }
        });
        assertEquals(1, codes.stream().filter(code -> code == 201).count());
        assertEquals(2, codes.stream().filter(code -> code == 409).count());
        long id = jdbc.queryForObject("SELECT id FROM t_user WHERE username=?", Long.class, name);
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace WHERE owner_id=?", Long.class, id));
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace_member WHERE user_id=?", Long.class, id));
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_auth_session WHERE user_id=?", Long.class, id));
    }

    @Test
    void sessionInsertFailureRollsBackAccountSpaceAndMembership() {
        String name = uniqueName();
        long beforeSpaces = jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace", Long.class);
        long beforeMembers = jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace_member", Long.class);
        long existingUserCeiling = jdbc.queryForObject("SELECT COALESCE(MAX(id),0) FROM t_user", Long.class);
        // A table-local constraint rejects only future users' sessions. No SUPER privilege
        // or weakened binary-log safeguards are needed for this failure injection.
        jdbc.execute("ALTER TABLE t_auth_session ADD CONSTRAINT reject_test_session CHECK (user_id <= " + existingUserCeiling + ")");
        try {
            var error = assertThrows(org.springframework.dao.DataAccessException.class,
                    () -> auth.register(new AuthDtos.RegisterRequest(name, "secret123", null)));
            var sqlError = assertInstanceOf(java.sql.SQLException.class, error.getMostSpecificCause());
            assertEquals(3819, sqlError.getErrorCode());
            assertTrue(sqlError.getMessage().contains("reject_test_session"));
        } finally {
            jdbc.execute("ALTER TABLE t_auth_session DROP CHECK reject_test_session");
        }
        assertEquals(0L, jdbc.queryForObject("SELECT COUNT(*) FROM t_user WHERE username=?", Long.class, name));
        assertEquals(beforeSpaces, jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace", Long.class));
        assertEquals(beforeMembers, jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace_member", Long.class));
    }

    @Test
    void explicitValidatedW1UpgradePreservesRolesAndBackfillsOnlyNondeletedUsers() {
        DataSource legacy = newSchema();
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V1__w1_baseline.sql")).execute(legacy);
        JdbcTemplate old = new JdbcTemplate(legacy);
        old.update("INSERT INTO t_user(username,password,role) VALUES ('old-admin','not-used','ADMIN')");
        old.update("INSERT INTO t_user(username,password,status) VALUES ('old-disabled','not-used',0)");
        old.update("INSERT INTO t_user(username,password,deleted) VALUES ('old-deleted','not-used',1)");
        old.update("INSERT INTO t_model(name,external_id,is_active) VALUES ('Unknown private asset','old-asset',1)");
        W1UpgradeHelper.validate(old);
        Flyway.configure().dataSource(legacy).baselineVersion("1").cleanDisabled(true).load().baseline();
        migrate(legacy);
        migrate(legacy);
        assertEquals(2L, old.queryForObject("SELECT COUNT(*) FROM t_workspace", Long.class));
        assertEquals(2L, old.queryForObject("SELECT COUNT(*) FROM t_workspace_member WHERE role='OWNER'", Long.class));
        assertEquals(0L, old.queryForObject("SELECT COUNT(*) FROM t_user WHERE platform_role='SUPER_ADMIN'", Long.class));
        assertEquals("ADMIN", old.queryForObject("SELECT role FROM t_user WHERE username='old-admin'", String.class));
        assertEquals(1L, old.queryForObject("SELECT COUNT(*) FROM t_v2_model", Long.class));
        assertEquals(1L, old.queryForObject("SELECT COUNT(*) FROM t_model WHERE external_id='old-asset'", Long.class));
    }

    @Test
    void unknownNonemptySchemaAndModifiedW1AreNeverAutomaticallyBaselined() {
        DataSource unknown = newSchema();
        JdbcTemplate database = new JdbcTemplate(unknown);
        database.execute("CREATE TABLE unknown_table (id BIGINT PRIMARY KEY)");
        assertThrows(FlywayException.class, () -> migrate(unknown));
        assertThrows(IllegalStateException.class, () -> W1UpgradeHelper.validate(database));
        assertEquals(0L, database.queryForObject("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='t_workspace'", Long.class));
        DataSource changed = newSchema();
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V1__w1_baseline.sql")).execute(changed);
        JdbcTemplate modified = new JdbcTemplate(changed);
        modified.execute("ALTER TABLE t_user MODIFY COLUMN username VARCHAR(32) NOT NULL");
        assertThrows(IllegalStateException.class, () -> W1UpgradeHelper.validate(modified));
    }

    @Test
    void catalogueKeepsPrivateFixturesInTheirWorkspace() {
        var owner = register();
        var other = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId());
        long otherWid = Long.parseLong(other.defaultWorkspaceId());
        jdbc.update("INSERT INTO t_v2_model(name,version,scope,workspace_id,external_id,preprocess_version) VALUES ('Private','test','WORKSPACE',?,'private','test')", wid);
        jdbc.update("INSERT INTO t_v2_dataset(name,version,scope,workspace_id,train_samples,test_samples) VALUES ('Private','test','WORKSPACE',?,1,1)", wid);
        long privateModel = jdbc.queryForObject("SELECT id FROM t_v2_model WHERE workspace_id=?", Long.class, wid);
        long privateDataset = jdbc.queryForObject("SELECT id FROM t_v2_dataset WHERE workspace_id=?", Long.class, wid);
        var catalogue = new CatalogueService(jdbc);
        assertEquals(2, catalogue.models(wid).size());
        assertEquals(1, catalogue.models(otherWid).size());
        assertEquals(2, catalogue.datasets(wid).size());
        assertEquals(1, catalogue.datasets(otherWid).size());
        assertEquals(404, assertThrows(V2Exception.class, () -> catalogue.model(otherWid, privateModel)).getStatus());
        assertEquals(404, assertThrows(V2Exception.class, () -> catalogue.dataset(otherWid, privateDataset)).getStatus());
        assertEquals("1", catalogue.defaultModel(wid).id());
    }

    @Test
    void successfulRecognitionIsReplayedWithoutAnotherModelCallAndIsOwnerScoped() {
        var owner = register();
        var member = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId());
        long uid = Long.parseLong(owner.user().id());
        long memberId = Long.parseLong(member.user().id());
        jdbc.update("INSERT INTO t_workspace_member(workspace_id,user_id,role) VALUES (?,?,'MEMBER')", wid, memberId);
        ModelClient model = mock(ModelClient.class);
        when(model.predict(anyLong(), anyString(), any(), any())).thenReturn(new ModelClient.Prediction(7, .98));
        var service = recognitionService(model);
        String request = UUID.randomUUID().toString();
        var image = new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png");
        var result = service.predict(wid, uid, request, "WEB", image);
        assertEquals(result, service.predict(wid, uid, request, "WEB", image));
        assertEquals("w2-canvas-photo-3epoch", result.modelVersion());
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_recognition_v2 WHERE workspace_id=? AND creator_id=?", Long.class, wid, uid));
        assertEquals(404, assertThrows(V2Exception.class, () -> service.get(wid, memberId, Long.parseLong(result.recognitionId()))).getStatus());
        assertEquals(404, assertThrows(V2Exception.class, () -> service.get(Long.parseLong(member.defaultWorkspaceId()), uid, Long.parseLong(result.recognitionId()))).getStatus());
        assertEquals("IDEMPOTENCY_CONFLICT", assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "MINIPROGRAM", image)).getCategory());
        assertEquals("IDEMPOTENCY_CONFLICT", assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB",
                new ImageValidator.Image(new byte[]{2}, "b".repeat(64), "image/png"))).getCategory());
        verify(model, times(1)).predict(anyLong(), anyString(), any(), any());
    }

    @Test
    void failedRecognitionHasTerminalStateAndNeverAutomaticallyReplays() {
        var owner = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId()), uid = Long.parseLong(owner.user().id());
        ModelClient model = mock(ModelClient.class);
        when(model.predict(anyLong(), anyString(), any(), any())).thenThrow(new V2Exception(503, "not ready"));
        var service = recognitionService(model);
        String request = UUID.randomUUID().toString();
        var image = new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png");
        assertEquals(503, assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB", image)).getStatus());
        assertEquals("FAILED", jdbc.queryForObject("SELECT status FROM t_recognition_v2 WHERE workspace_id=?", String.class, wid));
        assertEquals("REQUEST_FAILED", assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB", image)).getCategory());
        verify(model, times(1)).predict(anyLong(), anyString(), any(), any());
    }

    @Test
    void declinedInputIsFailedWithoutSavedGuessOrSuccessfulDetail() {
        var owner = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId()), uid = Long.parseLong(owner.user().id());
        ModelClient model = mock(ModelClient.class);
        when(model.predict(anyLong(), anyString(), any(), any())).thenThrow(new V2Exception(422, "rewrite", "UNRECOGNIZED_INPUT"));
        var service = recognitionService(model);
        String request = UUID.randomUUID().toString();
        var image = new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png");
        assertEquals(422, assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB", image)).getStatus());
        long id = jdbc.queryForObject("SELECT id FROM t_recognition_v2 WHERE workspace_id=?", Long.class, wid);
        assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM t_recognition_v2 WHERE id=? AND status='FAILED' AND digit IS NULL AND confidence IS NULL", Long.class, id));
        assertEquals(404, assertThrows(V2Exception.class, () -> service.get(wid, uid, id)).getStatus());
        assertEquals("REQUEST_FAILED", assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB", image)).getCategory());
        verify(model, times(1)).predict(anyLong(), anyString(), any(), any());
    }

    @Test
    void inFlightDuplicateIsNotReplayedAndCanLaterReadTheSavedResult() throws Exception {
        var owner = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId()), uid = Long.parseLong(owner.user().id());
        ModelClient model = mock(ModelClient.class);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(model.predict(anyLong(), anyString(), any(), any())).thenAnswer(invocation -> {
            entered.countDown();
            assertTrue(release.await(10, TimeUnit.SECONDS));
            return new ModelClient.Prediction(3, .9);
        });
        var service = recognitionService(model);
        String request = UUID.randomUUID().toString();
        var image = new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png");
        var executor = Executors.newSingleThreadExecutor();
        try {
            var pending = executor.submit(() -> service.predict(wid, uid, request, "WEB", image));
            assertTrue(entered.await(10, TimeUnit.SECONDS));
            assertEquals("IN_PROGRESS", assertThrows(V2Exception.class, () -> service.predict(wid, uid, request, "WEB", image)).getCategory());
            release.countDown();
            assertEquals(pending.get(10, TimeUnit.SECONDS), service.predict(wid, uid, request, "WEB", image));
        } finally { release.countDown(); executor.shutdownNow(); }
        verify(model, times(1)).predict(anyLong(), anyString(), any(), any());
    }

    @Test
    void abandonedProcessingRequestBecomesFailedWithoutCallingModel() {
        var owner = register();
        long wid = Long.parseLong(owner.defaultWorkspaceId()), uid = Long.parseLong(owner.user().id());
        String request = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO t_recognition_v2(workspace_id,creator_id,request_id,image_digest,source,model_id,model_version,preprocess_version,created_at) VALUES (?,?,?,?,'WEB',1,'w2-canvas-photo-3epoch','adaptive-mnist-v2',DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE))", wid, uid, request, "a".repeat(64));
        ModelClient model = mock(ModelClient.class);
        assertEquals("REQUEST_FAILED", assertThrows(V2Exception.class, () -> recognitionService(model).predict(wid, uid, request, "WEB",
                new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png"))).getCategory());
        verifyNoInteractions(model);
        assertEquals("FAILED", jdbc.queryForObject("SELECT status FROM t_recognition_v2 WHERE workspace_id=?", String.class, wid));
    }

    @Test
    void rateWindowAdmitsExactlyCapacityUnderRealMysqlConcurrency() throws Exception {
        var tx = new TransactionTemplate(context.getBean(DataSourceTransactionManager.class));
        Clock now = Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC);
        var limiter = new MySqlRateLimiter(jdbc, tx, now);
        String key = UUID.randomUUID().toString();
        List<Integer> codes = parallel(12, () -> {
            try { limiter.check(key, 5, 60); return 200; }
            catch (V2Exception error) {
                assertEquals("RATE_LIMIT", error.getCategory());
                assertEquals(60, error.getRetryAfterSeconds());
                return error.getStatus();
            }
        });
        assertEquals(5, codes.stream().filter(code -> code == 200).count());
        assertEquals(7, codes.stream().filter(code -> code == 429).count());
        new MySqlRateLimiter(jdbc, tx, Clock.offset(now, java.time.Duration.ofSeconds(60))).check(key, 5, 60);
    }

    @Test
    void passwordChangeRevokesAllSessionsAndPreservesLegacyLoginCredentials() {
        var session = register();
        String username = session.user().username();
        long userId = Long.parseLong(session.user().id());
        var encoder = context.getBean(PasswordEncoder.class);
        jdbc.update("UPDATE t_user SET password=? WHERE id=?", encoder.encode("old pass"), userId);
        var second = auth.login(new AuthDtos.LoginRequest(username, "old pass"));
        var principal = auth.authenticate(second.token());
        assertEquals(400, assertThrows(V2Exception.class, () -> auth.changePassword(principal,
                new AuthDtos.PasswordRequest("wrong123", "next12345"))).getStatus());
        assertDoesNotThrow(() -> auth.authenticate(session.token()));
        assertEquals(400, assertThrows(V2Exception.class, () -> auth.changePassword(principal,
                new AuthDtos.PasswordRequest("old pass", "new pass"))).getStatus());
        auth.changePassword(principal, new AuthDtos.PasswordRequest("old pass", "next12345"));
        for (String token : List.of(session.token(), second.token())) {
            assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(token)).getStatus());
        }
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.login(new AuthDtos.LoginRequest(username, "old pass"))).getStatus());
        assertDoesNotThrow(() -> auth.login(new AuthDtos.LoginRequest(username, "next12345")));
        assertEquals(401, assertThrows(V2Exception.class, () -> auth.changePassword(principal,
                new AuthDtos.PasswordRequest("next12345", "other12345"))).getStatus());
    }

    @Test
    void passwordChangeSerializesWithOldPasswordLogin() throws Exception {
        var session = register();
        var principal = auth.authenticate(session.token());
        var executor = Executors.newFixedThreadPool(2);
        var start = new CountDownLatch(1);
        try {
            var login = executor.submit(() -> {
                start.await();
                try { return auth.login(new AuthDtos.LoginRequest(session.user().username(), "secret123")).token(); }
                catch (V2Exception failure) { assertEquals(401, failure.getStatus()); return null; }
            });
            var change = executor.submit(() -> {
                start.await();
                auth.changePassword(principal, new AuthDtos.PasswordRequest("secret123", "changed123"));
                return true;
            });
            start.countDown();
            assertTrue(change.get(30, TimeUnit.SECONDS));
            String racedToken = login.get(30, TimeUnit.SECONDS);
            if (racedToken != null) assertEquals(401, assertThrows(V2Exception.class, () -> auth.authenticate(racedToken)).getStatus());
            assertEquals(0L, jdbc.queryForObject("SELECT COUNT(*) FROM t_auth_session WHERE user_id=? AND revoked=FALSE", Long.class, principal.userId()));
        } finally { executor.shutdownNow(); }
    }

    @Test
    void pilotRegistrationGateAndFailedPasswordAttemptsAreEnforcedInDatabase() {
        var tx = new TransactionTemplate(context.getBean(DataSourceTransactionManager.class));
        var pilot = new com.hdr.v2.platform.PilotPolicy(true, "test-only-pilot-code-0123456789");
        var pilotSpaces = new WorkspaceService(jdbc, 1, pilot);
        var service = new V2AuthService(jdbc, context.getBean(PasswordEncoder.class), context.getBean(V2TokenService.class),
                pilotSpaces, pilot, new MySqlRateLimiter(jdbc, tx, Clock.fixed(Instant.parse("2026-11-04T00:00:00Z"), ZoneOffset.UTC)), tx);
        String name = uniqueName();
        assertEquals(403, assertThrows(V2Exception.class, () -> tx.execute(status ->
                service.register(new AuthDtos.RegisterRequest(name, "secret123", null, "wrong")))).getStatus());
        assertEquals(0L, jdbc.queryForObject("SELECT COUNT(*) FROM t_user WHERE username=?", Long.class, name));
        var session = tx.execute(status -> service.register(new AuthDtos.RegisterRequest(name, "secret123", null,
                "test-only-pilot-code-0123456789")));
        var principal = service.authenticate(session.token());
        assertEquals(1, pilotSpaces.list(principal.userId()).size());
        assertEquals(403, assertThrows(V2Exception.class, () -> pilotSpaces.create(principal.userId(), "extra")).getStatus());
        for (int i = 0; i < 5; i++) assertEquals(400, assertThrows(V2Exception.class, () -> service.changePassword(principal,
                new AuthDtos.PasswordRequest("wrong123", "next12345"))).getStatus());
        assertEquals(429, assertThrows(V2Exception.class, () -> service.changePassword(principal,
                new AuthDtos.PasswordRequest("secret123", "next12345"))).getStatus());
        assertDoesNotThrow(() -> service.authenticate(session.token()));
    }

    private RecognitionService recognitionService(ModelClient model) {
        return new RecognitionService(jdbc, new CatalogueService(jdbc), workspaces, model,
                mock(RateLimiter.class), new W2Limits(3, 60), new com.fasterxml.jackson.databind.ObjectMapper(),
                new com.hdr.v2.recognition.RecognitionImageStore("target/test-recognition-images"));
    }

    private AuthDtos.Session register() {
        return auth.register(new AuthDtos.RegisterRequest(uniqueName(), "secret123", null));
    }
    private String uniqueName() { return "u" + UUID.randomUUID().toString().replace("-", "").substring(0, 20); }
    private DataSource newSchema() {
        String name = "hdr_w2_it_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4");
        ownedSchemas.add(name);
        return new DriverManagerDataSource(serverUrl + name + query, username, password);
    }
    private void migrate(DataSource source) {
        Flyway.configure().dataSource(source).locations("classpath:db/migration")
                .baselineOnMigrate(false).cleanDisabled(true).load().migrate();
    }
    private <T> List<T> parallel(int count, Callable<T> work) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(count);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<T>> futures = new ArrayList<>();
            for (int i = 0; i < count; i++) futures.add(executor.submit(() -> { start.await(); return work.call(); }));
            start.countDown();
            List<T> values = new ArrayList<>();
            for (Future<T> future : futures) values.add(future.get(30, TimeUnit.SECONDS));
            return values;
        } finally {
            executor.shutdownNow();
        }
    }
    @Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    static class TransactionConfiguration {}
}
