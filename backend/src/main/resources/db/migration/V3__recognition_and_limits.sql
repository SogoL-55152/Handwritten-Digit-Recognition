CREATE TABLE t_recognition_v2 (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT NOT NULL,
    creator_id BIGINT NOT NULL,
    request_id CHAR(36) NOT NULL,
    image_digest CHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL,
    model_id BIGINT NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    preprocess_version VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PROCESSING',
    digit TINYINT NULL,
    confidence DOUBLE NULL,
    processing_ms BIGINT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_recognition_request (workspace_id, creator_id, request_id),
    KEY idx_recognition_owner (workspace_id, creator_id, created_at),
    CONSTRAINT fk_recognition_workspace FOREIGN KEY (workspace_id) REFERENCES t_workspace(id),
    CONSTRAINT fk_recognition_user FOREIGN KEY (creator_id) REFERENCES t_user(id),
    CONSTRAINT fk_recognition_model FOREIGN KEY (model_id) REFERENCES t_v2_model(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_rate_window (
    bucket_key CHAR(64) NOT NULL,
    window_start BIGINT NOT NULL,
    hits BIGINT NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (bucket_key, window_start),
    KEY idx_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
