package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 异步导入任务里与数据库无关的两小块逻辑：进度百分比与来源类型校验。
 * 任务本身的状态机由真实 MySQL 的端到端验证覆盖（见 docs/导入异步化-设计与交付.md）。
 */
class ImportJobViewTest {

    private ImportJobService.JobView view(int total, int done) {
        return new ImportJobService.JobView("1", "2", "RUNNING", "DIRECTORY", total, done,
                0, 0, 0, null, null, false, "/tmp/x", null, null, null);
    }

    @Test
    void percentIsNullUntilScanFinished() {
        assertNull(view(0, 0).percent());
        assertNull(view(0, 5).percent());
    }

    @Test
    void percentReportsProgressAndCapsAtHundred() {
        assertEquals(0.0, view(200, 0).percent());
        assertEquals(25.0, view(200, 50).percent());
        assertEquals(100.0, view(200, 200).percent());
        assertEquals(100.0, view(200, 500).percent());
    }

    @Test
    void percentKeepsOneDecimal() {
        assertEquals(33.3, view(3, 1).percent());
        assertEquals(66.7, view(3, 2).percent());
    }

    @Test
    void sourceKindDefaultsToDirectoryAndIsCaseInsensitive() {
        assertEquals("DIRECTORY", ImportJobService.normalizeKind(null));
        assertEquals("ZIP", ImportJobService.normalizeKind("zip"));
        assertEquals("UPLOAD", ImportJobService.normalizeKind(" Upload "));
    }

    @Test
    void unknownSourceKindIsRejected() {
        V2Exception error = assertThrows(V2Exception.class, () -> ImportJobService.normalizeKind("SFTP"));
        assertEquals(400, error.getStatus());
        assertEquals("VALIDATION", error.getCategory());
    }
}
