-- 样本来源：导入的外部图片记下它进入的数据集；导入时间用于审计。
ALTER TABLE t_collected_sample
    ADD COLUMN source_dataset_id BIGINT DEFAULT NULL AFTER source,
    ADD COLUMN imported_at DATETIME DEFAULT NULL AFTER source_dataset_id;
