package com.hdr.controller;

import com.hdr.auth.UserContext;
import com.hdr.common.Result;
import com.hdr.dto.PredictResult;
import com.hdr.service.RecognitionService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/recognition")
@RequiredArgsConstructor
public class RecognitionController {

    private final RecognitionService recognitionService;

    @PostMapping(value = "/predict", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<PredictResult> predict(@RequestParam("file") MultipartFile file) {
        return Result.ok(recognitionService.predict(file, UserContext.require().id()));
    }
}
