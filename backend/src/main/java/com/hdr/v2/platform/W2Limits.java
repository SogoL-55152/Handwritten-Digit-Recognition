package com.hdr.v2.platform;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class W2Limits {
    public static final long IMAGE_MAX_BYTES = 5L * 1024 * 1024;
    public static final int MAX_SIDE = 2048;
    public static final long MAX_PIXELS = 4194304;
    private final int maxWorkspaces;
    private final int recognitionPerMinute;
    private final int maxMembers;
    private final int dailyRecognitionLimit;

    @org.springframework.beans.factory.annotation.Autowired
    public W2Limits(@Value("${hdr.v2.limits.max-workspaces:3}") int maxWorkspaces,
                    @Value("${hdr.v2.limits.recognition-per-minute:60}") int recognitionPerMinute,
                    @Value("${hdr.v2.limits.max-members:5}") int maxMembers,
                    @Value("${hdr.v2.limits.daily-recognition-limit:1000}") int dailyRecognitionLimit) {
        if (maxWorkspaces < 1 || recognitionPerMinute < 1 || maxMembers < 1 || dailyRecognitionLimit < 1)
            throw new IllegalArgumentException("Limits must be positive");
        this.maxWorkspaces = maxWorkspaces;
        this.recognitionPerMinute = recognitionPerMinute;
        this.maxMembers = maxMembers;
        this.dailyRecognitionLimit = dailyRecognitionLimit;
    }
    public W2Limits(int maxWorkspaces, int recognitionPerMinute) {
        this(maxWorkspaces, recognitionPerMinute, 5, 1000);
    }
    public int recognitionPerMinute() { return recognitionPerMinute; }
    public Map<String,Object> view() {
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("maxWorkspaces",maxWorkspaces);
        result.put("maxMembers",maxMembers);
        result.put("imageMaxBytes",IMAGE_MAX_BYTES);
        result.put("recognitionPerMinute",recognitionPerMinute);
        result.put("dailyRecognitionLimit",dailyRecognitionLimit);
        result.put("dailyQuotaEnforced",false);
        result.put("remainingDaily",null);
        result.put("trainingAvailable",false);
        result.put("storageMeteringAvailable",false);
        return result;
    }
}
