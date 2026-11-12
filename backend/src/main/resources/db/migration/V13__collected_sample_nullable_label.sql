-- 多位数样本不需要单字标签：label 允许为空（V10 建表时是 NOT NULL）。
ALTER TABLE t_collected_sample
    MODIFY COLUMN label TINYINT DEFAULT NULL;
