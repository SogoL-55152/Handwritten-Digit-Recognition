package com.hdr.v2;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.common.Result;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.ErrorResponse;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.servlet.ModelAndView;
import org.springframework.web.servlet.handler.AbstractHandlerExceptionResolver;

import java.io.IOException;
import java.util.Map;

/** Covers framework errors that happen before a v2 controller has been selected. */
@Component
public class V2FrameworkExceptionResolver extends AbstractHandlerExceptionResolver {
    private final ObjectMapper mapper;
    private final V2ExceptionHandler businessAdvice;

    public V2FrameworkExceptionResolver(ObjectMapper mapper, V2ExceptionHandler businessAdvice) {
        this.mapper = mapper;
        this.businessAdvice = businessAdvice;
        setOrder(-1);
    }

    @Override
    protected ModelAndView doResolveException(HttpServletRequest request, HttpServletResponse response,
                                             Object handler, Exception error) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (!path.startsWith("/api/v2/") || response.isCommitted()) return null;
        // Unknown/static-resource handlers are outside the scoped controller advice.
        // Reuse the same business mapping for interceptor failures on those paths.
        if (error instanceof V2Exception business) {
            var mapped = businessAdvice.business(business);
            response.setStatus(mapped.getStatusCode().value());
            mapped.getHeaders().forEach((name, values) -> values.forEach(value -> response.addHeader(name, value)));
            return write(response, mapped.getBody());
        }
        int status;
        if (error instanceof ErrorResponse framework) {
            status = framework.getStatusCode().value();
            framework.getHeaders().forEach((name, values) -> values.forEach(value -> response.addHeader(name, value)));
        } else if (error instanceof MultipartException) {
            status = 400;
        } else {
            return null;
        }
        String message = switch (status) {
            case 404 -> "接口不存在";
            case 405 -> "请求方法不支持";
            case 413 -> "图片最大为5MiB，请求最大为6MiB";
            case 415 -> "请求媒体类型不支持";
            default -> "请求格式或必要字段错误";
        };
        response.setStatus(status);
        return write(response, new Result<>(status, message,
                Map.of("category", status == 413 ? "IMAGE_TOO_LARGE" : "VALIDATION")));
    }

    private ModelAndView write(HttpServletResponse response, Object body) {
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        try {
            mapper.writeValue(response.getOutputStream(), body);
        } catch (IOException writeFailure) {
            logger.debug("V2 error response could not be written");
        }
        return new ModelAndView();
    }
}
