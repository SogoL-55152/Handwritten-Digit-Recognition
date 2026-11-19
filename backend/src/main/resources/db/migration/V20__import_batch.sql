-- 导入批次：记录每次「智能导入」的来源、格式、统计，支持回滚。
CREATE TABLE t_import_batch (
    id BIGINT NOT NULL AUTO_INCREMENT,
    workspace_id BIGINT NOT NULL,
    dataset_id BIGINT NOT NULL,
    format VARCHAR(16) NOT NULL,
    source VARCHAR(512) NOT NULL,
    imported INT NOT NULL DEFAULT 0,
    skipped INT NOT NULL DEFAULT 0,
    skipped_detail VARCHAR(1024) DEFAULT NULL,
    created_by BIGINT NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_import_batch_dataset (dataset_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE t_collected_sample
    ADD COLUMN import_batch_id BIGINT DEFAULT NULL AFTER imported_at,
    ADD KEY idx_collected_batch (import_batch_id);
