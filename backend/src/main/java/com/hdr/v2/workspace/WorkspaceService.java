package com.hdr.v2.workspace;

import com.hdr.v2.V2Exception;
import com.hdr.v2.platform.PilotPolicy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;

@Service
public class WorkspaceService {
    private static final String MEMBER_QUERY = """
            SELECT w.id,w.name,m.role,w.status,w.default_model_id
            FROM t_workspace w JOIN t_workspace_member m ON m.workspace_id=w.id
            JOIN t_user u ON u.id=m.user_id
            WHERE m.user_id=? AND m.status='ACTIVE' AND w.status='ACTIVE'
              AND u.status=1 AND u.deleted=0
            """;
    private static final RowMapper<Workspace> WORKSPACE = (rs, row) -> new Workspace(
            rs.getString("id"), rs.getString("name"), rs.getString("role"),
            rs.getString("status"), rs.getString("default_model_id"));
    private final JdbcTemplate jdbc;
    private final int maxWorkspaces;
    private final PilotPolicy pilot;

    @org.springframework.beans.factory.annotation.Autowired
    public WorkspaceService(JdbcTemplate jdbc, @Value("${hdr.v2.limits.max-workspaces:3}") int maxWorkspaces, PilotPolicy pilot) {
        if (maxWorkspaces < 1) throw new IllegalStateException("max-workspaces must be positive");
        this.jdbc = jdbc;
        this.maxWorkspaces = maxWorkspaces;
        this.pilot = pilot;
    }
    public WorkspaceService(JdbcTemplate jdbc, int maxWorkspaces) { this(jdbc, maxWorkspaces, new PilotPolicy(false, "")); }

    public List<Workspace> list(long userId) {
        return jdbc.query(MEMBER_QUERY + " ORDER BY (w.personal_user_id=m.user_id) DESC,w.id", WORKSPACE, userId);
    }

    public Workspace requireMember(long workspaceId, long userId) {
        List<Workspace> rows = jdbc.query(MEMBER_QUERY + " AND w.id=?", WORKSPACE, userId, workspaceId);
        if (rows.isEmpty()) throw new V2Exception(404, "空间不存在或不可访问");
        return rows.get(0);
    }

    public String defaultWorkspaceId(long userId) {
        List<Workspace> spaces = list(userId);
        return spaces.isEmpty() ? null : spaces.get(0).id();
    }

    @Transactional
    public Workspace create(long userId, String name) {
        pilot.requireWorkspaceCreation();
        validateName(name);
        // Serialize all creators for this owner; count+insert cannot overrun the cap.
        List<Long> owners = jdbc.query("SELECT id FROM t_user WHERE id=? AND status=1 AND deleted=0 FOR UPDATE",
                (rs, row) -> rs.getLong(1), userId);
        if (owners.isEmpty()) throw new V2Exception(401, "账号已失效");
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM t_workspace WHERE owner_id=?", Long.class, userId);
        if (count != null && count >= maxWorkspaces) throw new V2Exception(409, "已达到可创建空间数量上限", "WORKSPACE_LIMIT");
        return insert(userId, name.strip(), false);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public Workspace createPersonal(long userId, String username) {
        return insert(userId, username + " 的个人空间", true);
    }

    private Workspace insert(long userId, String name, boolean personal) {
        // The single ACTIVE public model is the only valid default; a missing one is a
        // configuration error rather than an orphan workspace.
        List<Long> models = jdbc.query("""
                SELECT id FROM t_v2_model WHERE scope='PUBLIC' AND status='ACTIVE'
                """, (rs, row) -> rs.getLong(1));
        if (models.isEmpty()) throw new V2Exception(503, "默认公共模型未就绪");
        long defaultModelId = models.get(0);
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO t_workspace(owner_id,name,personal_user_id,default_model_id) VALUES (?,?,?,?)",
                    Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, userId);
            statement.setString(2, name);
            if (personal) statement.setLong(3, userId); else statement.setNull(3, java.sql.Types.BIGINT);
            statement.setLong(4, defaultModelId);
            return statement;
        }, key);
        Number generated = key.getKey();
        if (generated == null) throw new IllegalStateException("Workspace ID was not generated");
        long workspaceId = generated.longValue();
        jdbc.update("INSERT INTO t_workspace_member(workspace_id,user_id,role) VALUES (?,?,'OWNER')", workspaceId, userId);
        return new Workspace(Long.toString(workspaceId), name, "OWNER", "ACTIVE", Long.toString(defaultModelId));
    }

    private void validateName(String name) {
        if (name == null || name.isBlank() || name.length() > 64) throw new V2Exception(400, "空间名称须为 1-64 个非空白字符");
    }

    public record Workspace(String id, String name, String role, String status, String defaultModelId) {}
}
