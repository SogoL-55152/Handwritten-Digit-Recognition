package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import com.hdr.v2.workspace.WorkspaceService;
import com.hdr.v2.platform.PilotPolicy;
import com.hdr.v2.platform.RateLimiter;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

@Service
public class V2AuthService {
    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwords;
    private final V2TokenService tokens;
    private final WorkspaceService workspaces;
    private final String dummyPassword;
    private final PilotPolicy pilot;
    private final RateLimiter limiter;
    private final org.springframework.transaction.support.TransactionTemplate transaction;

    public V2AuthService(JdbcTemplate jdbc, PasswordEncoder passwords, V2TokenService tokens,
                         WorkspaceService workspaces, PilotPolicy pilot, RateLimiter limiter,
                         org.springframework.transaction.support.TransactionTemplate transaction) {
        this.jdbc = jdbc;
        this.passwords = passwords;
        this.tokens = tokens;
        this.workspaces = workspaces;
        this.pilot = pilot;
        this.limiter = limiter;
        this.transaction = transaction;
        this.dummyPassword = passwords.encode(UUID.randomUUID().toString());
    }

    @Transactional
    public AuthDtos.Session register(AuthDtos.RegisterRequest request) {
        pilot.requireRegistration(request.pilotCode());
        CredentialRules.validate(request.username(), 3, "用户名");
        CredentialRules.validate(request.password(), 6, "密码");
        String nickname = request.nickname() == null || request.nickname().isBlank() ? request.username() : request.nickname();
        String hash = passwords.encode(request.password());
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        try {
            jdbc.update(connection -> {
                PreparedStatement statement = connection.prepareStatement("""
                        INSERT INTO t_user(username,password,nickname,role,status,platform_role)
                        VALUES (?,?,?,'USER',1,'USER')
                        """, Statement.RETURN_GENERATED_KEYS);
                statement.setString(1, request.username());
                statement.setString(2, hash);
                statement.setString(3, nickname);
                return statement;
            }, key);
        } catch (DuplicateKeyException ex) {
            throw new V2Exception(409, "用户名已存在", "USERNAME_EXISTS");
        }
        Number generated = key.getKey();
        if (generated == null) throw new IllegalStateException("User ID was not generated");
        long userId = generated.longValue();
        WorkspaceService.Workspace personal = workspaces.createPersonal(userId, request.username());
        AuthDtos.User user = new AuthDtos.User(Long.toString(userId), request.username(), nickname, "USER");
        return session(userId, user, personal.id());
    }

    @Transactional
    public AuthDtos.Session login(AuthDtos.LoginRequest request) {
        List<StoredUser> users = jdbc.query("""
                SELECT id,username,password,nickname,platform_role,status,deleted FROM t_user
                WHERE username=? FOR UPDATE
                """, (rs, row) -> new StoredUser(rs.getLong("id"), rs.getString("username"), rs.getString("password"),
                rs.getString("nickname"), rs.getString("platform_role"), rs.getInt("status"), rs.getInt("deleted")), request.username());
        StoredUser user = users.isEmpty() ? null : users.get(0);
        boolean validPassword = passwords.matches(request.password(), user == null ? dummyPassword : user.password());
        if (user == null || !validPassword || user.status() != 1 || user.deleted() != 0) {
            throw new V2Exception(401, "用户名或密码错误，或账号已失效");
        }
        return session(user.id(), user.safe(), workspaces.defaultWorkspaceId(user.id()));
    }

    public V2Principal authenticate(String token) {
        V2TokenService.TokenIdentity identity = tokens.parse(token);
        List<V2Principal> principals = jdbc.query("""
                SELECT u.id,u.platform_role,s.id AS session_id
                FROM t_auth_session s JOIN t_user u ON u.id=s.user_id
                WHERE s.id=? AND s.user_id=? AND s.revoked=FALSE AND s.expires_at>UTC_TIMESTAMP()
                  AND u.status=1 AND u.deleted=0
                """, (rs, row) -> new V2Principal(rs.getLong("id"), rs.getString("session_id"), rs.getString("platform_role")),
                identity.sessionId(), identity.userId());
        if (principals.isEmpty()) throw new V2Exception(401, "登录已失效，请重新登录");
        return principals.get(0);
    }

    public AuthDtos.Me me(V2Principal principal) {
        List<AuthDtos.User> users = jdbc.query("""
                SELECT id,username,nickname,platform_role FROM t_user WHERE id=? AND status=1 AND deleted=0
                """, (rs, row) -> new AuthDtos.User(rs.getString("id"), rs.getString("username"),
                rs.getString("nickname"), rs.getString("platform_role")), principal.userId());
        if (users.isEmpty()) throw new V2Exception(401, "账号已失效");
        return new AuthDtos.Me(users.get(0), workspaces.defaultWorkspaceId(principal.userId()));
    }

    public void changePassword(V2Principal principal, AuthDtos.PasswordRequest request) {
        CredentialRules.validate(request.newPassword(), 6, "新密码");
        // Commit attempt counters before the password transaction: failed credentials
        // must not roll back the rate limit and enable unlimited guessing.
        limiter.check("password:user:" + principal.userId(), 5, 900);
        transaction.executeWithoutResult(status -> {
            List<String> hashes = jdbc.query("SELECT password FROM t_user WHERE id=? AND status=1 AND deleted=0 FOR UPDATE",
                    (rs, row) -> rs.getString(1), principal.userId());
            List<String> sessions = jdbc.query("SELECT id FROM t_auth_session WHERE id=? AND user_id=? AND revoked=FALSE AND expires_at>UTC_TIMESTAMP() FOR UPDATE",
                    (rs, row) -> rs.getString(1), principal.sessionId(), principal.userId());
            if (hashes.isEmpty() || sessions.isEmpty()) throw new V2Exception(401, "登录已失效，请重新登录");
            if (request.currentPassword() == null || !passwords.matches(request.currentPassword(), hashes.get(0))) {
                throw new V2Exception(400, "原密码不正确", "PASSWORD_MISMATCH");
            }
            jdbc.update("UPDATE t_user SET password=? WHERE id=?", passwords.encode(request.newPassword()), principal.userId());
            jdbc.update("UPDATE t_auth_session SET revoked=TRUE WHERE user_id=?", principal.userId());
        });
    }

    public void logout(V2Principal principal) {
        jdbc.update("UPDATE t_auth_session SET revoked=TRUE WHERE id=? AND user_id=?", principal.sessionId(), principal.userId());
    }

    private AuthDtos.Session session(long userId, AuthDtos.User user, String defaultWorkspaceId) {
        V2TokenService.IssuedToken issued = tokens.issue(userId);
        jdbc.update("INSERT INTO t_auth_session(id,user_id,expires_at) VALUES (?,?,?)", issued.sessionId(), userId,
                LocalDateTime.ofInstant(issued.expiresAt(), ZoneOffset.UTC));
        return new AuthDtos.Session(issued.token(), user, defaultWorkspaceId);
    }

    private record StoredUser(long id, String username, String password, String nickname, String platformRole, int status, int deleted) {
        AuthDtos.User safe() { return new AuthDtos.User(Long.toString(id), username, nickname, platformRole); }
    }
}
