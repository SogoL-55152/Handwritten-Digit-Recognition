package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class V2AuthInterceptorTest {
    private final V2AuthService auth = mock(V2AuthService.class);
    private final V2AuthInterceptor interceptor = new V2AuthInterceptor(auth);

    @Test
    void onlyExactPublicPostAndOptionsBypassAuthentication() {
        for (String path : new String[]{"/api/v2/auth/login", "/api/v2/auth/register"}) {
            assertTrue(interceptor.preHandle(new MockHttpServletRequest("POST", path), new MockHttpServletResponse(), new Object()));
            assertThrows(V2Exception.class, () -> interceptor.preHandle(new MockHttpServletRequest("GET", path), new MockHttpServletResponse(), new Object()));
        }
        assertThrows(V2Exception.class, () -> interceptor.preHandle(new MockHttpServletRequest("POST", "/api/v2/auth/login/"), new MockHttpServletResponse(), new Object()));
        assertTrue(interceptor.preHandle(new MockHttpServletRequest("OPTIONS", "/api/v2/workspaces"), new MockHttpServletResponse(), new Object()));
        verifyNoInteractions(auth);
    }

    @Test
    void identityIsRequestScopedAndRemovedOnSuccessOrFailure() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v2/auth/me");
        request.addHeader("Authorization", "Bearer valid");
        V2Principal principal = new V2Principal(1L, "session", "USER");
        when(auth.authenticate("valid")).thenReturn(principal);
        assertTrue(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()));
        assertEquals(principal, V2Principal.require(request));
        interceptor.afterCompletion(request, new MockHttpServletResponse(), new Object(), new RuntimeException());
        assertNull(request.getAttribute(V2Principal.ATTRIBUTE));
        assertThrows(V2Exception.class, () -> V2Principal.require(request));
        request.setAttribute(V2Principal.ATTRIBUTE, principal);
        when(auth.authenticate("valid")).thenThrow(new V2Exception(401, "revoked"));
        assertThrows(V2Exception.class, () -> interceptor.preHandle(request, new MockHttpServletResponse(), new Object()));
        assertNull(request.getAttribute(V2Principal.ATTRIBUTE));
    }
}
