package com.hdr.config;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.hdr.entity.Dataset;
import com.hdr.entity.User;
import com.hdr.mapper.DatasetMapper;
import com.hdr.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class DataInitializer implements CommandLineRunner {

    private final UserMapper userMapper;
    private final DatasetMapper datasetMapper;
    private final PasswordEncoder passwordEncoder;

    @Override
    public void run(String... args) {
        initAdmin();
        initMnistDataset();
    }

    private void initAdmin() {
        Long count = userMapper.selectCount(
                Wrappers.<User>lambdaQuery().eq(User::getUsername, "admin"));
        if (count > 0) {
            return;
        }
        User admin = new User();
        admin.setUsername("admin");
        admin.setPassword(passwordEncoder.encode("admin123"));
        admin.setNickname("管理员");
        admin.setRole("ADMIN");
        admin.setStatus(1);
        userMapper.insert(admin);
        log.info("Default admin created: admin / admin123（请尽快修改）");
    }

    private void initMnistDataset() {
        Long count = datasetMapper.selectCount(null);
        if (count > 0) {
            return;
        }
        Dataset dataset = new Dataset();
        dataset.setName("MNIST");
        dataset.setType("MNIST");
        dataset.setSampleCount(70000);
        dataset.setStoragePath("data/mnist");
        dataset.setDescription("PyTorch 内置 MNIST 数据集（训练时自动下载）");
        datasetMapper.insert(dataset);
        log.info("Default MNIST dataset created");
    }
}
