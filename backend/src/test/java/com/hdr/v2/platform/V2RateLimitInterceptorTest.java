package com.hdr.v2.platform;

import com.hdr.v2.V2Exception;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class V2RateLimitInterceptorTest {
    private final RateLimiter limiter = mock(RateLimiter.class);
    private final V2RateLimitInterceptor interceptor = new V2RateLimitInterceptor(limiter);

    @Test
    void uploadIsBoundedBeforeAuthenticationAndIgnoresSpoofedForwardedAddress() {
        var request = new MockHttpServletRequest("POST", "/api/v2/workspaces/1/recognitions");
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("X-Forwarded-For", "203.0.113.8");
        assertTrue(interceptor.preHandle(request, new MockHttpServletResponse(), null));
        var order = inOrder(limiter);
        order.verify(limiter).check("upload:global", 240, 60);
        order.verify(limiter).check("upload:ip:127.0.0.1", 120, 60);
        verifyNoMoreInteractions(limiter);
    }

    @Test
    void globalRejectionDoesNotCreateAnUnboundedPerPeerBucket() {
        doThrow(new V2Exception(429, "busy", "RATE_LIMIT", 10)).when(limiter).check("upload:global", 240, 60);
        assertEquals(429, assertThrows(V2Exception.class, () -> interceptor.preHandle(
                new MockHttpServletRequest("POST", "/api/v2/workspaces/1/recognitions"), new MockHttpServletResponse(), null)).getStatus());
        verify(limiter).check("upload:global", 240, 60);
        verifyNoMoreInteractions(limiter);
    }

    @Test
    void registrationRespectsContextPathButGetDoesNotConsumeLimits() {
        var request = new MockHttpServletRequest("POST", "/hdr/api/v2/auth/register");
        request.setContextPath("/hdr");
        request.setRemoteAddr("127.0.0.1");
        interceptor.preHandle(request, new MockHttpServletResponse(), null);
        verify(limiter).check("auth:global", 300, 60);
        verify(limiter).check("auth:ip:127.0.0.1", 30, 60);
        verify(limiter).check("register:127.0.0.1", 5, 900);
        clearInvocations(limiter);
        interceptor.preHandle(new MockHttpServletRequest("GET", "/api/v2/workspaces/1/recognitions/2"), new MockHttpServletResponse(), null);
        verifyNoInteractions(limiter);
    }
}
