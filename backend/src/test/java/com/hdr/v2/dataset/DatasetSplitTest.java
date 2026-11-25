package com.hdr.v2.dataset;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 数据划分规则：沿用旧划分优先、RANDOM 按样本哈希、WRITER 按书写者哈希。
 * 这几条不变量一旦破了，"补数据后重建"就会把测试集洗掉，指标也没法跨版本比较。
 */
class DatasetSplitTest {

    @Test
    void inheritedSplitAlwaysWins() {
        // 即便百分比改成 50/50，老样本也保持原来的划分
        for (int sampleId = 0; sampleId < 200; sampleId += 1) {
            assertEquals("TEST", DatasetService.resolveSplit("TEST", 1, sampleId, "9", 50, 50, "RANDOM"));
            assertEquals("TRAIN", DatasetService.resolveSplit("TRAIN", 1, sampleId, "9", 50, 50, "RANDOM"));
        }
    }

    @Test
    void withoutInheritanceItFallsBackToHash() {
        String expected = DatasetService.splitOf(1, 42, "7", 15, 15, "RANDOM");
        assertTrue(Set.of("TRAIN", "VAL", "TEST").contains(expected), expected);
        assertEquals(expected, DatasetService.resolveSplit(null, 1, 42, "7", 15, 15, "RANDOM"));
    }

    @Test
    void randomSplitIsDeterministicPerSample() {
        assertEquals(DatasetService.splitOf(1, 42, "7", 15, 15, "RANDOM"),
                DatasetService.splitOf(1, 42, "7", 15, 15, "RANDOM"));
        // 同一份样本换个数据集 id 就是另一套划分（不同数据集本来就不是同一批样本）
        assertNotEquals(counts(1), counts(2));
    }

    @Test
    void writerSplitKeepsOneWriterInOneSplit() {
        Map<String, Set<String>> byWriter = new HashMap<>();
        for (long sampleId = 0; sampleId < 500; sampleId += 1) {
            String writer = String.valueOf(sampleId % 7);
            String split = DatasetService.splitOf(3, sampleId, writer, 15, 15, "WRITER");
            byWriter.computeIfAbsent(writer, key -> new HashSet<>()).add(split);
        }
        assertEquals(7, byWriter.size());
        byWriter.forEach((writer, splits) ->
                assertEquals(1, splits.size(), "书写者 " + writer + " 被拆到了多个划分：" + splits));
    }

    @Test
    void percentagesRoughlyMatchTheRequestedRatio() {
        Map<String, Integer> result = counts(1);
        int total = result.values().stream().mapToInt(Integer::intValue).sum();
        assertEquals(2000, total);
        double test = result.get("TEST") / (double) total;
        double val = result.get("VAL") / (double) total;
        // 哈希分桶与实际比例允许有偏差，但不该离谱
        assertTrue(test > 0.10 && test < 0.20, "TEST 占比 " + test);
        assertTrue(val > 0.10 && val < 0.20, "VAL 占比 " + val);
        assertTrue(result.get("TRAIN") > total * 0.6, "TRAIN 应占多数：" + result);
    }

    @Test
    void everythingIsTrainWhenBothRatiosAreZero() {
        // 样本很少时后端会把比例清零，此时不该出现验证/测试样本
        for (long sampleId = 0; sampleId < 100; sampleId += 1)
            assertEquals("TRAIN", DatasetService.splitOf(1, sampleId, "1", 0, 0, "RANDOM"));
    }

    private Map<String, Integer> counts(long datasetId) {
        Map<String, Integer> result = new HashMap<>(Map.of("TRAIN", 0, "VAL", 0, "TEST", 0));
        for (long sampleId = 0; sampleId < 2000; sampleId += 1) {
            String split = DatasetService.splitOf(datasetId, sampleId, "1", 15, 15, "RANDOM");
            result.merge(split, 1, Integer::sum);
        }
        return result;
    }
}
