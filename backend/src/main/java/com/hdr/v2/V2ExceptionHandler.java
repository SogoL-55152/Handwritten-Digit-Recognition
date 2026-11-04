package com.hdr.v2;

import com.hdr.common.Result;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.dao.DataAccessException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import java.util.LinkedHashMap;
import java.util.Map;

@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(basePackages = "com.hdr.v2")
public class V2ExceptionHandler {
    private static final Logger LOG = LoggerFactory.getLogger(V2ExceptionHandler.class);

    @ExceptionHandler(V2Exception.class)
    public ResponseEntity<Result<Map<String, Object>>> business(V2Exception error) {
        Map<String, Object> details = new LinkedHashMap<>();
        if (error.getCategory() != null) details.put("category", error.getCategory());
        var response = ResponseEntity.status(error.getStatus());
        if (error.getRetryAfterSeconds() > 0) {
            details.put("retryAfterSeconds", error.getRetryAfterSeconds());
            response.header("Retry-After", Integer.toString(error.getRetryAfterSeconds()));
        }
        return response.body(new Result<>(error.getStatus(), error.getMessage(), details));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<?> invalid(MethodArgumentNotValidException error) {
        return business(new V2Exception(400, error.getBindingResult().getAllErrors().get(0).getDefaultMessage(), "VALIDATION"));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class,
            MissingServletRequestPartException.class, MissingRequestHeaderException.class, MissingServletRequestParameterException.class})
    public ResponseEntity<?> malformed(Exception error) {
        return business(new V2Exception(400, "请求格式或必要字段错误", "VALIDATION"));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<?> oversized(Exception error) { return business(new V2Exception(413, "图片最大为5MiB", "IMAGE_TOO_LARGE")); }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<?> database(DataAccessException error) {
        LOG.error("V2 persistence operation failed: {}", error.getClass().getSimpleName());
        return business(new V2Exception(503, "数据服务暂不可用", "DATABASE_UNAVAILABLE"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> unexpected(Exception error, HttpServletRequest request) {
        LOG.error("V2 request failed: {}", error.getClass().getSimpleName());
        return business(new V2Exception(500, "服务暂时异常，请稍后重试", "INTERNAL_ERROR"));
    }
}
