-- 异步导入任务：一次「智能导入」变成一个可查询进度、可取消的后台任务。
-- 与 t_import_batch 的关系：任务成功后会把 import_batch_id 指向它产生的批次，
-- 因此回滚仍然走既有的批次回滚接口，不新增第二套回滚逻辑。
CREATE TABLE t_import_job (
    id BIGINT NOT NULL AUTO_INCREMENT,
    workspace_id BIGINT NOT NULL,
    dataset_id BIGINT NOT NULL,
    -- DIRECTORY=服务器目录 / ZIP=已解压的 zip 临时目录 / UPLOAD=浏览器上传的临时目录
    source_kind VARCHAR(16) NOT NULL,
    -- 绝对路径；ZIP/UPLOAD 在任务结束后（无论成败）会被删除
    directory VARCHAR(1000) NOT NULL,
    file_column VARCHAR(128) DEFAULT NULL,
    label_column VARCHAR(128) DEFAULT NULL,
    -- 1=任务结束后删除 directory
    cleanup TINYINT NOT NULL DEFAULT 0,
    -- QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELED
    status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    -- 扫描完成后写入总文件数；扫描期间为 0，前端据此显示"正在扫描"
    progress_total INT NOT NULL DEFAULT 0,
    progress_done INT NOT NULL DEFAULT 0,
    imported INT NOT NULL DEFAULT 0,
    duplicates INT NOT NULL DEFAULT 0,
    failed INT NOT NULL DEFAULT 0,
    error_message VARCHAR(1000) DEFAULT NULL,
    import_batch_id BIGINT DEFAULT NULL,
    -- 取消是协作式的：只置标记，由任务循环在下一个文件前停下
    cancel_requested TINYINT NOT NULL DEFAULT 0,
    created_by BIGINT NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at TIMESTAMP(3) NULL DEFAULT NULL,
    finished_at TIMESTAMP(3) NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_import_job_workspace (workspace_id, id),
    KEY idx_import_job_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
