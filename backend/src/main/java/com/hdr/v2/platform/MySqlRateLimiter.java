package com.hdr.v2.platform;

import com.hdr.v2.V2Exception;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class MySqlRateLimiter implements RateLimiter {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final AtomicLong lastCleanup = new AtomicLong();
    private final Clock clock;
    @org.springframework.beans.factory.annotation.Autowired
    public MySqlRateLimiter(JdbcTemplate jdbc, TransactionTemplate tx) { this(jdbc,tx,Clock.systemUTC()); }
    public MySqlRateLimiter(JdbcTemplate jdbc, TransactionTemplate tx, Clock clock) {
        this.jdbc=jdbc; this.tx=tx; this.clock=clock;
    }

    @Override
    public void check(String key, int capacity, int seconds) {
        if (capacity < 1 || seconds < 1) throw new IllegalArgumentException("Invalid rate window");
        long now = clock.instant().getEpochSecond();
        long start = now / seconds * seconds;
        String bucket = digest(key);
        boolean allowed = Boolean.TRUE.equals(tx.execute(status -> {
            // The upsert takes an exclusive duplicate-key lock; INSERT IGNORE would first
            // take shared locks and competing writers could deadlock on the UPDATE below.
            jdbc.update("INSERT INTO t_rate_window(bucket_key,window_start,hits,expires_at) VALUES(?,?,0,?) ON DUPLICATE KEY UPDATE bucket_key=VALUES(bucket_key)",bucket,start,start+seconds);
            return jdbc.update("UPDATE t_rate_window SET hits=hits+1 WHERE bucket_key=? AND window_start=? AND hits<?",bucket,start,capacity)==1;
        }));
        long previous=lastCleanup.get();
        if(now-previous>=60 && lastCleanup.compareAndSet(previous,now)) {
            jdbc.update("DELETE FROM t_rate_window WHERE expires_at<? LIMIT 1000",now-60);
        }
        if (!allowed) throw new V2Exception(429,"请求过于频繁，请稍后重试","RATE_LIMIT",(int)(start+seconds-now));
    }
    private static String digest(String input) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8))); }
        catch(NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
