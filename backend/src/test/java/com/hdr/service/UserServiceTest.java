package com.hdr.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.auth.JwtUtil;
import com.hdr.common.BusinessException;
import com.hdr.config.BeanConfig;
import com.hdr.dto.LoginRequest;
import com.hdr.dto.LoginResponse;
import com.hdr.dto.RegisterRequest;
import com.hdr.dto.UserVO;
import com.hdr.entity.User;
import com.hdr.mapper.UserMapper;
import io.jsonwebtoken.Claims;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Real BCrypt/JWT, mocked persistence only; no Spring context or database. */
@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final String PASSWORD = "alice123";

    @Mock
    private UserMapper userMapper;

    private PasswordEncoder passwordEncoder;
    private JwtUtil jwtUtil;
    private UserService userService;

    @BeforeEach
    void setUp() {
        passwordEncoder = new BeanConfig().passwordEncoder();
        jwtUtil = new JwtUtil(SECRET, 1);
        userService = new UserService(userMapper, passwordEncoder, jwtUtil);
    }

    @Test
    void registersEnabledOrdinaryUserWithBcryptAndSafeResponse() {
        when(userMapper.selectCount(any())).thenReturn(0L);
        when(userMapper.insert(any(User.class))).thenAnswer(invocation -> {
            User inserted = invocation.getArgument(0);
            inserted.setId(42L); // Simulate generated-key backfill, not a real insert.
            return 1;
        });

        UserVO result = userService.register(new RegisterRequest("alice", PASSWORD, "Alice"));

        ArgumentCaptor<User> captor = ArgumentCaptor.forClass(User.class);
        verify(userMapper).insert(captor.capture());
        User stored = captor.getValue();
        assertEquals("alice", stored.getUsername());
        assertEquals("Alice", stored.getNickname());
        assertEquals("USER", stored.getRole());
        assertEquals(1, stored.getStatus());
        assertNotEquals(PASSWORD, stored.getPassword());
        assertTrue(stored.getPassword().startsWith("$2"));
        assertTrue(passwordEncoder.matches(PASSWORD, stored.getPassword()));
        assertEquals(42L, result.id());
        assertEquals("USER", result.role());
        assertSafeUser(result, stored.getPassword());
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"   "})
    void defaultsMissingOrBlankNicknameToUsername(String nickname) {
        when(userMapper.selectCount(any())).thenReturn(0L);

        UserVO result = userService.register(new RegisterRequest("alice", PASSWORD, nickname));

        assertEquals("alice", result.nickname());
        verify(userMapper).insert(any(User.class));
    }

    @Test
    void rejectsUsernameFoundByPrecheckWithoutInserting() {
        when(userMapper.selectCount(any())).thenReturn(1L);

        BusinessException error = assertThrows(BusinessException.class,
                () -> userService.register(new RegisterRequest("alice", PASSWORD, null)));

        assertEquals(400, error.getCode());
        assertEquals("用户名已存在", error.getMessage());
        verify(userMapper, never()).insert(any(User.class));
    }

    @Test
    void translatesUniqueKeyRaceAfterSuccessfulPrecheckToBusiness400() {
        when(userMapper.selectCount(any())).thenReturn(0L);
        when(userMapper.insert(any(User.class)))
                .thenThrow(new DuplicateKeyException("duplicate uk_username"));

        BusinessException error = assertThrows(BusinessException.class,
                () -> userService.register(new RegisterRequest("alice", PASSWORD, null)));

        assertEquals(400, error.getCode());
        assertEquals("用户名已存在", error.getMessage());
        verify(userMapper).insert(any(User.class));
    }

    @Test
    void doesNotMislabelOtherDatabaseFailuresAsDuplicateUsername() {
        when(userMapper.selectCount(any())).thenReturn(0L);
        DataAccessResourceFailureException databaseError =
                new DataAccessResourceFailureException("database unavailable");
        when(userMapper.insert(any(User.class))).thenThrow(databaseError);

        assertSame(databaseError, assertThrows(DataAccessResourceFailureException.class,
                () -> userService.register(new RegisterRequest("alice", PASSWORD, null))));
    }

    @ParameterizedTest
    @ValueSource(strings = {"ADMIN", "USER"})
    void authenticatesBcryptPasswordAndIssuesSignedJwt(String role) {
        User user = storedUser(role, 1);
        when(userMapper.selectOne(any())).thenReturn(user);

        LoginResponse result = userService.login(new LoginRequest("alice", PASSWORD));

        Claims claims = jwtUtil.parse(result.token());
        assertEquals("42", claims.getSubject());
        assertEquals("alice", claims.get("username", String.class));
        assertEquals(role, claims.get("role", String.class));
        assertNotNull(claims.getIssuedAt());
        assertTrue(claims.getExpiration().after(claims.getIssuedAt()));
        assertFalse(claims.containsKey("password"));
        assertFalse(claims.toString().contains(user.getPassword()));
        assertSafeUser(result.user(), user.getPassword());
    }

    @Test
    void rejectsWrongPassword() {
        when(userMapper.selectOne(any())).thenReturn(storedUser("USER", 1));

        assertBadCredentials(new LoginRequest("alice", "wrong-password"));
    }

    @Test
    void rejectsUnknownUserWithSameCredentialError() {
        when(userMapper.selectOne(any())).thenReturn(null);

        assertBadCredentials(new LoginRequest("missing", PASSWORD));
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(ints = {0})
    void rejectsDisabledOrMissingStatus(Integer status) {
        when(userMapper.selectOne(any())).thenReturn(storedUser("USER", status));

        BusinessException error = assertThrows(BusinessException.class,
                () -> userService.login(new LoginRequest("alice", PASSWORD)));

        assertEquals(403, error.getCode());
        assertEquals("账号已被停用，请联系管理员", error.getMessage());
    }

    @Test
    void returnsSafeCurrentUser() {
        User user = storedUser("USER", 1);
        when(userMapper.selectById(42L)).thenReturn(user);

        UserVO result = userService.get(42L);

        assertEquals(42L, result.id());
        assertEquals("alice", result.username());
        assertSafeUser(result, user.getPassword());
    }

    @Test
    void reportsMissingCurrentUser() {
        when(userMapper.selectById(42L)).thenReturn(null);

        BusinessException error = assertThrows(BusinessException.class, () -> userService.get(42L));

        assertEquals(404, error.getCode());
        assertEquals("用户不存在", error.getMessage());
    }

    private User storedUser(String role, Integer status) {
        User user = new User();
        user.setId(42L);
        user.setUsername("alice");
        user.setNickname("Alice");
        user.setPassword(passwordEncoder.encode(PASSWORD));
        user.setRole(role);
        user.setStatus(status);
        return user;
    }

    private void assertBadCredentials(LoginRequest request) {
        BusinessException error = assertThrows(BusinessException.class, () -> userService.login(request));
        assertEquals(400, error.getCode());
        assertEquals("用户名或密码错误", error.getMessage());
    }

    private void assertSafeUser(UserVO user, String hash) {
        JsonNode json = new ObjectMapper().valueToTree(user);
        assertFalse(json.has("password"));
        assertFalse(json.toString().contains(hash));
        assertFalse(json.toString().contains(PASSWORD));
    }
}
