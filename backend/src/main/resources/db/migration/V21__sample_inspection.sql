-- 样本巡检标记：NULL=未巡检，0=单字，1=疑似多位数（供人工确认删除）
ALTER TABLE t_collected_sample
    ADD COLUMN multi_digit TINYINT DEFAULT NULL AFTER source_dataset_id,
    ADD KEY idx_collected_multi_digit (multi_digit);
