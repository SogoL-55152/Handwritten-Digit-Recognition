-- 识别原图落盘（按摘要去重，仅本人可见）。旧记录没有图，详情里显示“未保存图片”。
ALTER TABLE t_recognition_v2
    ADD COLUMN image_path VARCHAR(255) DEFAULT NULL AFTER image_digest,
    ADD COLUMN image_type VARCHAR(32) DEFAULT NULL AFTER image_path;
