package com.hdr.dto;

public record PredictResult(String result, Double confidence, String modelName, Long costMs) {
}
