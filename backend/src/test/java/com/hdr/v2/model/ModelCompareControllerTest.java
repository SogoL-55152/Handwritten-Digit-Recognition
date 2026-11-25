package com.hdr.v2.model;

import com.hdr.v2.V2Exception;
import com.hdr.v2.V2ExceptionHandler;
import com.hdr.v2.auth.V2AuthInterceptor;
import com.hdr.v2.auth.V2AuthService;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.recognition.ModelClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 对比接口只验证鉴权、入参边界与委托；算法与样本读取由模型服务契约测试覆盖。 */
class ModelCompareControllerTest {
    private static final String PATH = "/api/v2/admin/models/compare";
    private final V2AuthService auth = mock(V2AuthService.class);
    private final ModelCompareService service = mock(ModelCompareService.class);
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        mvc = MockMvcBuilders.standaloneSetup(new ModelCompareController(service))
                .setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2AuthInterceptor(auth)).build();
    }

    private void authenticate(String role) {
        when(auth.authenticate("valid")).thenReturn(new V2Principal(2, "sid", role));
    }

    private ModelCompareService.CompareView view() {
        return new ModelCompareService.CompareView(
                new ModelCompareService.Side("1", "v-a", "mnist-cnn-w1", "adaptive-mnist-v2", "INACTIVE",
                        .97, "MNIST test", "BUILTIN", null, "a".repeat(64), 1690340L, true, true, null),
                new ModelCompareService.Side("2", "v-b", "mnist-cnn-w1", "adaptive-mnist-v2", "ACTIVE",
                        null, null, "TRAINED", "2026-11-25T00:00:00Z", "b".repeat(64), 1690679L, true, true, null),
                new ModelClient.CompareSummary(2, 2, 1, .5, .5, 1.0, 1, 0, 1, 0, .9, .8),
                List.of(new ModelCompareService.Row(0, "11", 7, 7, .91, 7, .81, true)),
                42L, 6L, 0);
    }

    @Test
    void nonOperatorIsForbidden() throws Exception {
        authenticate("USER");
        mvc.perform(post(PATH).header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"versionA\":\"v-a\",\"versionB\":\"v-b\",\"datasetVersionId\":6}"))
                .andExpect(status().isForbidden());
        verifyNoInteractions(service);
    }

    @Test
    void missingBodyIsRejected() throws Exception {
        authenticate("SUPER_ADMIN");
        mvc.perform(post(PATH).header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(service);
    }

    @Test
    void delegatesToServiceForOperator() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.compare(eq(2L), any(ModelCompareService.Command.class))).thenReturn(view());
        mvc.perform(post(PATH).header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"versionA\":\"v-a\",\"versionB\":\"v-b\",\"datasetVersionId\":6,\"limit\":50}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.summary.agreementRate").value(0.5))
                .andExpect(jsonPath("$.data.modelA.version").value("v-a"))
                .andExpect(jsonPath("$.data.rows[0].sampleId").value("11"));
        verify(service).compare(eq(2L), any(ModelCompareService.Command.class));
    }

    @Test
    void serviceValidationErrorIsPropagated() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.compare(eq(2L), any(ModelCompareService.Command.class)))
                .thenThrow(new V2Exception(400, "两个模型版本不能相同", "VALIDATION"));
        mvc.perform(post(PATH).header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"versionA\":\"v-a\",\"versionB\":\"v-a\",\"datasetVersionId\":6}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("两个模型版本不能相同"));
    }
}
