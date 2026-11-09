-- W3 model management: a model row now carries its artifact identity, and the
-- database itself guarantees that at most one PUBLIC model is ACTIVE.
-- Generated column + unique index: NULL markers never collide, so any number of
-- disabled/draft rows coexist while only one ACTIVE PUBLIC row can exist.
ALTER TABLE t_v2_model
    ADD COLUMN sha256 CHAR(64) NULL,
    ADD COLUMN size_bytes BIGINT NULL,
    ADD COLUMN artifact VARCHAR(128) NULL,
    ADD COLUMN active_marker TINYINT GENERATED ALWAYS AS (
        CASE WHEN scope = 'PUBLIC' AND status = 'ACTIVE' THEN 1 ELSE NULL END
    ) STORED,
    ADD COLUMN public_key VARCHAR(160) GENERATED ALWAYS AS (
        CASE WHEN scope = 'PUBLIC' THEN CONCAT(external_id, ':', version) ELSE NULL END
    ) STORED,
    ADD UNIQUE KEY uq_v2_model_single_active (scope, active_marker),
    ADD UNIQUE KEY uq_v2_model_public_version (public_key);

-- Backfill the current trusted model artifact (see docs/照片导入修复与基线切换-20261107.md).
UPDATE t_v2_model
SET sha256 = '72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa',
    size_bytes = 1690340,
    artifact = 'w2-canvas-photo/checkpoint.pt',
    status = 'ACTIVE'
WHERE id = 1 AND external_id = 'mnist-cnn-w1';

-- Existing recognitions keep their historical model_version; no row rewrite.
