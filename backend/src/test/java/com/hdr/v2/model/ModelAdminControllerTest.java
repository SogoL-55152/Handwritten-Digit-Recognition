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
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 管理接口只验证鉴权、入参边界与错误映射；状态机由真实 MySQL 集成测试覆盖。 */
class ModelAdminControllerTest {
    private static final String PATH = "/api/v2/admin/models";
    private final V2AuthService auth = mock(V2AuthService.class);
    private final ModelAdminService service = mock(ModelAdminService.class);
    private final ModelClient client = mock(ModelClient.class);
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        mvc = MockMvcBuilders.standaloneSetup(new ModelAdminController(service, client))
                .setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2AuthInterceptor(auth)).build();
    }

    private void authenticate(String role) {
        when(auth.authenticate("valid")).thenReturn(new V2Principal(2, "sid", role));
    }

    private ModelAdminService.ModelView view(String id, String status) {
        return new ModelAdminService.ModelView(id, "mnist-cnn-w1", "w2-canvas-photo-3epoch", "adaptive-mnist-v2",
                status, .977, "MNIST test", "a".repeat(64), 1690340L, "w2-canvas-photo/checkpoint.pt",
                "BUILTIN", null, null, null, true, true, "");
    }

    @Test
    void nonOperatorIsForbiddenOnEveryRoute() throws Exception {
        authenticate("USER");
        for (var request : List.of(get(PATH), post(PATH + "/1/activate"), post(PATH + "/1/disable"),
                delete(PATH + "/1"), post(PATH + "/registry/reload"))) {
            mvc.perform(request.header("Authorization", "Bearer valid")).andExpect(status().isForbidden());
        }
        verifyNoInteractions(service, client);
    }

    @Test
    void operatorListsModels() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.list()).thenReturn(List.of(view("1", "ACTIVE")));
        mvc.perform(get(PATH).header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].status").value("ACTIVE"))
                .andExpect(jsonPath("$.data[0].artifact").value("w2-canvas-photo/checkpoint.pt"));
    }

    @Test
    void activatingReturnsTheNewActiveModel() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.activate(eq(2L))).thenReturn(view("2", "ACTIVE"));
        mvc.perform(post(PATH + "/2/activate").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value("2"))
                .andExpect(jsonPath("$.data.status").value("ACTIVE"));
    }

    @Test
    void serviceConflictsKeepTheirStatusAndCategory() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.activate(eq(1L))).thenThrow(new V2Exception(409, "数据库与模型文件的摘要不一致", "MODEL_DIGEST_MISMATCH"));
        mvc.perform(post(PATH + "/1/activate").header("Authorization", "Bearer valid"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.data.category").value("MODEL_DIGEST_MISMATCH"));
    }

    @Test
    void invalidRegistrationBodyIsRejectedWithoutTouchingTheRegistry() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.register(any())).thenThrow(new V2Exception(400, "字段 externalId 格式无效", "VALIDATION"));
        mvc.perform(post(PATH + "/register").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"externalId\":\"../x\",\"version\":\"v1\"}"))
                .andExpect(status().isBadRequest());
        verify(service).register(any());
        verifyNoInteractions(client);
    }

    @Test
    void deletingRequiresOperatorAndReportsInUse() throws Exception {
        authenticate("SUPER_ADMIN");
        doThrow(new V2Exception(409, "该模型已有识别记录，只能停用不能删除", "MODEL_IN_USE"))
                .when(service).delete(eq(3L));
        mvc.perform(delete(PATH + "/3").header("Authorization", "Bearer valid"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.data.category").value("MODEL_IN_USE"));
    }

    @Test
    void registryReloadIsOperatorOnlyAndProxied() throws Exception {
        authenticate("SUPER_ADMIN");
        when(client.reloadRegistry()).thenReturn(List.of(
                new ModelClient.RegisteredModel("mnist-cnn-w1", "w2-canvas-photo-3epoch", "adaptive-mnist-v2",
                        "a".repeat(64), 1690340L, "w2-canvas-photo/checkpoint.pt", true, false, "")));
        mvc.perform(post(PATH + "/registry/reload").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].verified").value(true));
    }
}
