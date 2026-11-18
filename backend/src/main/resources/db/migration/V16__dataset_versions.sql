-- 数据集版本与样本归属：把"采集到的样本"整理成可训练/可评估的集合。
-- 版本是快照：同一数据集可以有多版，每版固定样本与划分，便于复现训练。
CREATE TABLE t_v2_dataset_version (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    dataset_id BIGINT NOT NULL,
    version VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    split_rule VARCHAR(16) NOT NULL DEFAULT 'WRITER',
    sample_count INT NOT NULL DEFAULT 0,
    writer_count INT NOT NULL DEFAULT 0,
    val_percent INT NOT NULL DEFAULT 15,
    test_percent INT NOT NULL DEFAULT 15,
    created_by BIGINT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_dataset_version (dataset_id, version),
    KEY idx_version_dataset (dataset_id),
    CONSTRAINT fk_version_dataset FOREIGN KEY (dataset_id) REFERENCES t_v2_dataset (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE t_v2_dataset_sample (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    version_id BIGINT NOT NULL,
    sample_id BIGINT NOT NULL,
    split VARCHAR(8) NOT NULL,
    label VARCHAR(8) NOT NULL,
    kind VARCHAR(8) NOT NULL,
    writer_key VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_version_sample (version_id, sample_id),
    KEY idx_sample_version (version_id, split),
    CONSTRAINT fk_sample_version FOREIGN KEY (version_id) REFERENCES t_v2_dataset_version (id),
    CONSTRAINT fk_sample_collected FOREIGN KEY (sample_id) REFERENCES t_collected_sample (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
