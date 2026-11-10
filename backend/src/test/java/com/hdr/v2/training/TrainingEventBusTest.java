package com.hdr.v2.training;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 事件总线只做纯逻辑验证：票据一次性、订阅上限、发布不炸。 */
class TrainingEventBusTest {
    private final TrainingEventBus bus = new TrainingEventBus(new ObjectMapper());

    @Test
    void ticketIsSingleUseAndBoundToUser() {
        String ticket = bus.issueTicket(7L);
        assertEquals(7L, bus.consumeTicket(ticket));
        V2Exception reused = assertThrows(V2Exception.class, () -> bus.consumeTicket(ticket));
        assertEquals(401, reused.getStatus());
        assertEquals("UNAUTHORIZED", reused.getCategory());
    }

    @Test
    void blankOrOversizedTicketsAreRejected() {
        for (String value : new String[]{null, "", "   ", "x".repeat(65)}) {
            V2Exception error = assertThrows(V2Exception.class, () -> bus.consumeTicket(value));
            assertEquals(401, error.getStatus());
        }
    }

    @Test
    void subscribingBeyondLimitIsRefused() {
        for (int index = 0; index < 5; index++) assertNotNull(bus.subscribe(3L));
        V2Exception error = assertThrows(V2Exception.class, () -> bus.subscribe(3L));
        assertEquals(429, error.getStatus());
        assertEquals("CONCURRENCY_LIMIT", error.getCategory());
    }

    @Test
    void publishingWithNoSubscribersIsANoOp() {
        assertDoesNotThrow(() -> bus.publish(task("QUEUED")));
        assertEquals(0, bus.subscriberCount());
    }

    @Test
    void droppingAnEmitterFreesTheSlot() {
        SseEmitter emitter = bus.subscribe(11L);
        assertEquals(1, bus.subscriberCount());
        bus.remove(11L, emitter);
        assertEquals(0, bus.subscriberCount());
        // 槽位释放后可以重新订阅，不会永久占满。
        assertNotNull(bus.subscribe(11L));
    }

    static TrainingService.TaskView task(String status) {
        return new TrainingService.TaskView("1", status, 1, "celery-1", 1, 1000, 64, 0.001, 42, .5, false,
                null, "1", null, null, null, 1000L, null, null, "2026-11-08T00:00:00Z", null, null, null);
    }

    static List<String> statuses() {
        return List.of("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED");
    }
}
