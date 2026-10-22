package com.hdr.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_recognition_log")
public class RecognitionLog {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long modelId;

    private String result;

    private Double confidence;

    private Integer costMs;

    private String imagePath;

    private LocalDateTime createdAt;
}
