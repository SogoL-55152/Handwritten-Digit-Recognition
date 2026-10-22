package com.hdr.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_dataset")
public class Dataset {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    /** MNIST / CUSTOM */
    private String type;

    private Integer sampleCount;

    private String storagePath;

    private String description;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
