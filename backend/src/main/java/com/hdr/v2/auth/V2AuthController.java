package com.hdr.v2.auth;

import com.hdr.common.Result;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2/auth")
public class V2AuthController {
    private final V2AuthService auth;

    public V2AuthController(V2AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public Result<AuthDtos.Session> register(@Valid @RequestBody AuthDtos.RegisterRequest body) {
        return Result.ok(auth.register(body));
    }

    @PostMapping("/login")
    public Result<AuthDtos.Session> login(@Valid @RequestBody AuthDtos.LoginRequest body) {
        return Result.ok(auth.login(body));
    }

    @GetMapping("/me")
    public Result<AuthDtos.Me> me(HttpServletRequest request) {
        return Result.ok(auth.me(V2Principal.require(request)));
    }

    @PostMapping("/password")
    public Result<Void> password(@Valid @RequestBody AuthDtos.PasswordRequest body, HttpServletRequest request) {
        auth.changePassword(V2Principal.require(request), body);
        return Result.ok();
    }

    @PostMapping("/logout")
    public Result<Void> logout(HttpServletRequest request) {
        auth.logout(V2Principal.require(request));
        return Result.ok();
    }
}
