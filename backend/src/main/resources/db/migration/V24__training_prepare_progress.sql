-- 训练任务准备数据进度：worker 导出/渲染阶段实时写回，前端在任务行展示百分比。
ALTER TABLE t_v2_training_task ADD COLUMN prepare_progress INT NULL;
