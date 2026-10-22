package com.hdr.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.client.ModelServiceClient;
import com.hdr.common.BusinessException;
import com.hdr.common.PageResult;
import com.hdr.dto.TrainTaskRequest;
import com.hdr.entity.Dataset;
import com.hdr.entity.ModelInfo;
import com.hdr.entity.TrainTask;
import com.hdr.mapper.DatasetMapper;
import com.hdr.mapper.TrainTaskMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class TrainTaskService {

    private final TrainTaskMapper taskMapper;
    private final DatasetMapper datasetMapper;
    private final ModelService modelService;
    private final ModelServiceClient modelServiceClient;
    private final ObjectMapper objectMapper;

    public TrainTask create(TrainTaskRequest request, Long userId) {
        Dataset dataset = datasetMapper.selectById(request.datasetId());
        if (dataset == null) {
            throw new BusinessException(404, "数据集不存在");
        }

        Map<String, Object> params = request.params() == null ? Map.of() : request.params();

        TrainTask task = new TrainTask();
        task.setName(request.name());
        task.setDatasetId(request.datasetId());
        task.setModelName(request.modelName());
        task.setStatus("PENDING");
        task.setProgress(0);
        task.setCreatedBy(userId);
        try {
            task.setParamsJson(objectMapper.writeValueAsString(params));
        } catch (JsonProcessingException e) {
            throw new BusinessException(400, "训练参数格式错误");
        }
        taskMapper.insert(task);

        String externalId = UUID.randomUUID().toString().replace("-", "");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("task_id", externalId);
        payload.put("model_name", request.modelName());
        payload.put("dataset", StringUtils.hasText(dataset.getType()) ? dataset.getType() : "MNIST");
        payload.put("params", params);

        try {
            Map<String, Object> data = modelServiceClient.startTraining(payload);
            Object returnedId = data.get("task_id");
            task.setExternalTaskId(returnedId == null ? externalId : String.valueOf(returnedId));
            task.setStatus("RUNNING");
            taskMapper.updateById(task);
            log.info("Started training task {} -> external {}", task.getId(), task.getExternalTaskId());
        } catch (RuntimeException e) {
            task.setStatus("FAILED");
            task.setErrorMsg(truncate("启动训练失败：" + e.getMessage()));
            taskMapper.updateById(task);
            throw new BusinessException(502, "训练任务启动失败：" + e.getMessage());
        }
        return task;
    }

    public PageResult<TrainTask> page(long page, long size) {
        Page<TrainTask> result = taskMapper.selectPage(new Page<>(page, size),
                Wrappers.<TrainTask>lambdaQuery().orderByDesc(TrainTask::getId));
        return PageResult.of(result.getRecords(), result.getTotal(), page, size);
    }

    public TrainTask get(Long id) {
        TrainTask task = taskMapper.selectById(id);
        if (task == null) {
            throw new BusinessException(404, "训练任务不存在");
        }
        return task;
    }

    /**
     * 拉取训练进度与指标；成功时把产出模型登记到业务库。
     * 前端当前使用 2s 轮询，W5 可替换为 SSE。
     */
    public Map<String, Object> metrics(Long id) {
        TrainTask task = get(id);
        if (!StringUtils.hasText(task.getExternalTaskId())) {
            return localSnapshot(task);
        }

        Map<String, Object> remote;
        try {
            remote = modelServiceClient.getTraining(task.getExternalTaskId());
        } catch (RuntimeException e) {
            Map<String, Object> snapshot = localSnapshot(task);
            snapshot.put("error", "模型服务暂时不可用：" + e.getMessage());
            return snapshot;
        }

        String status = String.valueOf(remote.getOrDefault("status", task.getStatus()));
        int progress = asInt(remote.get("progress"),
                task.getProgress() == null ? 0 : task.getProgress());

        if ("SUCCESS".equals(status) && task.getModelId() == null) {
            registerTrainedModel(task, remote);
        } else if (!Objects.equals(task.getStatus(), status)
                || !Objects.equals(task.getProgress(), progress)) {
            task.setStatus(status);
            task.setProgress(progress);
            Object error = remote.get("error");
            if (error != null) {
                task.setErrorMsg(truncate(String.valueOf(error)));
            }
            taskMapper.updateById(task);
        }
        return remote;
    }

    private void registerTrainedModel(TrainTask task, Map<String, Object> remote) {
        if (!(remote.get("model") instanceof Map<?, ?> rawModel)) {
            return;
        }
        Map<String, Object> model = new LinkedHashMap<>();
        rawModel.forEach((key, value) -> model.put(String.valueOf(key), value));

        String externalId = String.valueOf(model.getOrDefault("id", task.getExternalTaskId()));
        String name = String.valueOf(model.getOrDefault("name", task.getModelName()));
        String path = String.valueOf(model.getOrDefault("path", ""));
        double accuracy = model.get("accuracy") instanceof Number number ? number.doubleValue() : 0d;

        ModelInfo created = modelService.createFromTraining(name, externalId, path, accuracy);
        if (modelService.activeOrNull() == null) {
            try {
                // 模型服务会把首个训练产物默认设为活跃，这里同步业务库状态
                modelService.activate(created.getId());
            } catch (RuntimeException e) {
                log.warn("Failed to sync default active model: {}", e.getMessage());
            }
        }
        task.setStatus("SUCCESS");
        task.setProgress(100);
        task.setModelId(created.getId());
        taskMapper.updateById(task);
        log.info("Training task {} finished, model {} registered", task.getId(), created.getId());
    }

    private Map<String, Object> localSnapshot(TrainTask task) {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("status", task.getStatus());
        snapshot.put("progress", task.getProgress() == null ? 0 : task.getProgress());
        snapshot.put("metrics", List.of());
        if (StringUtils.hasText(task.getErrorMsg())) {
            snapshot.put("error", task.getErrorMsg());
        }
        return snapshot;
    }

    private static int asInt(Object value, int defaultValue) {
        return value instanceof Number number ? number.intValue() : defaultValue;
    }

    private static String truncate(String value) {
        if (value == null) {
            return null;
        }
        return value.length() <= 500 ? value : value.substring(0, 500);
    }
}
