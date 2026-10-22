package com.hdr.service;

import com.hdr.client.ModelServiceClient;
import com.hdr.common.BusinessException;
import com.hdr.dto.PredictResult;
import com.hdr.entity.ModelInfo;
import com.hdr.entity.RecognitionLog;
import com.hdr.mapper.RecognitionLogMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class RecognitionService {

    private final ModelServiceClient modelServiceClient;
    private final ModelService modelService;
    private final RecognitionLogMapper recognitionLogMapper;

    public PredictResult predict(MultipartFile file, Long userId) {
        if (file == null || file.isEmpty()) {
            throw new BusinessException(400, "请上传手写图片");
        }

        long startedAt = System.currentTimeMillis();
        Map<String, Object> data = modelServiceClient.predict(file);

        String result = String.valueOf(data.getOrDefault("result", ""));
        double confidence = data.get("confidence") instanceof Number number ? number.doubleValue() : 0d;
        String modelName = String.valueOf(data.getOrDefault("model_name", "unknown"));
        long costMs = System.currentTimeMillis() - startedAt;

        ModelInfo active = modelService.activeOrNull();
        RecognitionLog logEntity = new RecognitionLog();
        logEntity.setUserId(userId);
        logEntity.setModelId(active == null ? null : active.getId());
        logEntity.setResult(result);
        logEntity.setConfidence(confidence);
        logEntity.setCostMs((int) costMs);
        try {
            recognitionLogMapper.insert(logEntity);
        } catch (Exception e) {
            // 日志记录失败不应影响识别结果返回
            log.warn("Failed to persist recognition log", e);
        }

        return new PredictResult(result, confidence, modelName, costMs);
    }
}
