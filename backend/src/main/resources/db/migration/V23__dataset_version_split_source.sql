-- 版本合并时可沿用来源版本的划分：记录"划分来自哪个版本"，便于追溯与对比。
ALTER TABLE t_v2_dataset_version
    ADD COLUMN split_source_id BIGINT DEFAULT NULL AFTER test_percent,
    ADD KEY idx_dataset_version_split_source (split_source_id);
