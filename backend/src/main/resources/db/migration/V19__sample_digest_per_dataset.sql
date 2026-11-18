-- 去重范围从“工作空间”改为“数据集”：同一张图可以分别导入不同数据集。
-- source_dataset_id 为 NULL 表示识别页采集（没有归属），按原逻辑去重。
-- 注意：fk_collected_workspace 依赖旧唯一索引的最左列，先补一个普通索引再换。
ALTER TABLE t_collected_sample ADD KEY idx_collected_workspace (workspace_id);
ALTER TABLE t_collected_sample DROP INDEX uk_collected_digest;
ALTER TABLE t_collected_sample
    ADD UNIQUE KEY uk_collected_digest (workspace_id, creator_id, image_digest, source_dataset_id);
