package com.hdr.v2;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;

import static org.junit.jupiter.api.Assertions.*;

class V2FrameworkExceptionResolverTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final V2FrameworkExceptionResolver resolver = new V2FrameworkExceptionResolver(mapper, new V2ExceptionHandler());

    @Test
    void preControllerErrorsKeepRealHttpStatusAndV2Envelope() throws Exception {
        Exception[] errors = {
                new MaxUploadSizeExceededException(6 * 1024 * 1024),
                new HttpRequestMethodNotSupportedException("DELETE", java.util.List.of("POST")),
                new HttpMediaTypeNotSupportedException("unsupported"),
                new MultipartException("private server path must not be exposed")
        };
        int[] expected = {413, 405, 415, 400};
        for (int i = 0; i < errors.length; i++) {
            var request = new MockHttpServletRequest("POST", "/api/v2/workspaces/1/recognitions");
            var response = new MockHttpServletResponse();
            assertNotNull(resolver.resolveException(request, response, null, errors[i]));
            assertEquals(expected[i], response.getStatus());
            assertEquals(expected[i], mapper.readTree(response.getContentAsByteArray()).path("code").asInt());
            assertFalse(response.getContentAsString().contains("private server path"));
            if (expected[i] == 405) assertEquals("POST", response.getHeader("Allow"));
        }
    }

    @Test
    void doesNotChangeLegacyHandlingButCoversV2InterceptorErrorsWithoutController() {
        var response = new MockHttpServletResponse();
        assertNull(resolver.resolveException(new MockHttpServletRequest("POST", "/api/auth/login"), response,
                null, new MultipartException("invalid")));
        assertNotNull(resolver.resolveException(new MockHttpServletRequest("GET", "/api/v2/missing"), response,
                null, new V2Exception(401, "invalid token")));
        assertEquals(401, response.getStatus());
    }
}
