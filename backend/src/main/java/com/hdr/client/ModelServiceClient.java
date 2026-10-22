package com.hdr.client;

import com.hdr.common.BusinessException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 调用 Flask 模型服务的内部客户端。所有方法返回响应体中的 data。
 */
@Component
public class ModelServiceClient {

    private static final ParameterizedTypeReference<Map<String, Object>> MAP_TYPE =
            new ParameterizedTypeReference<>() {
            };

    private final RestClient restClient;

    public ModelServiceClient(@Value("${hdr.model-service.base-url}") String baseUrl) {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(3_000);
        requestFactory.setReadTimeout(30_000);
        this.restClient = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(requestFactory)
                .build();
    }

    public Map<String, Object> startTraining(Map<String, Object> payload) {
        return call(() -> restClient.post()
                .uri("/api/v1/train")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(MAP_TYPE));
    }

    public Map<String, Object> getTraining(String externalTaskId) {
        return call(() -> restClient.get()
                .uri("/api/v1/train/{id}", externalTaskId)
                .retrieve()
                .body(MAP_TYPE));
    }

    public Map<String, Object> activateModel(String externalId) {
        return call(() -> restClient.post()
                .uri("/api/v1/models/{id}/activate", externalId)
                .retrieve()
                .body(MAP_TYPE));
    }

    public Map<String, Object> predict(MultipartFile file) {
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        try {
            byte[] bytes = file.getBytes();
            body.add("file", new ByteArrayResource(bytes) {
                @Override
                public String getFilename() {
                    String name = file.getOriginalFilename();
                    return name == null || name.isBlank() ? "canvas.png" : name;
                }
            });
        } catch (IOException e) {
            throw new BusinessException(500, "读取上传图片失败");
        }

        return call(() -> restClient.post()
                .uri("/api/v1/predict")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(body)
                .retrieve()
                .body(MAP_TYPE));
    }

    /**
     * 统一把连接失败、5xx 等底层异常转换为 502，便于前端展示。
     */
    private Map<String, Object> call(Supplier<Map<String, Object>> supplier) {
        try {
            return unwrap(supplier.get());
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException(502, "模型服务不可用：" + e.getMessage());
        }
    }

    private Map<String, Object> unwrap(Map<String, Object> response) {
        if (response == null) {
            throw new BusinessException(502, "模型服务无响应");
        }
        if (!response.containsKey("code")) {
            return response;
        }
        Object code = response.get("code");
        int codeValue = code instanceof Number number ? number.intValue() : -1;
        if (codeValue != 0) {
            throw new BusinessException(502,
                    String.valueOf(response.getOrDefault("message", "模型服务调用失败")));
        }
        Object data = response.get("data");
        if (data instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            return typed;
        }
        return new LinkedHashMap<>();
    }
}
