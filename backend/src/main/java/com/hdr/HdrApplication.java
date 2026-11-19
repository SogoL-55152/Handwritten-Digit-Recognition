package com.hdr;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@org.springframework.scheduling.annotation.EnableScheduling
@MapperScan("com.hdr.mapper")
public class HdrApplication {

    public static void main(String[] args) {
        SpringApplication.run(HdrApplication.class, args);
    }
}
