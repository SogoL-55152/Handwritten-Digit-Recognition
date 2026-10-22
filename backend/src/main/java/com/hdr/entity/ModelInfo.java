package com.hdr.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_model")
public class ModelInfo {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String version;

    /** 模型服务注册表中的 ID */
    private String externalId;

    private String filePath;

    private Double accuracy;

    /** 1 活跃 / 0 非活跃，全局仅一个 1 */
    @TableField("is_active")
    private Integer active;

    private String description;

    private Long createdBy;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
