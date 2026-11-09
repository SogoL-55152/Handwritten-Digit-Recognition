package com.hdr.v2.migration;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class W1UpgradeHelperTest {
    @Test
    void validatorDerivesAllFiveLegacyTablesFromImmutableV1() {
        var shape = W1UpgradeHelper.baselineShape();
        assertEquals(5, shape.size());
        assertEquals(9, shape.get("t_user").columns().size());
        assertEquals(new W1UpgradeHelper.ColumnShape("bigint", false, null, "auto_increment"),
                shape.get("t_user").columns().get("id"));
        assertEquals(new W1UpgradeHelper.IndexShape(false, "username"), shape.get("t_user").indexes().get("uk_username"));
        assertEquals("CURRENT_TIMESTAMP", shape.get("t_user").columns().get("updated_at").defaultValue());
        assertEquals("on update current_timestamp", shape.get("t_user").columns().get("updated_at").extra());
    }
}
