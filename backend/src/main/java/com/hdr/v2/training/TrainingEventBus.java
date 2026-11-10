package com.hdr.v2.training;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 训练任务实时推送（SSE）。浏览器 EventSource 不能带 Authorization 头，
 * 因此先由已鉴权接口换一张单次票据，再用票据订阅；票据 120 秒过期、用一次即废。
 */
@Component
public class TrainingEventBus {
    private static final Logger LOG = LoggerFactory.getLogger(TrainingEventBus.class);
    private static final long TICKET_TTL_MILLIS = 120_000L;
    private static final int MAX_SUBSCRIBERS_PER_USER = 5;
    private static final int MAX_TICKETS = 5_000;
    private record Ticket(long userId, long expiresAtMillis) {}

    private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();
    private final Map<Long, Set<SseEmitter>> subscribers = new ConcurrentHashMap<>();
    private final ObjectMapper mapper;
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "training-sse-heartbeat");
        thread.setDaemon(true);
        return thread;
    });

    public TrainingEventBus(ObjectMapper mapper) {
        this.mapper = mapper;
        heartbeat.scheduleAtFixedRate(this::ping, 25, 25, TimeUnit.SECONDS);
    }

    public String issueTicket(long userId) {
        purgeExpiredTickets();
        if (tickets.size() >= MAX_TICKETS) throw new V2Exception(429, "实时订阅请求过于频繁", "CONCURRENCY_LIMIT");
        String value = UUID.randomUUID().toString();
        tickets.put(value, new Ticket(userId, System.currentTimeMillis() + TICKET_TTL_MILLIS));
        return value;
    }

    /** 票据只能用一次：消费即删除，过期或不存在都按未授权处理。 */
    public long consumeTicket(String value) {
        if (value == null || value.isBlank() || value.length() > 64)
            throw new V2Exception(401, "订阅票据无效或已过期", "UNAUTHORIZED");
        Ticket ticket = tickets.remove(value);
        if (ticket == null || ticket.expiresAtMillis() < System.currentTimeMillis())
            throw new V2Exception(401, "订阅票据无效或已过期", "UNAUTHORIZED");
        return ticket.userId();
    }

    public SseEmitter subscribe(long userId) {
        Set<SseEmitter> emitters = subscribers.computeIfAbsent(userId, key -> ConcurrentHashMap.newKeySet());
        if (emitters.size() >= MAX_SUBSCRIBERS_PER_USER)
            throw new V2Exception(429, "同一账号的实时连接过多", "CONCURRENCY_LIMIT");
        SseEmitter emitter = new SseEmitter(30 * 60 * 1000L);
        emitters.add(emitter);
        emitter.onCompletion(() -> remove(userId, emitter));
        emitter.onTimeout(() -> { remove(userId, emitter); emitter.complete(); });
        emitter.onError(error -> remove(userId, emitter));
        try {
            emitter.send(SseEmitter.event().name("ready").data("{}", MediaType.APPLICATION_JSON));
        } catch (IOException | IllegalStateException failure) {
            remove(userId, emitter);
        }
        return emitter;
    }

    public void publish(TrainingService.TaskView task) {
        if (subscribers.isEmpty()) return;
        String payload;
        try {
            payload = mapper.writeValueAsString(task);
        } catch (JsonProcessingException failure) {
            LOG.warn("Training event serialization failed ({})", failure.getClass().getSimpleName());
            return;
        }
        subscribers.forEach((userId, emitters) -> emitters.forEach(emitter -> {
            try {
                emitter.send(SseEmitter.event().name("task").data(payload, MediaType.APPLICATION_JSON));
            } catch (IOException | IllegalStateException failure) {
                remove(userId, emitter);
            }
        }));
    }

    int subscriberCount() {
        return subscribers.values().stream().mapToInt(Set::size).sum();
    }

    private void ping() {
        subscribers.forEach((userId, emitters) -> emitters.forEach(emitter -> {
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (IOException | IllegalStateException failure) {
                remove(userId, emitter);
            }
        }));
    }

    /** 包内可见：容器回调与测试都要能显式清理（SseEmitter.complete 在单测里不会同步回调）。 */
    void remove(long userId, SseEmitter emitter) {
        Set<SseEmitter> emitters = subscribers.get(userId);
        if (emitters == null) return;
        emitters.remove(emitter);
        if (emitters.isEmpty()) subscribers.remove(userId, emitters);
    }

    private void purgeExpiredTickets() {
        long now = System.currentTimeMillis();
        tickets.entrySet().removeIf(entry -> entry.getValue().expiresAtMillis() < now);
    }
}
