-- 训练准备阶段的渲染/导出进度（0-100），worker 尽力上报，前端显示“准备数据 42%”。
ALTER TABLE t_v2_training_task ADD COLUMN prepare_progress INT NULL;
