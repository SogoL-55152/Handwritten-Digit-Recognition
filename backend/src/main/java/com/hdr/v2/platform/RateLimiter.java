package com.hdr.v2.platform;

public interface RateLimiter {
    void check(String key, int capacity, int seconds);
}
