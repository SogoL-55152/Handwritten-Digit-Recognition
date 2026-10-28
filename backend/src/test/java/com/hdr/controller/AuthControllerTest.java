package com.hdr.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.auth.AuthInterceptor;
import com.hdr.auth.CurrentUser;
import com.hdr.auth.JwtUtil;
import com.hdr.auth.PublicApi;
import com.hdr.auth.RequireAdmin;
import com.hdr.auth.UserContext;
import com.hdr.common.BusinessException;
import com.hdr.common.GlobalExceptionHandler;
import com.hdr.common.Result;
import com.hdr.config.BeanConfig;
import com.hdr.dto.LoginRequest;
import com.hdr.dto.RegisterRequest;
import com.hdr.entity.User;
import com.hdr.mapper.UserMapper;
import com.hdr.service.UserService;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.stream.Stream;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Standalone HTTP contract tests: real controller/service/validator/advice/interceptor/BCrypt/JWT. */
@ExtendWith(MockitoExtension.class)
class AuthControllerTest {

    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final String PASSWORD = "alice123";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Mock
    private UserMapper userMapper;

    private MockMvc mvc;
    private PasswordEncoder passwordEncoder;
    private JwtUtil jwtUtil;
    private LocalValidatorFactoryBean validator;

    @BeforeEach
    void setUp() {
        UserContext.clear();
        passwordEncoder = new BeanConfig().passwordEncoder();
        jwtUtil = new JwtUtil(SECRET, 1);
        UserService service = new UserService(userMapper, passwordEncoder, jwtUtil);
        validator = new LocalValidatorFactoryBean();
        validator.afterPropertiesSet();
        mvc = MockMvcBuilders.standaloneSetup(
                        new AuthController(service), new ProbeController(), new AdminProbeController())
                .setValidator(validator)
                .setControllerAdvice(new GlobalExceptionHandler())
                .addMappedInterceptors(new String[]{"/api/**"}, new AuthInterceptor(jwtUtil))
                .build();
    }

    @AfterEach
    void contextMustBeEmptyAfterEveryRequest() {
        try {
            // Assert before cleanup: teardown must not hide a leaking interceptor.
            assertNull(UserContext.get(), "Request leaked authentication into the next request");
        } finally {
            UserContext.clear();
            if (validator != null) {
                validator.close();
            }
        }
    }

    @Test
    void loginThenMeUsesRealJwtAndNeverReturnsPasswordHash() throws Exception {
        User user = storedUser("USER", 1);
        when(userMapper.selectOne(any())).thenReturn(user);
        when(userMapper.selectById(42L)).thenReturn(user);

        MvcResult login = postJson("/api/auth/login", new LoginRequest("alice", PASSWORD))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.user.id").value(42))
                .andExpect(jsonPath("$.data.user.role").value("USER"))
                .andExpect(jsonPath("$.data.user.password").doesNotExist())
                .andExpect(content().string(not(containsString(user.getPassword()))))
                .andExpect(content().string(not(containsString(PASSWORD))))
                .andReturn();
        String token = JSON.readTree(login.getResponse().getContentAsString()).at("/data/token").asText();
        assertEquals("42", jwtUtil.parse(token).getSubject());
        assertFalse(jwtUtil.parse(token).containsKey("password"));
        assertNull(UserContext.get());

        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.id").value(42))
                .andExpect(jsonPath("$.data.username").value("alice"))
                .andExpect(jsonPath("$.data.password").doesNotExist())
                .andExpect(content().string(not(containsString(user.getPassword()))));
        verify(userMapper).selectById(42L);
        assertNull(UserContext.get());

        // Same test thread, next request: a successful login must not become ambient auth.
        expectError(mvc.perform(get("/api/auth/me")), 401);
        verifyNoMoreInteractions(userMapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"wrong-password", "unknown-user"})
    void incorrectCredentialsReturnHttp200Business400(String scenario) throws Exception {
        when(userMapper.selectOne(any()))
                .thenReturn("unknown-user".equals(scenario) ? null : storedUser("USER", 1));

        expectError(postJson("/api/auth/login", new LoginRequest("alice", "wrong-password")), 400)
                .andExpect(jsonPath("$.message").value("用户名或密码错误"));
    }

    @Test
    void disabledAccountCannotLogin() throws Exception {
        when(userMapper.selectOne(any())).thenReturn(storedUser("USER", 0));

        expectError(postJson("/api/auth/login", new LoginRequest("alice", PASSWORD)), 403);
    }

