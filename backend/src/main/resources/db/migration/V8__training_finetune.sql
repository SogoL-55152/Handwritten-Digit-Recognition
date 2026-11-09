-- W4 微调：记录本次训练是从哪个已注册模型初始化的（NULL = 从零训练）。
-- 只为可追溯，不作为外键：模型行允许后续停用/删除，历史任务仍需保留版本字符串。
ALTER TABLE t_v2_training_task
    ADD COLUMN init_from VARCHAR(64) DEFAULT NULL AFTER use_emnist;
