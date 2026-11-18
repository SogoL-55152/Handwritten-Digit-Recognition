-- 训练任务可以引用数据集版本：样本由后端导出成 PNG 目录，模型服务直接读取。
ALTER TABLE t_v2_training_task
    ADD COLUMN dataset_version_id BIGINT DEFAULT NULL AFTER dataset_id,
    ADD COLUMN data_dir VARCHAR(255) DEFAULT NULL AFTER dataset_version_id;
