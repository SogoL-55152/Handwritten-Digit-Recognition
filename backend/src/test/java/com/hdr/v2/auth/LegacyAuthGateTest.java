package com.hdr.v2.auth;

import com.hdr.controller.AuthController;
import com.hdr.service.UserService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class LegacyAuthGateTest {
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withBean(UserService.class, () -> mock(UserService.class)).withUserConfiguration(AuthController.class);

    @Test
    void legacyRoutesAreAbsentByDefault() {
        runner.run(context -> assertEquals(0, context.getBeansOfType(AuthController.class).size()));
    }

    @Test
    void legacyRoutesRequireExplicitOptIn() {
        runner.withPropertyValues("hdr.legacy.auth-enabled=true")
                .run(context -> assertEquals(1, context.getBeansOfType(AuthController.class).size()));
    }
}
