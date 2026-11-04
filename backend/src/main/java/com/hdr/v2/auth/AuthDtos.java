package com.hdr.v2.auth;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public final class AuthDtos {
    private AuthDtos() {}

    public record RegisterRequest(
            @NotBlank(message = "用户名不能为空") @Size(min = 3, max = 32, message = "用户名长度需为 3-32 个字符")
            @Pattern(regexp = CredentialRules.NON_WHITESPACE, message = "用户名不能包含空白字符") String username,
            @NotBlank(message = "密码不能为空") @Size(min = 6, max = 32, message = "密码长度需为 6-32 个字符")
            @Pattern(regexp = CredentialRules.NON_WHITESPACE, message = "密码不能包含空白字符") String password,
            @Size(max = 64, message = "昵称最长 64 个字符") String nickname,
            @Size(max = 256, message = "体验注册码过长") String pilotCode) {
        public RegisterRequest(String username, String password, String nickname) { this(username, password, nickname, null); }
        @Override public String toString() { return "RegisterRequest[redacted]"; }
    }

    public record PasswordRequest(
            @NotBlank @Size(min = 6, max = 32) String currentPassword,
            @NotBlank @Size(min = 6, max = 32)
            @Pattern(regexp = CredentialRules.NON_WHITESPACE, message = "新密码不能包含空白字符") String newPassword) {
        @Override public String toString() { return "PasswordRequest[redacted]"; }
    }

    public record LoginRequest(
            @NotBlank(message = "用户名不能为空") @Size(min = 3, max = 32) String username,
            @NotBlank(message = "密码不能为空") @Size(min = 6, max = 32) String password) {
        @Override public String toString() { return "LoginRequest[redacted]"; }
    }

    public record User(String id, String username, String nickname, String platformRole) {}
    public record Session(String token, User user, String defaultWorkspaceId) {}
    public record Me(User user, String defaultWorkspaceId) {}
}
