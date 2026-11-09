package com.hdr.v2.recognition;

import com.hdr.v2.V2Exception;
import com.hdr.v2.V2ExceptionHandler;
import com.hdr.v2.auth.V2AuthInterceptor;
import com.hdr.v2.auth.V2AuthService;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.platform.V2RateLimitInterceptor;
import com.hdr.v2.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class RecognitionControllerTest {
    private static final String REQUEST = "00000000-0000-4000-8000-00000000000a";
    private static final String PATH = "/api/v2/workspaces/1/recognitions";
    private final V2AuthService auth = mock(V2AuthService.class);
    private final WorkspaceService spaces = mock(WorkspaceService.class);
    private final RecognitionService service = mock(RecognitionService.class);
    private final ImageValidator images = mock(ImageValidator.class);
    private final RateLimiter limiter = mock(RateLimiter.class);
    private final MockMultipartFile image = new MockMultipartFile("image", "drawing.png", "image/png", new byte[]{1});
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        when(auth.authenticate("valid")).thenReturn(new V2Principal(2, "sid", "USER"));
        when(images.validate(any())).thenReturn(new ImageValidator.Image(new byte[]{1}, "a".repeat(64), "image/png"));
        mvc = MockMvcBuilders.standaloneSetup(new RecognitionController(service, spaces, images, limiter))
                .setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2RateLimitInterceptor(limiter), new V2AuthInterceptor(auth)).build();
    }

    @Test
    void acceptsBothClientSourcesAndCanonicalizesRequestId() throws Exception {
        for (String source : new String[]{"WEB", "MINIPROGRAM"}) {
            when(service.predict(eq(1L), eq(2L), eq(REQUEST), eq(source), any())).thenReturn(
                    new RecognitionService.Recognition("9007199254740993", REQUEST, 7, .98, "1",
                            "w2-canvas-photo-3epoch", "adaptive-mnist-v2", source, 12, "2026-11-02T00:00:00Z"));
            mvc.perform(multipart(PATH).file(image).param("source", source)
                            .header("Authorization", "Bearer valid").header("Idempotency-Key", REQUEST.toUpperCase()))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.data.digit").value(7))
                    .andExpect(jsonPath("$.data.requestId").value(REQUEST))
                    .andExpect(jsonPath("$.data.recognitionId").value("9007199254740993"));
        }
    }

    @Test
    void rejectsMissingSessionBeforeImageDecode() throws Exception {
        mvc.perform(multipart(PATH).file(image).param("source", "WEB").header("Idempotency-Key", REQUEST))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(images, service, spaces);
    }

    @Test
    void rejectsForeignSpaceBeforeImageDecode() throws Exception {
        doThrow(new V2Exception(404, "not found")).when(spaces).requireMember(1, 2);
        mvc.perform(multipart(PATH).file(image).param("source", "WEB")
                        .header("Authorization", "Bearer valid").header("Idempotency-Key", REQUEST))
                .andExpect(status().isNotFound());
        verifyNoInteractions(images, service);
    }

    @Test
    void rejectsDuplicateOrUntrustedFieldsBeforeImageDecode() throws Exception {
        var requests = java.util.List.of(
                multipart(PATH).file(image).file(image).param("source", "WEB"),
                multipart(PATH).file(image).param("source", "WEB", "MINIPROGRAM"),
                multipart(PATH).file(image).param("source", "WEB").param("modelId", "untrusted"),
                multipart(PATH).file(image).queryParam("source", "WEB")
        );
        for (var request : requests) mvc.perform(request.header("Authorization", "Bearer valid")
                        .header("Idempotency-Key", REQUEST)).andExpect(status().isBadRequest());
        verifyNoInteractions(images, service);
    }

    @Test
    void requestIdIsFreshUuidV4AndDoesNotStartRecognition() throws Exception {
        String previous = null;
        for (int i = 0; i < 2; i++) {
            var result = mvc.perform(get(PATH + "/request-id").header("Authorization", "Bearer valid"))
                    .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                    .andExpect(jsonPath("$.data.requestId").isString()).andReturn();
            String id = new com.fasterxml.jackson.databind.ObjectMapper().readTree(result.getResponse().getContentAsString())
                    .path("data").path("requestId").asText();
            var uuid = java.util.UUID.fromString(id);
            org.junit.jupiter.api.Assertions.assertEquals(4, uuid.version());
            org.junit.jupiter.api.Assertions.assertEquals(2, uuid.variant());
            org.junit.jupiter.api.Assertions.assertNotEquals(previous, id);
            previous = id;
        }
        verifyNoInteractions(images, service);
        verify(limiter, times(2)).check("request-id:global", 240, 60);
        verify(limiter, times(2)).check("request-id:user:2", 60, 60);
    }

    @Test
    void requestIdStillRequiresSessionAndWorkspaceMembership() throws Exception {
        mvc.perform(get(PATH + "/request-id")).andExpect(status().isUnauthorized());
        doThrow(new V2Exception(404, "not found")).when(spaces).requireMember(1, 2);
        mvc.perform(get(PATH + "/request-id").header("Authorization", "Bearer valid"))
                .andExpect(status().isNotFound());
        verifyNoInteractions(limiter, images, service);
    }

    @Test
    void requestIdLimitIsReturnedWithoutRunningModel() throws Exception {
        doThrow(new V2Exception(429, "busy", "RATE_LIMIT", 9)).when(limiter).check("request-id:global", 240, 60);
        mvc.perform(get(PATH + "/request-id").header("Authorization", "Bearer valid"))
                .andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "9"));
        verifyNoInteractions(images, service);
        verify(limiter, never()).check("request-id:user:2", 60, 60);
    }

    @Test
    void uploadLimitReturnsRetryAfterAndNeverReachesAuthenticationOrDecode() throws Exception {
        doThrow(new V2Exception(429, "busy", "RATE_LIMIT", 7)).when(limiter).check("upload:global", 240, 60);
        mvc.perform(multipart(PATH).file(image).param("source", "WEB")
                        .header("Authorization", "Bearer valid").header("Idempotency-Key", REQUEST))
                .andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "7"))
                .andExpect(jsonPath("$.data.category").value("RATE_LIMIT"));
        verifyNoInteractions(auth, images, service);
    }
}
