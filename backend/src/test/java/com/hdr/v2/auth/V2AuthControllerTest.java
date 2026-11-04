package com.hdr.v2.auth;

import com.hdr.v2.V2Exception;
import com.hdr.v2.V2ExceptionHandler;
import com.hdr.v2.workspace.WorkspaceController;
import com.hdr.v2.workspace.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;

import java.util.List;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class V2AuthControllerTest {
    private final V2AuthService auth = mock(V2AuthService.class);
    private final WorkspaceService workspaces = mock(WorkspaceService.class);
    private final AuthDtos.User user = new AuthDtos.User("9007199254740993", "alice", "Alice", "USER");
    private final V2Principal principal = new V2Principal(9007199254740993L, "sid", "USER");
    private LocalValidatorFactoryBean validator;
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        validator = new LocalValidatorFactoryBean();
        validator.afterPropertiesSet();
        mvc = MockMvcBuilders.standaloneSetup(new V2AuthController(auth), new WorkspaceController(workspaces))
                .setValidator(validator).setControllerAdvice(new V2ExceptionHandler())
                .addInterceptors(new V2AuthInterceptor(auth)).build();
    }
    @AfterEach void closeValidator() { validator.close(); }

    @Test
    void registrationReturns201SafeIdentityAndStringIdsIgnoringPrivilegeFields() throws Exception {
        when(auth.register(any())).thenReturn(new AuthDtos.Session("token", user, "9007199254740994"));
        mvc.perform(post("/api/v2/auth/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"alice\",\"password\":\"secret123\",\"platformRole\":\"SUPER_ADMIN\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.user.id").value("9007199254740993"))
                .andExpect(jsonPath("$.data.user.platformRole").value("USER"))
                .andExpect(jsonPath("$.data.defaultWorkspaceId").value("9007199254740994"))
                .andExpect(jsonPath("$.data.user.password").doesNotExist());
        verify(auth).register(new AuthDtos.RegisterRequest("alice", "secret123", null));
    }

    @Test
    void malformedAndInvalidFieldsAre400BeforeService() throws Exception {
        for (String body : List.of("{", "{}", "{\"username\":\"ab\",\"password\":\"secret123\"}",
                "{\"username\":\"alice\",\"password\":\"      \"}")) {
            mvc.perform(post("/api/v2/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value(400));
        }
        verifyNoInteractions(auth, workspaces);
    }

    @Test
    void meLogoutAndEveryWorkspaceReadRequireAuthentication() throws Exception {
        when(auth.authenticate("valid")).thenReturn(principal);
        when(auth.me(principal)).thenReturn(new AuthDtos.Me(user, "1"));
        mvc.perform(get("/api/v2/auth/me").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.user.platformRole").value("USER"));
        mvc.perform(post("/api/v2/auth/logout").header("Authorization", "Bearer valid"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data").doesNotExist());
        verify(auth).logout(principal);
        for (String path : List.of("/api/v2/auth/me", "/api/v2/workspaces", "/api/v2/workspaces/1")) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value(401));
        }
    }

    @Test
    void newRegistrationRejectsWhitespaceButLoginKeepsLegacyCredentials() throws Exception {
        mvc.perform(post("/api/v2/auth/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"ali ce\",\"password\":\"secret123\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v2/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"ali ce\",\"password\":\"secret 123\"}"))
                .andExpect(status().isOk());
        verify(auth).login(new AuthDtos.LoginRequest("ali ce", "secret 123"));
        verify(auth, never()).register(any());
    }

    @Test
    void passwordChangeRequiresSessionAndValidNewPassword() throws Exception {
        when(auth.authenticate("valid")).thenReturn(principal);
        mvc.perform(post("/api/v2/auth/password").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"currentPassword\":\"old pass\",\"newPassword\":\"new12345\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0));
        verify(auth).changePassword(principal, new AuthDtos.PasswordRequest("old pass", "new12345"));
        mvc.perform(post("/api/v2/auth/password").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"currentPassword\":\"old pass\",\"newPassword\":\"new12345\"}"))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v2/auth/password").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"currentPassword\":\"old pass\",\"newPassword\":\"new pass\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void workspaceCreateIs201AndForeignSpaceIsReal404() throws Exception {
        when(auth.authenticate("valid")).thenReturn(principal);
        when(workspaces.create(principal.userId(), "Team")).thenReturn(new WorkspaceService.Workspace("2", "Team", "OWNER", "ACTIVE", "1"));
        when(workspaces.requireMember(9, principal.userId())).thenThrow(new V2Exception(404, "not found"));
        mvc.perform(post("/api/v2/workspaces").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Team\",\"ownerId\":\"9\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.data.id").value("2"))
                .andExpect(jsonPath("$.data.role").value("OWNER"));
        mvc.perform(get("/api/v2/workspaces/9").header("Authorization", "Bearer valid"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value(404));
        mvc.perform(post("/api/v2/workspaces").header("Authorization", "Bearer valid")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"  \"}"))
                .andExpect(status().isBadRequest());
        verify(workspaces, times(1)).create(anyLong(), anyString());
    }
}
