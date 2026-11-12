-- 多位数结果落库（方案 B）：status 只表示有没有跑完，accepted 表示结果能不能用。
-- digit 保持 NULL（多位数的单字语义不存在），整串存 result_text，逐位明细存 digits_json。
ALTER TABLE t_recognition_v2
    ADD COLUMN result_text VARCHAR(8) DEFAULT NULL AFTER digit,
    ADD COLUMN digits_json JSON DEFAULT NULL AFTER result_text,
    ADD COLUMN accepted TINYINT(1) NOT NULL DEFAULT 0 AFTER digits_json;

-- 历史单字记录：能给出数字的就是可接受的结果
UPDATE t_recognition_v2 SET accepted = 1 WHERE status = 'SUCCEEDED';