    @Test
    void publicRegistrationCannotChooseAdminRoleOrLeakHash() throws Exception {
        when(userMapper.selectCount(any())).thenReturn(0L);
        when(userMapper.insert(any(User.class))).thenAnswer(invocation -> {
            User inserted = invocation.getArgument(0);
            inserted.setId(42L);
            return 1;
        });
        JsonNode request = JSON.createObjectNode()
                .put("username", "alice").put("password", PASSWORD)
                .put("role", "ADMIN").put("status", 0);

        MvcResult response = postJson("/api/auth/register", request)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.id").value(42))
                .andExpect(jsonPath("$.data.role").value("USER"))
                .andExpect(jsonPath("$.data.status").value(1))
                .andExpect(jsonPath("$.data.nickname").value("alice"))
                .andExpect(jsonPath("$.data.password").doesNotExist())
                .andReturn();

        ArgumentCaptor<User> captor = ArgumentCaptor.forClass(User.class);
        verify(userMapper).insert(captor.capture());
        User inserted = captor.getValue();
        assertEquals("USER", inserted.getRole());
        assertEquals(1, inserted.getStatus());
        assertTrue(passwordEncoder.matches(PASSWORD, inserted.getPassword()));
        String body = response.getResponse().getContentAsString();
        assertFalse(body.contains(inserted.getPassword()));
        assertFalse(body.contains(PASSWORD));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void duplicateRegistrationIncludingInsertRaceReturnsBusiness400(boolean race) throws Exception {
        when(userMapper.selectCount(any())).thenReturn(race ? 0L : 1L);
        if (race) {
            when(userMapper.insert(any(User.class)))
                    .thenThrow(new DuplicateKeyException("duplicate uk_username"));
        }

        expectError(postJson("/api/auth/register", new RegisterRequest("alice", PASSWORD, null)), 400)
                .andExpect(jsonPath("$.message").value("用户名已存在"));
        verify(userMapper, times(race ? 1 : 0)).insert(any(User.class));
    }

    @ParameterizedTest
    @MethodSource("invalidRequests")
    void validatesFieldsBeforeCallingMapper(String path, Object request, String message) throws Exception {
        expectError(postJson(path, request), 400)
                .andExpect(jsonPath("$.message", containsString(message)));
        verifyNoInteractions(userMapper);
    }

    static Stream<Arguments> invalidRequests() {
        String register = "/api/auth/register";
        String login = "/api/auth/login";
        return Stream.of(
                Arguments.of(register, new RegisterRequest(null, PASSWORD, null), "用户名不能为空"),
                Arguments.of(register, new RegisterRequest("   ", PASSWORD, null), "用户名不能为空"),
                Arguments.of(register, new RegisterRequest("ab", PASSWORD, null), "用户名长度需为 3-32 个字符"),
                Arguments.of(register, new RegisterRequest("a".repeat(33), PASSWORD, null), "用户名长度需为 3-32 个字符"),
                Arguments.of(register, new RegisterRequest("alice", null, null), "密码不能为空"),
                Arguments.of(register, new RegisterRequest("alice", "      ", null), "密码不能为空"),
                Arguments.of(register, new RegisterRequest("alice", "12345", null), "密码长度需为 6-32 个字符"),
                Arguments.of(register, new RegisterRequest("alice", "a".repeat(33), null), "密码长度需为 6-32 个字符"),
                Arguments.of(register, new RegisterRequest("alice", PASSWORD, "n".repeat(65)), "昵称最长 64 个字符"),
                Arguments.of(login, new LoginRequest(null, PASSWORD), "用户名不能为空"),
                Arguments.of(login, new LoginRequest(" ", PASSWORD), "用户名不能为空"),
                Arguments.of(login, new LoginRequest("alice", null), "密码不能为空"),
                Arguments.of(login, new LoginRequest("alice", " "), "密码不能为空")
        );
    }

    @ParameterizedTest
    @CsvSource({"3,6,0", "32,32,64"})
    void acceptsRegistrationLengthBoundaries(int usernameLength, int passwordLength, int nicknameLength)
            throws Exception {
        when(userMapper.selectCount(any())).thenReturn(0L);
        RegisterRequest request = new RegisterRequest(
                "a".repeat(usernameLength), "p".repeat(passwordLength), "n".repeat(nicknameLength));

        postJson("/api/auth/register", request)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));
        verify(userMapper).insert(any(User.class));
    }

    @ParameterizedTest
    @ValueSource(strings = {"{", "[]", ""})
    void invalidOrMissingJsonReturnsBusiness400(String body) throws Exception {
        expectError(mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content(body)), 400);
        verifyNoInteractions(userMapper);
    }

    @Test
    void meReportsUserNoLongerPresent() throws Exception {
        when(userMapper.selectById(42L)).thenReturn(null);

        expectError(mvc.perform(get("/api/auth/me").header("Authorization", bearer("USER"))), 404);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"Basic abc", "bearer abc", "Bearer "})
    void missingOrInvalidAuthorizationHeaderReturnsBusiness401(String header) throws Exception {
        var request = get("/api/auth/me");
        if (header != null) {
            request.header("Authorization", header);
        }
        expectError(mvc.perform(request), 401);
        verifyNoInteractions(userMapper);
    }

    @ParameterizedTest
    @MethodSource("invalidTokens")
    void invalidExpiredOrWronglySignedJwtReturnsBusiness401(String token) throws Exception {
        expectError(mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token)), 401);
        verifyNoInteractions(userMapper);
    }

    static Stream<String> invalidTokens() {
        return Stream.of(
                "not-a-jwt",
                new JwtUtil(SECRET, -1).generate(42L, "alice", "USER"),
                new JwtUtil("abcdef0123456789abcdef0123456789", 1).generate(42L, "alice", "USER")
        );
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"not-a-number", "9223372036854775808"})
    void signedJwtWithInvalidSubjectReturns401Not500(String subject) throws Exception {
        String token = signedClaims(subject, "alice", "USER");

        expectError(mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token)), 401);
        verifyNoInteractions(userMapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"username", "role"})
    void signedJwtWithInvalidClaimTypeReturns401Not500(String field) throws Exception {
        String token = signedClaims("42", "username".equals(field) ? 123 : "alice",
                "role".equals(field) ? 123 : "USER");

        expectError(mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token)), 401);
        verifyNoInteractions(userMapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"/api/test/admin-method", "/api/test/admin-class"})
    void methodAndClassAdminAnnotationsRejectUserWithoutLeakingContext(String path) throws Exception {
        expectError(mvc.perform(get(path).header("Authorization", bearer("USER"))), 403);
        // preHandle throws, so Spring will NOT call this interceptor's afterCompletion.
        assertNull(UserContext.get());

        mvc.perform(get("/api/test/public"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data").doesNotExist());
        verifyNoInteractions(userMapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"/api/test/admin-method", "/api/test/admin-class"})
    void methodAndClassAdminAnnotationsAllowAdminAndThenClearContext(String path) throws Exception {
        mvc.perform(get(path).header("Authorization", bearer("ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.id").value(42))
                .andExpect(jsonPath("$.data.role").value("ADMIN"));
        assertNull(UserContext.get());
        expectError(mvc.perform(get(path)), 401);
        verifyNoInteractions(userMapper);
    }

    @Test
    void clearsContextAfterControllerThrowsBusinessException() throws Exception {
        expectError(mvc.perform(get("/api/test/failure").header("Authorization", bearer("USER"))), 400);
        assertNull(UserContext.get());
        expectError(mvc.perform(get("/api/test/failure")), 401);
    }

    private ResultActions postJson(String path, Object body) throws Exception {
        return mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsBytes(body)));
    }

    private ResultActions expectError(ResultActions result, int code) throws Exception {
        return result.andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(code))
                .andExpect(jsonPath("$.data").doesNotExist());
    }

    private String bearer(String role) {
        return "Bearer " + jwtUtil.generate(42L, "alice", role);
    }

    private static String signedClaims(String subject, Object username, Object role) {
        return Jwts.builder().subject(subject).claim("username", username).claim("role", role)
                .expiration(new Date(System.currentTimeMillis() + 3_600_000L))
                .signWith(Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8))).compact();
    }

    private User storedUser(String role, int status) {
        User user = new User();
        user.setId(42L);
        user.setUsername("alice");
        user.setNickname("Alice");
        user.setPassword(passwordEncoder.encode(PASSWORD));
        user.setRole(role);
        user.setStatus(status);
        return user;
    }

    // Test-only endpoints exercise authorization without adding W2 production CRUD routes.
    @RestController
    @RequestMapping("/api/test")
    static class ProbeController {
        @RequireAdmin
        @GetMapping("/admin-method")
        public Result<CurrentUser> admin() {
            return Result.ok(UserContext.require());
        }

        @PublicApi
        @GetMapping("/public")
        public Result<CurrentUser> publicContext() {
            return Result.ok(UserContext.get());
        }

        @GetMapping("/failure")
        public Result<Void> failure() {
            UserContext.require();
            throw new BusinessException(400, "测试业务异常");
        }
    }

    @RequireAdmin
    @RestController
    static class AdminProbeController {
        @GetMapping("/api/test/admin-class")
        public Result<CurrentUser> admin() {
            return Result.ok(UserContext.require());
        }
    }
}
