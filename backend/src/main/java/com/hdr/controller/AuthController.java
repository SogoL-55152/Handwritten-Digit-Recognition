package com.hdr.controller;

import com.hdr.auth.PublicApi;
import com.hdr.auth.UserContext;
import com.hdr.common.Result;
import com.hdr.dto.LoginRequest;
import com.hdr.dto.LoginResponse;
import com.hdr.dto.RegisterRequest;
import com.hdr.dto.UserVO;
import com.hdr.service.UserService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final UserService userService;

    @PublicApi
    @PostMapping("/register")
    public Result<UserVO> register(@Valid @RequestBody RegisterRequest request) {
        return Result.ok(userService.register(request));
    }

    @PublicApi
    @PostMapping("/login")
    public Result<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
        return Result.ok(userService.login(request));
    }

    @GetMapping("/me")
    public Result<UserVO> me() {
        return Result.ok(userService.get(UserContext.require().id()));
    }
}
