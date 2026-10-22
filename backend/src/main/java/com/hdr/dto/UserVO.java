package com.hdr.dto;

import com.hdr.entity.User;

import java.time.LocalDateTime;

public record UserVO(
        Long id,
        String username,
        String nickname,
        String role,
        Integer status,
        LocalDateTime createdAt
) {
    public static UserVO from(User user) {
        return new UserVO(
                user.getId(),
                user.getUsername(),
                user.getNickname(),
                user.getRole(),
                user.getStatus(),
                user.getCreatedAt()
        );
    }
}
