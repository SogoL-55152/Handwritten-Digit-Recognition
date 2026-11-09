package com.hdr.v2.platform;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class W2LimitsTest {
    @Test
    void reportsEffectiveSettingsWithoutInventingDailyRemainingQuota() {
        var limits = new W2Limits(2, 30, 4, 500);
        var view = limits.view();
        assertEquals(2, view.get("maxWorkspaces"));
        assertEquals(30, view.get("recognitionPerMinute"));
        assertEquals(4, view.get("maxMembers"));
        assertEquals(500, view.get("dailyRecognitionLimit"));
        assertEquals(false, view.get("dailyQuotaEnforced"));
        assertNull(view.get("remainingDaily"));
        view.put("maxWorkspaces", 99);
        assertEquals(2, limits.view().get("maxWorkspaces"));
    }

    @Test
    void rejectsNonpositiveConfigurationAtStartup() {
        assertThrows(IllegalArgumentException.class, () -> new W2Limits(0, 60, 5, 1000));
        assertThrows(IllegalArgumentException.class, () -> new W2Limits(3, 0, 5, 1000));
        assertThrows(IllegalArgumentException.class, () -> new W2Limits(3, 60, 0, 1000));
        assertThrows(IllegalArgumentException.class, () -> new W2Limits(3, 60, 5, 0));
    }
}
