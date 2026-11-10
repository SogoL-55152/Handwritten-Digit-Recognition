package com.hdr.v2.statistics;

import com.hdr.v2.V2Exception;
import com.hdr.v2.V2ExceptionHandler;
import com.hdr.v2.auth.V2AuthInterceptor;
import com.hdr.v2.auth.V2AuthService;
import com.hdr.v2.auth.V2Principal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class StatisticsControllerTest {
    private final V2AuthService auth = mock(V2AuthService.class);
    private final StatisticsService service = mock(StatisticsService.class);
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        mvc = MockMvcBuilders.standaloneSetup(new StatisticsController(service))
                .setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2AuthInterceptor(auth)).build();
    }

    private void authenticate(String role) {
        when(auth.authenticate("valid")).thenReturn(new V2Principal(2, "sid", role));
    }

    @Test
    void platformStatisticsRequireSuperAdmin() throws Exception {
        authenticate("USER");
        mvc.perform(get("/api/v2/platform/statistics").header("Authorization", "Bearer valid"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.data.category").value("FORBIDDEN"));
        verifyNoInteractions(service);
    }

    @Test
    void platformStatisticsReturnCountsAndTheAccuracyCaveat() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.platform(30)).thenReturn(new StatisticsService.PlatformStatistics(30, 3, 5, 100, 80, 15, 5,
                412.5, List.of(new StatisticsService.DayPoint("2026-11-09", 60, 50, 8, 2)),
                List.of(new StatisticsService.ModelUsage("w2-canvas-photo-3epoch", 60, 50)), 2, 1, 1,
                StatisticsService.ACCURACY_NOTE));
        mvc.perform(get("/api/v2/platform/statistics").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(100))
                .andExpect(jsonPath("$.data.declined").value(15))
                .andExpect(jsonPath("$.data.trainingSucceeded").value(1))
                .andExpect(jsonPath("$.data.note").value(StatisticsService.ACCURACY_NOTE));
    }

    @Test
    void spaceStatisticsPassDaysAndWorkspaceThrough() throws Exception {
        authenticate("USER");
        when(service.forSpace(9L, 2L, 7)).thenReturn(new StatisticsService.SpaceStatistics(9, 7, 3, 2, 1, 0, 300,
                List.of(), List.of(), StatisticsService.ACCURACY_NOTE));
        mvc.perform(get("/api/v2/workspaces/9/statistics?days=7").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.workspaceId").value(9))
                .andExpect(jsonPath("$.data.days").value(7));
        verify(service).forSpace(9L, 2L, 7);
    }

    @Test
    void invalidDayWindowKeepsValidationContract() throws Exception {
        authenticate("SUPER_ADMIN");
        when(service.platform(anyInt())).thenThrow(new V2Exception(400, "days 必须在 1..90", "VALIDATION"));
        mvc.perform(get("/api/v2/platform/statistics?days=999").header("Authorization", "Bearer valid"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.data.category").value("VALIDATION"));
    }
}
