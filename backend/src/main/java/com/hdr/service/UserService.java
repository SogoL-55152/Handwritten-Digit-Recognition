package com.hdr.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hdr.auth.JwtUtil;
import com.hdr.common.BusinessException;
import com.hdr.common.PageResult;
import com.hdr.dto.LoginRequest;
import com.hdr.dto.LoginResponse;
import com.hdr.dto.RegisterRequest;
import com.hdr.dto.UserVO;
import com.hdr.entity.User;
import com.hdr.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
public class UserService {

    private final UserMapper userMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;

    public UserVO register(RegisterRequest request) {
        Long exists = userMapper.selectCount(
                Wrappers.<User>lambdaQuery().eq(User::getUsername, request.username()));
        if (exists > 0) {
            throw new BusinessException(400, "用户名已存在");
        }
        User user = new User();
        user.setUsername(request.username());
        user.setPassword(passwordEncoder.encode(request.password()));
        user.setNickname(StringUtils.hasText(request.nickname()) ? request.nickname() : request.username());
        user.setRole("USER");
        user.setStatus(1);
        userMapper.insert(user);
        return UserVO.from(user);
    }

    public LoginResponse login(LoginRequest request) {
        User user = userMapper.selectOne(Wrappers.<User>lambdaQuery()
                .eq(User::getUsername, request.username())
                .last("LIMIT 1"));
        if (user == null || !passwordEncoder.matches(request.password(), user.getPassword())) {
            throw new BusinessException(400, "用户名或密码错误");
        }
        if (user.getStatus() == null || user.getStatus() == 0) {
            throw new BusinessException(403, "账号已被停用，请联系管理员");
        }
        String token = jwtUtil.generate(user.getId(), user.getUsername(), user.getRole());
        return new LoginResponse(token, UserVO.from(user));
    }

    public UserVO get(Long id) {
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(404, "用户不存在");
        }
        return UserVO.from(user);
    }

    public PageResult<UserVO> page(long page, long size, String keyword) {
        LambdaQueryWrapper<User> query = Wrappers.<User>lambdaQuery()
                .and(StringUtils.hasText(keyword), wrapper -> wrapper
                        .like(User::getUsername, keyword)
                        .or()
                        .like(User::getNickname, keyword))
                .orderByDesc(User::getId);
        Page<User> result = userMapper.selectPage(new Page<>(page, size), query);
        return PageResult.of(
                result.getRecords().stream().map(UserVO::from).toList(),
                result.getTotal(), page, size);
    }

    public void updateStatus(Long id, Integer status) {
        if (status == null || (status != 0 && status != 1)) {
            throw new BusinessException(400, "状态值只能是 0 或 1");
        }
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(404, "用户不存在");
        }
        user.setStatus(status);
        userMapper.updateById(user);
    }
}
