-- W5 统计：区分"策略拒识"和"服务失败"，否则统计只能把它们混成 FAILED。
-- NULL 表示未失败；失败时写入 V2Exception 的 category（如 UNRECOGNIZED_INPUT、MODEL_UNAVAILABLE）。
ALTER TABLE t_recognition_v2
    ADD COLUMN failure_code VARCHAR(32) DEFAULT NULL AFTER processing_ms,
    ADD KEY idx_recognition_status (workspace_id, status, created_at);
