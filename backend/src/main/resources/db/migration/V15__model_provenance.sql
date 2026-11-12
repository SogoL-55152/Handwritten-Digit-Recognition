-- 模型来源（provenance）：让模型管理页能看出每个模型是怎么来的。
-- BUILTIN=随项目提供的基线；TRAINED=训练任务产出；FINE_TUNED=基于已有模型微调；IMPORTED=手工注册导入
ALTER TABLE t_v2_model
    ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'IMPORTED' AFTER artifact,
    ADD COLUMN task_id BIGINT DEFAULT NULL AFTER origin,
    ADD COLUMN init_from VARCHAR(64) DEFAULT NULL AFTER task_id,
    ADD COLUMN trained_at DATETIME DEFAULT NULL AFTER init_from;

-- 历史回填：训练任务产出的模型按 model_version 对上任务
UPDATE t_v2_model m
JOIN t_v2_training_task t ON t.model_version = m.version
SET m.origin = IF(t.init_from IS NULL OR t.init_from = '', 'TRAINED', 'FINE_TUNED'),
    m.task_id = t.id,
    m.init_from = t.init_from,
    m.trained_at = t.finished_at
WHERE m.scope = 'PUBLIC';

-- 没有对应任务的 w2-* 视为项目自带基线
UPDATE t_v2_model
SET origin = 'BUILTIN'
WHERE scope = 'PUBLIC' AND task_id IS NULL AND version LIKE 'w2-%';
