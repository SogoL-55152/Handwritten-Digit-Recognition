-- W1 ADMIN remains a legacy role; no existing account becomes SUPER_ADMIN.
ALTER TABLE t_user ADD COLUMN platform_role VARCHAR(16) NOT NULL DEFAULT 'USER',
    ADD CONSTRAINT ck_user_platform_role CHECK (platform_role IN ('USER', 'SUPER_ADMIN'));

CREATE TABLE t_v2_model (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scope VARCHAR(16) NOT NULL,
    workspace_id BIGINT DEFAULT NULL,
    external_id VARCHAR(64) NOT NULL,
    accuracy DOUBLE DEFAULT NULL,
    accuracy_dataset VARCHAR(64) DEFAULT NULL,
    preprocess_version VARCHAR(64) NOT NULL,
    description VARCHAR(255) DEFAULT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_v2_model_scope CHECK ((scope = 'PUBLIC' AND workspace_id IS NULL)
        OR (scope = 'WORKSPACE' AND workspace_id IS NOT NULL)),
    CONSTRAINT ck_v2_model_accuracy CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 1)),
    KEY idx_v2_model_workspace (workspace_id, status),
    KEY idx_v2_model_external (external_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_workspace (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    name VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    personal_user_id BIGINT DEFAULT NULL,
    default_model_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_workspace_personal (personal_user_id),
    KEY idx_workspace_owner (owner_id),
    CONSTRAINT fk_workspace_owner FOREIGN KEY (owner_id) REFERENCES t_user(id),
    CONSTRAINT fk_workspace_personal FOREIGN KEY (personal_user_id) REFERENCES t_user(id),
    CONSTRAINT fk_workspace_default_model FOREIGN KEY (default_model_id) REFERENCES t_v2_model(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE t_v2_model ADD CONSTRAINT fk_v2_model_workspace
    FOREIGN KEY (workspace_id) REFERENCES t_workspace(id);

CREATE TABLE t_workspace_member (
    workspace_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id),
    KEY idx_member_user (user_id, status, workspace_id),
    CONSTRAINT ck_workspace_role CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    CONSTRAINT fk_member_workspace FOREIGN KEY (workspace_id) REFERENCES t_workspace(id),
    CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES t_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_auth_session (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_session_user (user_id, revoked),
    KEY idx_session_expiry (expires_at),
    CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES t_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_v2_dataset (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scope VARCHAR(16) NOT NULL,
    workspace_id BIGINT DEFAULT NULL,
    train_samples INT NOT NULL,
    test_samples INT NOT NULL,
    description VARCHAR(255) DEFAULT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_v2_dataset_scope CHECK ((scope = 'PUBLIC' AND workspace_id IS NULL)
        OR (scope = 'WORKSPACE' AND workspace_id IS NOT NULL)),
    CONSTRAINT ck_v2_dataset_samples CHECK (train_samples >= 0 AND test_samples >= 0),
    KEY idx_v2_dataset_workspace (workspace_id, status),
    CONSTRAINT fk_v2_dataset_workspace FOREIGN KEY (workspace_id) REFERENCES t_workspace(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Only this explicitly trusted metadata is public. W1 assets are not imported.
INSERT INTO t_v2_model
    (id, name, version, scope, external_id, accuracy, accuracy_dataset, preprocess_version, description)
VALUES (1, 'MNIST CNN W1', 'w1-full-3epoch', 'PUBLIC', 'mnist-cnn-w1', 0.991,
    'MNIST test', 'canvas-mnist-v1', 'W1 full baseline; MNIST test accuracy, not online accuracy');
INSERT INTO t_v2_dataset (id, name, version, scope, train_samples, test_samples, description)
VALUES (1, 'MNIST', 'mnist-original', 'PUBLIC', 60000, 10000, 'Public MNIST metadata; no data upload or training API in W2');

-- Backfill every nondeleted W1 account, including disabled accounts (auth still rejects them).
INSERT INTO t_workspace (owner_id, name, personal_user_id, default_model_id)
SELECT id, CONCAT(LEFT(COALESCE(NULLIF(nickname, ''), username), 58), ' 的个人空间'), id, 1
FROM t_user WHERE deleted = 0 ORDER BY id;
INSERT INTO t_workspace_member (workspace_id, user_id, role)
SELECT id, owner_id, 'OWNER' FROM t_workspace WHERE personal_user_id IS NOT NULL;
