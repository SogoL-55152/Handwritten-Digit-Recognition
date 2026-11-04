package com.hdr.config;

import com.hdr.auth.AuthInterceptor;
import com.hdr.v2.auth.V2AuthInterceptor;
import com.hdr.v2.platform.V2RateLimitInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {
    private final AuthInterceptor authInterceptor;
    private final V2AuthInterceptor v2AuthInterceptor;
    private final V2RateLimitInterceptor v2RateLimitInterceptor;
    @org.springframework.beans.factory.annotation.Value("${hdr.cors.allowed-origins:*}")
    private String allowedOrigins;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(v2RateLimitInterceptor).addPathPatterns("/api/v2/**").order(0);
        registry.addInterceptor(v2AuthInterceptor).addPathPatterns("/api/v2/**").order(1);
        registry.addInterceptor(authInterceptor).addPathPatterns("/api/**")
                .excludePathPatterns("/api/v2/**").order(2);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        if (allowedOrigins == null || allowedOrigins.isBlank()) return;
        registry.addMapping("/api/**")
                .allowedOriginPatterns(java.util.Arrays.stream(allowedOrigins.split(","))
                        .map(String::trim).filter(value -> !value.isEmpty()).toArray(String[]::new))
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .exposedHeaders("Retry-After")
                .maxAge(3600);
    }
}
