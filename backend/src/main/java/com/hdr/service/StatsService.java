package com.hdr.service;

import com.hdr.entity.ModelInfo;
import com.hdr.mapper.ModelInfoMapper;
import com.hdr.mapper.RecognitionLogMapper;
import com.hdr.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class StatsService {

    private final UserMapper userMapper;
    private final ModelInfoMapper modelMapper;
    private final RecognitionLogMapper recognitionLogMapper;
    private final ModelService modelService;

    public Map<String, Object> overview() {
        ModelInfo active = modelService.activeOrNull();
        Double accuracy = modelMapper.averageAccuracy();

        Map<String, Object> overview = new LinkedHashMap<>();
        overview.put("userCount", userMapper.selectCount(null));
        overview.put("modelCount", modelMapper.selectCount(null));
        overview.put("callCount", recognitionLogMapper.selectCount(null));
        overview.put("accuracy", accuracy == null ? 0d : accuracy);
        overview.put("activeModel", active == null ? null : active.getName());
        return overview;
    }

    public List<Map<String, Object>> callTrend() {
        return recognitionLogMapper.countByDay();
    }

    public List<Map<String, Object>> modelUsage() {
        return recognitionLogMapper.countByModel();
    }
}
