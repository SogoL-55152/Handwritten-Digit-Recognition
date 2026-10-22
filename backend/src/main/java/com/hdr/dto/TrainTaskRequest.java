package com.hdr.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.util.Map;

public record TrainTaskRequest(
        @NotBlank(message = "任务名称不能为空") String name,
        @NotNull(message = "请选择数据集") Long datasetId,
        @NotBlank(message = "模型名称不能为空") String modelName,
        Map<String, Object> params
) {
}
