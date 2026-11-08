-- W4 训练任务：任务状态机、参数快照与产物指针。
-- 参数在创建时落库（快照），之后修改默认值不影响历史任务；产物摘要由服务端计算。
CREATE TABLE t_v2_training_task (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    creator_id BIGINT NOT NULL,
    dataset_id BIGINT NOT NULL,
    target_model_id BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL,
    attempt INT NOT NULL DEFAULT 0,
    epochs INT NOT NULL,
    batch_size INT NOT NULL,
    learning_rate DOUBLE NOT NULL,
    seed BIGINT NOT NULL,
    photo_ratio DECIMAL(3,2) NOT NULL,
    use_emnist TINYINT NOT NULL DEFAULT 0,
    samples INT NOT NULL,
    celery_task_id VARCHAR(64) DEFAULT NULL,
    model_version VARCHAR(64) DEFAULT NULL,
    artifact VARCHAR(191) DEFAULT NULL,
    sha256 CHAR(64) DEFAULT NULL,
    size_bytes BIGINT DEFAULT NULL,
    metrics JSON DEFAULT NULL,
    error_category VARCHAR(32) DEFAULT NULL,
    error_message VARCHAR(255) DEFAULT NULL,
    queued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME DEFAULT NULL,
    finished_at DATETIME DEFAULT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_training_creator FOREIGN KEY (creator_id) REFERENCES t_user (id),
    CONSTRAINT fk_training_dataset FOREIGN KEY (dataset_id) REFERENCES t_v2_dataset (id),
    CONSTRAINT fk_training_model FOREIGN KEY (target_model_id) REFERENCES t_v2_model (id),
    CONSTRAINT ck_training_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
    CONSTRAINT ck_training_attempt CHECK (attempt >= 0),
    UNIQUE KEY uk_training_celery (celery_task_id),
    KEY idx_training_status (status, updated_at),
    KEY idx_training_creator (creator_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 每轮指标单独成行，供 W5 曲线直接读取；W4 只用任务行的 metrics 汇总。
CREATE TABLE t_v2_training_metric (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL,
    attempt INT NOT NULL,
    epoch INT NOT NULL,
    loss DOUBLE DEFAULT NULL,
    raw_mnist DOUBLE DEFAULT NULL,
    canvas_simulated DOUBLE DEFAULT NULL,
    photo_simulated DOUBLE DEFAULT NULL,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_metric_task FOREIGN KEY (task_id) REFERENCES t_v2_training_task (id),
    UNIQUE KEY uk_metric_task_attempt_epoch (task_id, attempt, epoch)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
