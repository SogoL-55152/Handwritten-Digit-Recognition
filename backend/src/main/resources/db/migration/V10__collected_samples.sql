-- 用户主动标注并同意采集的样本（W6 自采数据的产品化入口）。
-- 只保存 consent=1 的样本；同一用户同一图片按摘要去重，重复提交不新增行。
CREATE TABLE t_collected_sample (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT NOT NULL,
    creator_id BIGINT NOT NULL,
    recognition_id BIGINT DEFAULT NULL,
    label TINYINT NOT NULL,
    predicted_digit TINYINT DEFAULT NULL,
    confidence DOUBLE DEFAULT NULL,
    model_version VARCHAR(64) DEFAULT NULL,
    source VARCHAR(16) NOT NULL DEFAULT 'WEB',
    image_digest CHAR(64) NOT NULL,
    artifact_path VARCHAR(255) NOT NULL,
    size_bytes INT NOT NULL,
    content_type VARCHAR(32) NOT NULL,
    consent TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_collected_digest (workspace_id, creator_id, image_digest),
    KEY idx_collected_user (creator_id, created_at),
    CONSTRAINT fk_collected_workspace FOREIGN KEY (workspace_id) REFERENCES t_workspace (id),
    CONSTRAINT fk_collected_user FOREIGN KEY (creator_id) REFERENCES t_user (id),
    CONSTRAINT chk_collected_label CHECK (label BETWEEN 0 AND 9),
    CONSTRAINT chk_collected_consent CHECK (consent = 1)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
