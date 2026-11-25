package com.hdr.v2.dataset;

import com.hdr.v2.recognition.ModelClient;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * CSV 列映射与多位数切分比例的纯逻辑。
 * 这两块最容易出错：列猜错了会静默丢样本，切分比例算错会画出误导性的图。
 */
class ImportWizardCsvTest {
    private static final List<String> HEADER = List.of("file", "digit", "writer");

    @Test
    void explicitColumnIsMatchedByHeaderNameIgnoringCaseAndSpaces() {
        assertEquals(0, ImportWizardService.resolveColumn(HEADER, " FILE ", true));
        assertEquals(1, ImportWizardService.resolveColumn(HEADER, "Digit", false));
    }

    @Test
    void explicitColumnCanBeAOneBasedIndex() {
        assertEquals(2, ImportWizardService.resolveColumn(HEADER, "3", false));
        assertEquals(-1, ImportWizardService.resolveColumn(HEADER, "9", false));
        assertEquals(-1, ImportWizardService.resolveColumn(HEADER, "0", false));
    }

    @Test
    void explicitUnknownColumnDoesNotFallBackToKeywordGuess() {
        // 用户明确选了「不存在的列」时应报没找到，而不是悄悄用猜出来的那一列
        assertEquals(-1, ImportWizardService.resolveColumn(HEADER, "不存在", true));
    }

    @Test
    void columnsAreGuessedByKeywordWhenNoMappingGiven() {
        assertEquals(0, ImportWizardService.resolveColumn(List.of("文件名", "x"), null, true));
        assertEquals(0, ImportWizardService.resolveColumn(List.of("image_path", "x"), null, true));
        assertEquals(1, ImportWizardService.resolveColumn(List.of("x", "label"), null, false));
        assertEquals(0, ImportWizardService.resolveColumn(List.of("class", "x"), null, false));
        assertEquals(-1, ImportWizardService.resolveColumn(List.of("a", "b"), null, true));
        assertEquals(-1, ImportWizardService.resolveColumn(List.of("a", "b"), null, false));
    }

    @Test
    void chineseHeadersAreGuessedOnlyOnExactMatch() {
        // 中文表头常见写法：精确匹配能认出来
        assertEquals(0, ImportWizardService.resolveColumn(List.of("文件名", "标签"), null, true));
        assertEquals(1, ImportWizardService.resolveColumn(List.of("文件名", "标签"), null, false));
        assertEquals(0, ImportWizardService.resolveColumn(List.of("图片", "数字"), null, true));
        assertEquals(1, ImportWizardService.resolveColumn(List.of("图片", "数字"), null, false));
        // 但复合表头不做包含匹配，「标签路径」不能被当成文件列
        assertEquals(-1, ImportWizardService.resolveColumn(List.of("标签路径", "x"), null, true));
    }

    @Test
    void csvLineSupportsQuotedFieldsAndEscapedQuotes() {
        assertEquals(List.of("a.png", "7"), ImportWizardService.splitCsvLine("a.png,7"));
        assertEquals(List.of("a,b.png", "7"), ImportWizardService.splitCsvLine("\"a,b.png\",7"));
        assertEquals(List.of("say \"hi\".png", "3"), ImportWizardService.splitCsvLine("\"say \"\"hi\"\".png\",3"));
        assertEquals(List.of("a.png", "", "9"), ImportWizardService.splitCsvLine("a.png,,9"));
        assertEquals(List.of("a.png", "7"), ImportWizardService.splitCsvLine("a.png,7\r"));
    }

    @Test
    void cutSegmentsAreNormalisedToTheDetectedSpan() {
        // 检测到 20..120 共 100 宽，三段各占 20–40 / 45–70 / 80–120
        List<ModelClient.MultiDigit> digits = List.of(
                new ModelClient.MultiDigit(3, .9, .8, 20, 40),
                new ModelClient.MultiDigit(5, .8, .7, 45, 70),
                new ModelClient.MultiDigit(1, .95, .9, 80, 120));
        List<ImportWizardService.CutDigit> cuts = ImportWizardService.cutDigits(digits);
        assertEquals(3, cuts.size());
        assertEquals(0.0, cuts.get(0).from(), 1e-9);
        assertEquals(0.2, cuts.get(0).to(), 1e-9);
        assertEquals(0.25, cuts.get(1).from(), 1e-9);
        assertEquals(0.5, cuts.get(1).to(), 1e-9);
        assertEquals(0.6, cuts.get(2).from(), 1e-9);
        assertEquals(1.0, cuts.get(2).to(), 1e-9);
        assertEquals(3, cuts.get(0).digit());
        assertEquals(0.9, cuts.get(0).confidence(), 1e-9);
    }

    @Test
    void singleOrEmptySegmentsDoNotDivideByZero() {
        assertTrue(ImportWizardService.cutDigits(List.of()).isEmpty());
        assertTrue(ImportWizardService.cutDigits(null).isEmpty());
        List<ImportWizardService.CutDigit> one =
                ImportWizardService.cutDigits(List.of(new ModelClient.MultiDigit(4, .5, .5, 30, 30)));
        assertEquals(1, one.size());
        assertEquals(0.0, one.get(0).from(), 1e-9);
        assertEquals(0.0, one.get(0).to(), 1e-9);
    }

    @Test
    void mappingKnowsWhenItIsEmpty() {
        assertTrue(new ImportWizardService.CsvMapping(null, " ").isEmpty());
        assertFalse(new ImportWizardService.CsvMapping("file", null).isEmpty());
    }
}
