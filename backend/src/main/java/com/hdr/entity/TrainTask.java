package com.hdr.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_train_task")
public class TrainTask {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private Long datasetId;

    private String modelName;

    /** 超参数 JSON */
    private String paramsJson;

    /** PENDING / RUNNING / SUCCESS / FAILED */
    private String status;

    private Integer progress;

    /** 模型服务 / Celery 任务 ID */
    private String externalTaskId;

    /** 训练产出的业务模型 ID */
    private Long modelId;

    private String errorMsg;

    private Long createdBy;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
