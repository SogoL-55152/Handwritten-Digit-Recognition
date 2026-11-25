package com.hdr.v2.model;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 数据集样本的 label 列是 VARCHAR，不是数字类型：
 * 早期实现直接强转 Number，运行期抛 ClassCastException 被"跳过"分支吞掉，
 * 结果图片比标签多一张，对比接口报"图片与标签数量必须一致"。这里锁住解析行为。
 */
class ModelCompareLabelTest {

    @Test
    void parsesNumericAndTextualLabels() {
        assertEquals(Integer.valueOf(7), ModelCompareService.labelOf("7"));
        assertEquals(Integer.valueOf(0), ModelCompareService.labelOf(" 0 "));
        assertEquals(Integer.valueOf(9), ModelCompareService.labelOf(9));
        assertEquals(Integer.valueOf(3), ModelCompareService.labelOf(3L));
    }

    @Test
    void unusableLabelsBecomeNull() {
        assertNull(ModelCompareService.labelOf(null));
        assertNull(ModelCompareService.labelOf(""));
        assertNull(ModelCompareService.labelOf("七"));
        assertNull(ModelCompareService.labelOf("3.5"));
    }
}
