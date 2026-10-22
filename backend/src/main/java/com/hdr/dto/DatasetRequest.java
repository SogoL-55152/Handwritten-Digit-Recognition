package com.hdr.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

public record DatasetRequest(
        @NotBlank(message = "数据集名称不能为空")
        @Size(max = 64, message = "数据集名称最长 64 个字符")
        String name,

        String type,

        @PositiveOrZero(message = "样本数不能为负数")
        Integer sampleCount,

        String storagePath,

        @Size(max = 255, message = "描述最长 255 个字符")
        String description
) {
}
