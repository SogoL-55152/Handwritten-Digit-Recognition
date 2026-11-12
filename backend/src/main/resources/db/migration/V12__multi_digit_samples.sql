-- 多位数样本：用户自己输入整串，不再只支持 0–9 单字标签。
ALTER TABLE t_collected_sample
    ADD COLUMN sample_kind VARCHAR(8) NOT NULL DEFAULT 'SINGLE' AFTER label,
    ADD COLUMN label_text VARCHAR(8) DEFAULT NULL AFTER sample_kind,
    ADD COLUMN predicted_text VARCHAR(8) DEFAULT NULL AFTER predicted_digit,
    ADD COLUMN digit_count TINYINT DEFAULT NULL AFTER predicted_text;

-- label 现在允许为空（多位数样本用 label_text），原 CHECK 对 NULL 视为 UNKNOWN，仍然放行。
