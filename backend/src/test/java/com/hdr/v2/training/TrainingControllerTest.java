package com.hdr.v2.training;

import com.hdr.v2.V2Exception;
import com.hdr.v2.V2ExceptionHandler;
import com.hdr.v2.auth.V2AuthInterceptor;
import com.hdr.v2.auth.V2AuthService;
import com.hdr.v2.auth.V2Principal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 训练接口只验证鉴权、入参边界与错误映射；状态机由真实 MySQL 集成测试覆盖。 */
class TrainingControllerTest {
    private static final String PATH = "/api/v2/admin/training/tasks";
    private final V2AuthService auth = mock(V2AuthService.class);
    private final TrainingService service = mock(TrainingService.class);
    private final TrainingEventBus events = mock(TrainingEventBus.class);
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        mvc = MockMvcBuilders.standaloneSetup(new TrainingController(service, events))
                .setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2AuthInterceptor(auth)).build();
    }

    private void authenticate(String role) {
        when(auth.authenticate("valid")).thenReturn(new V2Principal(2, "sid", role));
    }

    private TrainingService.TaskView view(String status) {
        return new TrainingService.TaskView("1", status, 1, "celery-1", 1, 1000, 64, 0.001, 42, .5, false,
                null, "1", null, null, null, 1000L, null, null, "2026-11-08T00:00:00Z", null, null, null);
    }

    @Test
    void nonOperatorIsForbiddenOnEveryRoute() throws Exception {
        authenticate("USER");
        for (var request : List.of(get(PATH), get(PATH + "/1"), get(PATH + "/datasets"),
                post(PATH + "?datasetId=1"))) {
            mvc.perform(request.header("Authorization", "Bearer valid").contentType(MediaType.APPLICATION_JSON)
                            .content("{}"))
                    .andExpect(status().isForbidden());
        }
        verifyNoInteractions(service);
    }

    @Test
    void operatorListsTasksAndDatasets() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.list(eq(20))).thenReturn(List.of(view("SUCCEEDED")));
        when(service.datasets()).thenReturn(List.of(Map.of("id", "1", "name", "MNIST")));
        mvc.perform(get(PATH).header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].status").value("SUCCEEDED"));
        mvc.perform(get(PATH + "/datasets").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].name").value("MNIST"));
    }

    @Test
    void createPassesDatasetIdAndBody() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.create(eq(2L), eq(1L), any())).thenReturn(view("QUEUED"));
        mvc.perform(post(PATH + "?datasetId=1").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"epochs\":1,\"samples\":1000,\"batchSize\":64,\"learningRate\":0.001,"
                                + "\"seed\":42,\"photoRatio\":0.5,\"useEmnist\":false}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("QUEUED"));
    }

    @Test
    void validationAndQueueFailuresKeepTheirContract() throws Exception {
        authenticate("SUPER_ADMIN");
        doThrow(new V2Exception(400, "epochs 必须在 1..5", "VALIDATION")).when(service)
                .create(anyLong(), anyLong(), any());
        mvc.perform(post(PATH + "?datasetId=1").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"epochs\":9}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.category").value("VALIDATION"));
        doThrow(new V2Exception(503, "训练队列暂不可用，请稍后重试", "QUEUE_UNAVAILABLE")).when(service)
                .create(anyLong(), anyLong(), any());
        mvc.perform(post(PATH + "?datasetId=1").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.data.category").value("QUEUE_UNAVAILABLE"));
    }

    @Test
    void limitBoundIsEnforced() throws Exception {
        authenticate("SUPER_ADMIN");
        mvc.perform(get(PATH + "?limit=0").header("Authorization", "Bearer valid")).andExpect(status().isBadRequest());
        mvc.perform(get(PATH + "?limit=51").header("Authorization", "Bearer valid")).andExpect(status().isBadRequest());
        verify(service, never()).list(anyInt());
    }
}
