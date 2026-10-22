-- 手写数字识别系统数据库结构（MySQL 8.0）
-- 所有建表语句幂等，可在应用启动时重复执行。

CREATE TABLE IF NOT EXISTS t_user (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(64)  NOT NULL,
    password   VARCHAR(100) NOT NULL,
    nickname   VARCHAR(64)  DEFAULT NULL,
    role       VARCHAR(16)  NOT NULL DEFAULT 'USER',
    status     TINYINT      NOT NULL DEFAULT 1,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted    TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_username (username)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS t_model (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    version     VARCHAR(64)  DEFAULT NULL,
    external_id VARCHAR(64)  DEFAULT NULL,
    file_path   VARCHAR(255) DEFAULT NULL,
    accuracy    DOUBLE       DEFAULT NULL,
    is_active   TINYINT      NOT NULL DEFAULT 0,
    description VARCHAR(255) DEFAULT NULL,
    created_by  BIGINT       DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_external_id (external_id),
    KEY idx_active (is_active)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS t_dataset (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(64)  NOT NULL,
    type         VARCHAR(16)  NOT NULL DEFAULT 'MNIST',
    sample_count INT          NOT NULL DEFAULT 0,
    storage_path VARCHAR(255) DEFAULT NULL,
    description  VARCHAR(255) DEFAULT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted      TINYINT      NOT NULL DEFAULT 0
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS t_train_task (
    id               BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(64)  NOT NULL,
    dataset_id       BIGINT       NOT NULL,
    model_name       VARCHAR(64)  NOT NULL,
    params_json      TEXT         DEFAULT NULL,
    status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    progress         INT          NOT NULL DEFAULT 0,
    external_task_id VARCHAR(64)  DEFAULT NULL,
    model_id         BIGINT       DEFAULT NULL,
    error_msg        VARCHAR(500) DEFAULT NULL,
    created_by       BIGINT       DEFAULT NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted          TINYINT      NOT NULL DEFAULT 0,
    KEY idx_dataset_id (dataset_id),
    KEY idx_status (status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS t_recognition_log (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT       DEFAULT NULL,
    model_id   BIGINT       DEFAULT NULL,
    result     VARCHAR(64)  DEFAULT NULL,
    confidence DOUBLE       DEFAULT NULL,
    cost_ms    INT          DEFAULT NULL,
    image_path VARCHAR(255) DEFAULT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_created_at (created_at),
    KEY idx_model_id (model_id),
    KEY idx_user_id (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
