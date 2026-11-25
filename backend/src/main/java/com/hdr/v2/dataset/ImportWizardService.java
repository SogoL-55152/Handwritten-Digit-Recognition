package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.collection.CollectedSampleService;
import com.hdr.v2.recognition.ModelClient;
import com.hdr.v2.recognition.ImageValidator;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 智能导入：自动识别目录里的数据集形态（按类文件夹 / CSV / 文件名），先试运行再确认导入。
 * 只读取配置根目录（hdr.import.root）下的路径。
 */
@Service
public class ImportWizardService {
    private static final Logger LOG = LoggerFactory.getLogger(ImportWizardService.class);
    private static final int MAX_FILES = 20000;

    /** CSV 列映射：为空表示"自动猜"；猜不中时前端会把它变成可手动选择的项。 */
    public record CsvMapping(String fileColumn, String labelColumn) {
        public boolean isEmpty() { return isBlank(fileColumn) && isBlank(labelColumn); }
        private static boolean isBlank(String value) { return value == null || value.isBlank(); }
    }

    /** 预览里回给前端的 CSV 结构信息，用于渲染列名映射下拉。 */
    public record CsvInfo(String fileName, List<String> columns, int rows, String fileColumn, String labelColumn,
                          boolean matched, int unmatched) {}

    /** 多位数切分的一段：from/to 是"检测到的笔画整体跨度"内的相对位置（0..1）。 */
    public record CutDigit(int digit, double confidence, double from, double to) {}

    /** 一张被判为多位数的样例图：附缩略图与切分比例，供导入前肉眼确认。 */
    public record CutSample(String sample, String thumbnail, String text, List<CutDigit> digits) {}

    public record Preview(String format, int total, Map<String, Integer> labels, int skipped,
                          Map<String, Integer> skippedDetail, List<String> samples, String note,
                          String token, SelfCheck selfCheck, CsvInfo csv, List<CutSample> cutSamples) {}

    /** 抽样自检：用当前生效模型看这批图"像不像数字"。 */
    public record SelfCheck(int checked, int accepted, double avgConfidence, String note,
                            int multiChecked, int multiCount) {}

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final CollectedSampleService samples;
    private final ModelClient models;
    private final CatalogueService catalogue;
    private final Path root;
    private final List<Path> allowedRoots;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;
    private final String python;
    private final String bboxScript;

    public ImportWizardService(JdbcTemplate jdbc, WorkspaceService spaces, CollectedSampleService samples,
                               ModelClient models, CatalogueService catalogue,
                               com.fasterxml.jackson.databind.ObjectMapper mapper,
                               @Value("${hdr.import.root:.}") String root,
                               @Value("${hdr.import.python:python}") String python,
                               @Value("${hdr.import.bboxScript:model-service/tools/bbox_crop.py}") String bboxScript) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.samples = samples;
        this.models = models;
        this.catalogue = catalogue;
        List<Path> roots = new ArrayList<>();
        for (String part : root.split("[;,]")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            try {
                roots.add(Paths.get(trimmed).toAbsolutePath().normalize());
            } catch (RuntimeException ignored) {
                // 非法路径直接忽略
            }
        }
        if (roots.isEmpty()) roots.add(Paths.get(".").toAbsolutePath().normalize());
        this.allowedRoots = List.copyOf(roots);
        this.root = this.allowedRoots.get(0);
        this.mapper = mapper;
        this.python = python;
        this.bboxScript = Paths.get(bboxScript).isAbsolute() ? bboxScript
                : Paths.get(System.getProperty("user.dir")).resolve(bboxScript).toString();
    }

    private Path resolve(String directory) {
        if (directory == null || directory.isBlank()) throw new V2Exception(400, "缺少目录路径", "VALIDATION");
        Path dir = Paths.get(directory).toAbsolutePath().normalize();
        boolean allowed = allowedRoots.stream().anyMatch(dir::startsWith);
        if (!allowed) {
            String roots = String.join("、", allowedRoots.stream().map(Path::toString).toList());
            throw new V2Exception(400, "目录必须位于允许的根目录下：" + roots, "PATH_NOT_ALLOWED");
        }
        if (!Files.isDirectory(dir)) throw new V2Exception(400, "目录不存在：" + dir, "PATH_NOT_FOUND");
        return dir;
    }

    /** 方案A：把浏览器选中的文件夹上传到临时目录，返回识别结果与 token。 */
    public Map<String, Object> uploadPreview(long workspaceId, long userId,
                                             java.util.List<org.springframework.web.multipart.MultipartFile> files,
                                             java.util.List<String> paths) {
        spaces.requireMember(workspaceId, userId);
        if (files == null || files.isEmpty())
            throw new V2Exception(400, "没有收到文件", "VALIDATION");
        if (files.size() > 5000)
            throw new V2Exception(400, "一次最多上传 5000 个文件；更多请改用 zip 或服务器目录", "TOO_MANY_FILES");
        String token = java.util.UUID.randomUUID().toString();
        Path uploadRoot = root.resolve(".hdr-upload");
        Path target = uploadRoot.resolve(token).normalize();
        if (!target.startsWith(uploadRoot)) throw new V2Exception(400, "非法上传路径", "VALIDATION");
        try {
            Files.createDirectories(target);
            for (int index = 0; index < files.size(); index += 1) {
                String relative = paths != null && paths.size() > index ? paths.get(index) : files.get(index).getOriginalFilename();
                if (relative == null || relative.isBlank()) continue;
                Path destination = target.resolve(relative.replace('\\', '/')).normalize();
                if (!destination.startsWith(target)) continue;
                Files.createDirectories(destination.getParent() == null ? target : destination.getParent());
                files.get(index).transferTo(destination);
            }
        } catch (java.io.IOException error) {
            throw new V2Exception(503, "上传目录写入失败，请重试", "STORAGE_UNAVAILABLE");
        }
        Preview preview = scan(workspaceId, target, null);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("token", token);
        body.put("preview", preview);
        return body;
    }

    /** 方案A：确认导入后立即清理临时目录。 */
    public Map<String, Object> commitUpload(long workspaceId, long userId, long datasetId, String token) {
        if (token == null || !token.matches("[0-9a-fA-F-]{36}"))
            throw new V2Exception(400, "上传标识不合法", "VALIDATION");
        Path uploadRoot = root.resolve(".hdr-upload");
        Path target = uploadRoot.resolve(token).normalize();
        if (!target.startsWith(uploadRoot) || !Files.isDirectory(target))
            throw new V2Exception(400, "上传内容已过期，请重新选择文件夹", "UPLOAD_EXPIRED");
        try {
            return commit(workspaceId, userId, datasetId, target.toString(), null);
        } finally {
            deleteTree(target);
        }
    }

    private void deleteTree(Path target) {
        try (Stream<Path> stream = Files.walk(target)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (java.io.IOException ignored) { }
            });
        } catch (java.io.IOException ignored) {
            // 清理失败不影响导入结果
        }
    }

    public Preview preview(long workspaceId, long userId, String directory, CsvMapping mapping) {
        spaces.requireMember(workspaceId, userId);
        return scan(workspaceId, resolve(directory), mapping);
    }

    /** 上传 zip：解压到临时目录，返回预览与 token（确认导入时用 token）。 */
    public Preview previewZip(long workspaceId, long userId, MultipartFile file) {
        spaces.requireMember(workspaceId, userId);
        LOG.info("zip 导入预览: name={}, size={}MB", file.getOriginalFilename(),
                Math.round(file.getSize() / 1024.0 / 1024.0));
        Path temp = extractZip(file);
        Preview preview = scan(workspaceId, temp, null);
        return new Preview(preview.format(), preview.total(), preview.labels(), preview.skipped(),
                preview.skippedDetail(), preview.samples(), preview.note(), temp.toString(),
                preview.selfCheck(), preview.csv(), preview.cutSamples());
    }

    public Map<String, Object> commitZip(long workspaceId, long userId, long datasetId, String token) {
        Path temp = Paths.get(token).toAbsolutePath().normalize();
        if (!temp.startsWith(root) || !Files.isDirectory(temp))
            throw new V2Exception(400, "临时目录无效或已过期", "TOKEN_INVALID");
        Map<String, Object> result = commit(workspaceId, userId, datasetId, temp.toString(), null);
        try (Stream<Path> stream = Files.walk(temp)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        } catch (IOException error) {
            LOG.warn("清理临时目录失败 ({})", error.getClass().getSimpleName());
        }
        return result;
    }

    private Path extractZip(MultipartFile file) {
        if (file == null || file.isEmpty()) throw new V2Exception(400, "没有选择 zip 文件", "VALIDATION");
        Path dir = root.resolve(".hdr-import-tmp").resolve(java.util.UUID.randomUUID().toString());
        try {
            Files.createDirectories(dir);
            Path zip = dir.resolve("upload.zip");
            file.transferTo(zip);
            try (java.util.zip.ZipInputStream input = new java.util.zip.ZipInputStream(Files.newInputStream(zip))) {
                java.util.zip.ZipEntry entry;
                int count = 0;
                while ((entry = input.getNextEntry()) != null && count < 50000) {
                    Path target = dir.resolve(entry.getName()).normalize();
                    if (!target.startsWith(dir)) continue;
                    if (entry.isDirectory()) { Files.createDirectories(target); continue; }
                    Files.createDirectories(target.getParent());
                    Files.copy(input, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    count += 1;
                }
            }
            Files.deleteIfExists(zip);
            LOG.info("zip 解压完成: {}", dir.getFileName());
            return dir;
        } catch (IOException error) {
            throw new V2Exception(400, "zip 解压失败", "ZIP_INVALID");
        }
    }

    /** 导入进度与取消的回调。同步导入用 none()；异步任务用它把进度写回任务表。 */
    public interface ProgressSink {
        void progress(int done, int total);
        boolean canceled();

        static ProgressSink none() {
            return new ProgressSink() {
                @Override public void progress(int done, int total) { }
                @Override public boolean canceled() { return false; }
            };
        }
    }

    /** 已经校验、扫描并建好批次、可以开始逐张导入的中间状态。 */
    public record PreparedImport(long batchId, String format, Path directory, Path bboxCrops,
                                 Preview preview, CsvMapping mapping) {}

    public record ImportOutcome(int imported, int duplicates, int failed, boolean canceled) {}

    /** 数据集必须存在、属于该工作空间、可写（非公共、未停用）。导入前与建异步任务时都要过这关。 */
    public void assertDatasetEditable(long workspaceId, long datasetId) {
        List<Map<String, Object>> found = jdbc.queryForList(
                "SELECT scope, workspace_id, status FROM t_v2_dataset WHERE id=?", datasetId);
        if (found.isEmpty()) throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
        Map<String, Object> datasetRow = found.get(0);
        if (!"ACTIVE".equals(datasetRow.get("status")))
            throw new V2Exception(404, "数据集已停用，不能导入", "DATASET_NOT_FOUND");
        if ("PUBLIC".equals(datasetRow.get("scope")))
            throw new V2Exception(409, "公共数据集只读，请选择你自己的数据集再导入", "DATASET_PUBLIC");
        Object owner = datasetRow.get("workspace_id");
        if (owner == null || ((Number) owner).longValue() != workspaceId)
            throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
    }

    /** 服务器目录必须先过「允许的根目录」白名单，返回规范化后的绝对路径。 */
    public String requireDirectory(String directory) {
        return resolve(directory).toString();
    }

    /**
     * 校验 zip / 浏览器上传产生的临时目录：只接受 root 下 .hdr-import-tmp 或 .hdr-upload 里的路径，
     * 避免把任意目录当成"待清理的临时目录"传进来。
     */
    public Path resolveTemp(String token, String kind) {
        if (token == null || token.isBlank())
            throw new V2Exception(400, "缺少临时目录标识", "VALIDATION");
        Path base = "UPLOAD".equals(kind) ? root.resolve(".hdr-upload") : root.resolve(".hdr-import-tmp");
        Path dir;
        if ("UPLOAD".equals(kind)) {
            if (!token.matches("[0-9a-fA-F-]{36}"))
                throw new V2Exception(400, "上传标识不合法", "VALIDATION");
            dir = base.resolve(token).normalize();
        } else {
            dir = Paths.get(token).toAbsolutePath().normalize();
        }
        if (!dir.startsWith(base) || !Files.isDirectory(dir))
            throw new V2Exception(400, "临时目录无效或已过期", "TOKEN_INVALID");
        return dir;
    }

    /** 校验 + 扫描 + 建批次。同步与异步两条路都先走这里。 */
    public PreparedImport prepare(long workspaceId, long userId, long datasetId, String directory,
                                  CsvMapping mapping) {
        spaces.requireMember(workspaceId, userId);
        assertDatasetEditable(workspaceId, datasetId);
        Path dir = resolve(directory);
        Path bboxCrops = null;
        if ("bbox".equals(detectFormat(dir, new LinkedHashMap<>()))) {
            Path labels = findLabelsMat(dir);
            bboxCrops = root.resolve(".hdr-crops").resolve(java.util.UUID.randomUUID().toString());
            try {
                Files.createDirectories(bboxCrops);
            } catch (IOException error) {
                throw new V2Exception(500, "无法创建临时目录", "CROP_FAILED");
            }
            runBboxScript(labels.getParent(), labels, bboxCrops, false);
            dir = bboxCrops;
        }
        Preview preview = scan(workspaceId, dir, mapping);
        if (preview.total() == 0)
            throw new V2Exception(400, csvBlocked(preview) ? csvNote() : "没有识别到可导入的图片，请检查目录结构",
                    csvBlocked(preview) ? "CSV_COLUMNS_UNMAPPED" : "NO_SAMPLES");
        long batchId = insertBatch(workspaceId, datasetId, preview.format(), dir.toString(), userId);
        return new PreparedImport(batchId, preview.format(), dir, bboxCrops, preview, mapping);
    }

    /** 逐张导入；每 25 张汇报一次进度，每个文件前检查一次取消标记。 */
    public ImportOutcome runPrepared(PreparedImport prepared, long workspaceId, long userId, long datasetId,
                                     ProgressSink sink) {
        Preview preview = prepared.preview();
        Path dir = prepared.directory();
        long batchId = prepared.batchId();
        int total = preview.total();
        int imported = 0;
        int duplicates = 0;
        int failed = 0;
        int done = 0;
        boolean canceled = false;
        // CSV 的文件→标签映射只解析一次，避免每个标签都重读一遍 csv
        Map<String, Integer> csvLabels = "csv".equals(preview.format())
                ? csvTable(dir, prepared.mapping()).labels() : Map.of();
        for (Map.Entry<String, Integer> row : preview.labels().entrySet()) {
            int label = Integer.parseInt(row.getKey());
            for (Path file : imagesForLabel(dir, preview.format(), label, csvLabels)) {
                if (sink.canceled()) { canceled = true; break; }
                try {
                    byte[] bytes = Files.readAllBytes(file);
                    String digest = sha256(bytes);
                    String type = file.getFileName().toString().toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                    CollectedSampleService.Saved saved = samples.save(workspaceId, userId, label, null, true,
                            new ImageValidator.Image(bytes, digest, type), null, null, null, null, null, "IMPORT", datasetId);
                    if (saved.duplicate()) duplicates += 1;
                    else {
                        imported += 1;
                        jdbc.update("UPDATE t_collected_sample SET import_batch_id=? WHERE id=?", batchId, saved.id());
                    }
                } catch (IOException | V2Exception error) {
                    failed += 1;
                }
                done += 1;
                if (done % 25 == 0) sink.progress(done, total);
            }
            if (canceled) break;
        }
        sink.progress(done, total);
        finishBatch(batchId, preview, imported, failed);
        return new ImportOutcome(imported, duplicates, failed, canceled);
    }

    private void finishBatch(long batchId, Preview preview, int imported, int failed) {
        jdbc.update("UPDATE t_import_batch SET imported=?, skipped=?, skipped_detail=? WHERE id=?",
                imported, preview.skipped() + failed, truncate(skippedText(preview, failed)), batchId);
    }

    private void cleanupBbox(PreparedImport prepared) {
        if (prepared.bboxCrops() == null) return;
        try (Stream<Path> stream = Files.walk(prepared.bboxCrops())) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        } catch (IOException error) {
            LOG.warn("清理裁剪目录失败 ({})", error.getClass().getSimpleName());
        }
    }

    @Transactional
    public Map<String, Object> commit(long workspaceId, long userId, long datasetId, String directory,
                                      CsvMapping mapping) {
        PreparedImport prepared = prepare(workspaceId, userId, datasetId, directory, mapping);
        try {
            if ("idx".equals(prepared.format())) {
                int[] counts = importIdx(workspaceId, userId, datasetId, prepared.batchId(), prepared.directory());
                Map<String, Object> idxResult = new LinkedHashMap<>();
                idxResult.put("batchId", Long.toString(prepared.batchId()));
                idxResult.put("format", "idx");
                idxResult.put("imported", counts[0]);
                idxResult.put("duplicates", 0);
                idxResult.put("failed", counts[1]);
                return idxResult;
            }
            ImportOutcome outcome = runPrepared(prepared, workspaceId, userId, datasetId, ProgressSink.none());
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("batchId", Long.toString(prepared.batchId()));
            result.put("format", prepared.format());
            result.put("imported", outcome.imported());
            result.put("duplicates", outcome.duplicates());
            result.put("failed", outcome.failed());
            return result;
        } finally {
            cleanupBbox(prepared);
        }
    }

    public List<Map<String, Object>> batches(long workspaceId, long userId) {
        spaces.requireMember(workspaceId, userId);
        return jdbc.queryForList("""
                SELECT b.*, d.name AS dataset_name FROM t_import_batch b
                LEFT JOIN t_v2_dataset d ON d.id = b.dataset_id
                WHERE b.workspace_id = ? ORDER BY b.id DESC LIMIT 50
                """, workspaceId);
    }

    @Transactional
    public Map<String, Object> rollback(long workspaceId, long userId, long batchId) {
        spaces.requireMember(workspaceId, userId);
        Map<String, Object> batch = jdbc.queryForList(
                "SELECT * FROM t_import_batch WHERE id=? AND workspace_id=?", batchId, workspaceId).stream()
                .findFirst().orElseThrow(() -> new V2Exception(404, "批次不存在", "BATCH_NOT_FOUND"));
        Long referenced = jdbc.queryForObject("""
                SELECT COUNT(*) FROM t_collected_sample c JOIN t_v2_dataset_sample s ON s.sample_id = c.id
                WHERE c.import_batch_id = ?
                """, Long.class, batchId);
        if (referenced != null && referenced > 0)
            throw new V2Exception(409, "该批次已有 " + referenced + " 条样本进入版本，不能回滚", "BATCH_IN_USE");
        int deleted = jdbc.update("DELETE FROM t_collected_sample WHERE import_batch_id=? AND workspace_id=?",
                batchId, workspaceId);
        jdbc.update("DELETE FROM t_import_batch WHERE id=?", batchId);
        return Map.of("deleted", deleted, "batchId", Long.toString(batchId));
    }

    // ---------- 扫描与格式识别 ----------

    private Preview scan(long workspaceId, Path dir, CsvMapping mapping) {
        Map<String, Integer> labels = new LinkedHashMap<>();
        Map<String, Integer> skipped = new LinkedHashMap<>();
        List<String> samples = new ArrayList<>();
        String format = detectFormat(dir, skipped);
        if ("bbox".equals(format)) return bboxPreview(dir);
        if ("idx".equals(format)) return idxPreview(dir);
        CsvTable csv = "csv".equals(format) ? csvTable(dir, mapping) : null;
        Map<String, Integer> csvLabels = csv == null ? Map.of() : csv.labels();
        if (csv != null && !csv.matched())
            skipped.merge("CSV 表头未匹配，请手动选择文件列与标签列", 1, Integer::sum);
        List<Path> files = listImages(dir, format);
        int total = 0;
        for (Path file : files) {
            if (total >= MAX_FILES) { skipped.merge("超过上限", 1, Integer::sum); break; }
            Integer label = labelOf(dir, file, format, skipped, csvLabels);
            if (label == null) continue;
            labels.merge(String.valueOf(label), 1, Integer::sum);
            total += 1;
            if (samples.size() < 6) samples.add(dir.relativize(file).toString().replace('\\', '/'));
        }
        String note = switch (format) {
            case "folder" -> "识别为「按类别分文件夹」：子目录名必须是 0–9";
            case "csv" -> csv != null && csv.matched()
                    ? "识别为「CSV 标签」：文件列「" + csv.fileColumn() + "」、标签列「" + csv.labelColumn() + "」"
                    : "识别为「CSV 标签」：表头没匹配上，请在下面手动选择文件列与标签列";
            default -> "识别为「文件名带标签」：取文件名中第一个数字作为标签";
        };
        SelfCheckOutcome outcome = total == 0 ? null : selfCheck(workspaceId, files, dir, format, skipped);
        CsvInfo info = csv == null ? null : new CsvInfo(csv.fileName(), csv.columns(), csv.rows(),
                csv.fileColumn(), csv.labelColumn(), csv.matched(), csv.unmatched());
        return new Preview(format, total, labels, skipped.values().stream().mapToInt(Integer::intValue).sum(),
                skipped, samples, note, null, outcome == null ? null : outcome.check(),
                info, outcome == null ? List.of() : outcome.cuts());
    }

    private record SelfCheckOutcome(SelfCheck check, List<CutSample> cuts) {}

    private static final int MAX_CUT_SAMPLES = 3;

    /** 抽最多 8 张，用生效模型预测一次；接受率很低说明这批图可能不是数字。 */
    private SelfCheckOutcome selfCheck(long workspaceId, List<Path> files, Path dir, String format,
                                       Map<String, Integer> skipped) {
        if (files.isEmpty()) return null;
        CatalogueService.Model model;
        try {
            model = catalogue.activeModel();
        } catch (RuntimeException error) {
            return null;
        }
        int checked = 0;
        int accepted = 0;
        double confidenceSum = 0;
        for (Path file : files) {
            if (checked >= 8) break;
            try {
                byte[] bytes = Files.readAllBytes(file);
                String type = file.getFileName().toString().toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                String digest = sha256(bytes);
                ModelClient.Prediction prediction = models.predict(workspaceId, java.util.UUID.randomUUID().toString(),
                        model, new ImageValidator.Image(bytes, digest, type), true);
                accepted += 1;
                confidenceSum += prediction.confidence();
            } catch (Exception error) {
                // 拒识或失败都算"不像数字"
            }
            checked += 1;
        }
        // 再抽样几张做「单字校验」：多位数图会被当成单字导入，标签必然错
        int multiChecked = 0;
        int multiCount = 0;
        List<CutSample> cuts = new ArrayList<>();
        for (Path file : files) {
            if (multiChecked >= 4) break;
            try {
                byte[] bytes = Files.readAllBytes(file);
                String type = file.getFileName().toString().toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                String digest = sha256(bytes);
                // maxDigits 用 4：只要 2 位就会拒识入库，所以 3–4 位也必须被检出并提示；
                // 早期写 2 会让三位数图直接 422，既不算"多位数"、也不给提示，属于静默漏检。
                ModelClient.MultiPrediction multi = models.predictMulti(workspaceId,
                        java.util.UUID.randomUUID().toString(), model,
                        new ImageValidator.Image(bytes, digest, type), 4, true);
                multiChecked += 1;
                if (multi.digits() != null && multi.digits().size() > 1) {
                    multiCount += 1;
                    // 留几张样例给前端画"会怎么切"，最多 3 张，避免预览响应膨胀
                    if (cuts.size() < MAX_CUT_SAMPLES) {
                        cuts.add(new CutSample(dir.relativize(file).toString().replace('\\', '/'),
                                thumbnail(bytes), multi.text(), cutDigits(multi.digits())));
                    }
                }
            } catch (Exception error) {
                // 切分失败不影响主流程
            }
        }
        if (checked == 0) return null;
        double avg = accepted == 0 ? 0 : confidenceSum / accepted;
        String note = accepted == 0
                ? "抽样 " + checked + " 张全部被拒识：这批图可能不是手写数字"
                : "抽样 " + checked + " 张，接受 " + accepted + " 张（平均置信度 " + String.format("%.2f", avg) + "）";
        if (multiCount > 0) {
            note += "；其中 " + multiCount + "/" + multiChecked + " 张含多个数字，导入后标签会错，建议先裁成单字";
        }
        return new SelfCheckOutcome(
                new SelfCheck(checked, accepted, Math.round(avg * 1000) / 1000.0, note, multiChecked, multiCount),
                List.copyOf(cuts));
    }

    /**
     * 把各段的 left/right 归一化到"检测到的笔画整体跨度"内（0..1）。
     * 坐标系是模型服务预处理后的画布，不是原图，所以只能在跨度内比比例，不能当原图坐标用。
     */
    static List<CutDigit> cutDigits(List<ModelClient.MultiDigit> digits) {
        if (digits == null || digits.isEmpty()) return List.of();
        int min = Integer.MAX_VALUE;
        int max = Integer.MIN_VALUE;
        for (ModelClient.MultiDigit digit : digits) {
            min = Math.min(min, digit.left());
            max = Math.max(max, digit.right());
        }
        int span = Math.max(1, max - min);
        List<CutDigit> result = new ArrayList<>(digits.size());
        for (ModelClient.MultiDigit digit : digits) {
            double from = Math.max(0, Math.min(1, (digit.left() - min) / (double) span));
            double to = Math.max(0, Math.min(1, (digit.right() - min) / (double) span));
            result.add(new CutDigit(digit.digit(), Math.round(digit.confidence() * 1000) / 1000.0,
                    Math.round(from * 1000) / 1000.0, Math.round(to * 1000) / 1000.0));
        }
        return result;
    }

    /** 96px 宽的 JPEG data URL，仅用于预览缩略图；失败返回 null（不影响导入）。 */
    private String thumbnail(byte[] bytes) {
        try {
            java.awt.image.BufferedImage image =
                    javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(bytes));
            if (image == null || image.getWidth() <= 0) return null;
            int width = Math.min(96, image.getWidth());
            int height = Math.max(1, (int) Math.round(image.getHeight() * (width / (double) image.getWidth())));
            java.awt.image.BufferedImage scaled =
                    new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
            java.awt.Graphics2D graphics = scaled.createGraphics();
            graphics.drawImage(image, 0, 0, width, height, java.awt.Color.WHITE, null);
            graphics.dispose();
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            javax.imageio.ImageIO.write(scaled, "jpg", buffer);
            return "data:image/jpeg;base64," + java.util.Base64.getEncoder().encodeToString(buffer.toByteArray());
        } catch (Exception error) {
            LOG.debug("缩略图生成失败 ({})", error.getClass().getSimpleName());
            return null;
        }
    }

    private String detectFormat(Path dir, Map<String, Integer> skipped) {
        if (IdxReader.isIdx(dir)) return "idx";
        if (hasLabelsMat(dir)) return "bbox";
        try (Stream<Path> children = Files.list(dir)) {
            List<Path> list = children.toList();
            if (list.stream().anyMatch(Files::isDirectory)) return "folder";
            if (list.stream().anyMatch(path -> path.getFileName().toString().toLowerCase().endsWith(".csv"))) return "csv";
        } catch (IOException error) {
            throw new V2Exception(400, "目录读取失败", "PATH_NOT_FOUND");
        }
        skipped.merge("没有类别目录或 csv，按文件名识别", 0, Integer::sum);
        return "filename";
    }

    /** IDX（MNIST/EMNIST）：只读标签统计，不解析图片。 */
    private Preview idxPreview(Path dir) {
        List<IdxReader.Pair> pairs = IdxReader.pairs(dir);
        if (pairs.isEmpty()) throw new V2Exception(400, "目录里没有 IDX 文件对（images-idx3 + labels-idx1）", "IDX_INVALID");
        Map<String, Integer> labels = IdxReader.countLabels(pairs);
        int total = labels.values().stream().mapToInt(Integer::intValue).sum();
        List<String> names = pairs.stream()
                .map(pair -> pair.images().getFileName().toString()
                        + (pair.emnist() ? "（EMNIST，按转置还原）" : ""))
                .toList();
        String note = "识别为「IDX（MNIST/EMNIST）」：逐张转 28×28 PNG 入库，压缩包会自动解压读取";
        return new Preview("idx", total, labels, 0, new LinkedHashMap<>(), names, note, null, null, null, List.of());
    }

    private int[] importIdx(long workspaceId, long userId, long datasetId, long batchId, Path dir) {
        List<IdxReader.Pair> pairs = IdxReader.pairs(dir);
        int[] imported = {0};
        int[] failed = {0};
        IdxReader.streamLabelsAndImages(pairs, (label, png) -> {
            try {
                String digest = sha256(png);
                CollectedSampleService.Saved saved = samples.save(workspaceId, userId, label, null, true,
                        new ImageValidator.Image(png, digest, "image/png"), null, null, null, null, null,
                        "IMPORT", datasetId);
                if (!saved.duplicate()) {
                    imported[0] += 1;
                    jdbc.update("UPDATE t_collected_sample SET import_batch_id=? WHERE id=?", batchId, saved.id());
                }
            } catch (Exception error) {
                failed[0] += 1;
            }
        });
        jdbc.update("UPDATE t_import_batch SET imported=?, skipped=?, skipped_detail=? WHERE id=?",
                imported[0], failed[0], failed[0] > 0 ? "转换/校验失败 " + failed[0] : null, batchId);
        return new int[]{imported[0], failed[0]};
    }

    private boolean hasLabelsMat(Path dir) {
        return findLabelsMat(dir) != null;
    }

    private Path findLabelsMat(Path dir) {
        try (Stream<Path> stream = Files.walk(dir, 3)) {
            return stream.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().equals("digitStruct.mat"))
                    .findFirst().orElse(null);
        } catch (IOException error) {
            return null;
        }
    }

    /** 带框数据集：先 dry-run 统计能裁出多少单字。 */
    private Preview bboxPreview(Path dir) {
        Path labels = findLabelsMat(dir);
        if (labels == null) throw new V2Exception(400, "没有找到 digitStruct.mat", "LABELS_NOT_FOUND");
        Path images = labels.getParent();
        com.fasterxml.jackson.databind.JsonNode summary = runBboxScript(images, labels, null, true);
        int digits = summary.path("digits").asInt();
        Map<String, Integer> labels2 = new LinkedHashMap<>();
        summary.path("perLabel").fields().forEachRemaining(entry -> labels2.put(entry.getKey(), entry.getValue().asInt()));
        Map<String, Integer> skipped = new LinkedHashMap<>();
        int multi = summary.path("skippedMulti").asInt();
        int small = summary.path("skippedSmall").asInt();
        if (multi > 0) skipped.put("多段未切开", multi);
        if (small > 0) skipped.put("框太小", small);
        String note = "识别为「带框标注（digitStruct.mat）」：每张图按框裁成单字，多段或过小的会跳过";
        return new Preview("bbox", digits, labels2, multi + small, skipped, List.of(), note, null, null, null, List.of());
    }

    private com.fasterxml.jackson.databind.JsonNode runBboxScript(Path images, Path labels, Path out, boolean dryRun) {
        List<String> command = new ArrayList<>(List.of(python, bboxScript,
                "--images", images.toString(), "--labels", labels.toString()));
        if (out != null) { command.add("--out"); command.add(out.toString()); }
        if (dryRun) command.add("--dry-run");
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.redirectErrorStream(true);
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            if (!process.waitFor(1800, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new V2Exception(503, "裁字脚本超时（超过 30 分钟）", "IMPORT_TIMEOUT");
            }
            String lastJson = null;
            for (String line : output.split("\\R")) {
                String trimmed = line.trim();
                if (trimmed.startsWith("{") && trimmed.endsWith("}")) lastJson = trimmed;
            }
            if (process.exitValue() != 0 || lastJson == null) {
                LOG.warn("bbox 脚本失败: {}", output.length() > 400 ? output.substring(output.length() - 400) : output);
                throw new V2Exception(400, "裁字失败，请检查 digitStruct.mat 与图片是否匹配", "CROP_FAILED");
            }
            return mapper.readTree(lastJson);
        } catch (IOException error) {
            throw new V2Exception(500, "无法启动裁字脚本（检查 hdr.import.python 配置）", "SCRIPT_UNAVAILABLE");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new V2Exception(500, "裁字被中断", "CROP_FAILED");
        }
    }

    private List<Path> listImages(Path dir, String format) {
        int depth = "folder".equals(format) ? 3 : 2;
        try (Stream<Path> stream = Files.walk(dir, depth)) {
            return stream.filter(Files::isRegularFile)
                    .filter(path -> {
                        String name = path.getFileName().toString().toLowerCase();
                        return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
                    })
                    .sorted()
                    .limit(MAX_FILES)
                    .toList();
        } catch (IOException error) {
            throw new V2Exception(400, "目录读取失败", "PATH_NOT_FOUND");
        }
    }

    /** CSV 解析结果：表头、行数、解析出的列名与「文件 → 标签」映射。 */
    private record CsvTable(String fileName, List<String> columns, int rows, String fileColumn,
                            String labelColumn, Map<String, Integer> labels, boolean matched, int unmatched) {}

    private final Map<String, CsvTable> csvCache = new java.util.concurrent.ConcurrentHashMap<>();

    private CsvTable csvTable(Path dir, CsvMapping mapping) {
        String fileColumn = mapping == null ? "" : String.valueOf(mapping.fileColumn());
        String labelColumn = mapping == null ? "" : String.valueOf(mapping.labelColumn());
        String key = dir.toAbsolutePath().normalize() + "|" + fileColumn + "|" + labelColumn;
        return csvCache.computeIfAbsent(key, ignored -> readCsv(dir, mapping));
    }

    private Integer labelOf(Path dir, Path file, String format, Map<String, Integer> skipped,
                            Map<String, Integer> csvLabels) {
        String relative = dir.relativize(file).toString().replace('\\', '/');
        if ("folder".equals(format)) {
            String head = relative.contains("/") ? relative.substring(0, relative.indexOf('/')) : "";
            if (head.matches("[0-9]")) return Integer.parseInt(head);
            skipped.merge("目录名不是 0–9", 1, Integer::sum);
            return null;
        }
        if ("csv".equals(format)) {
            Integer label = csvLabels.get(file.getFileName().toString());
            if (label == null) skipped.merge("csv 里没有这个文件", 1, Integer::sum);
            return label;
        }
        Matcher matcher = Pattern.compile("(?:^|[^0-9])([0-9])(?:[^0-9]|$)").matcher(file.getFileName().toString());
        if (matcher.find()) return Integer.parseInt(matcher.group(1));
        skipped.merge("文件名里没有数字", 1, Integer::sum);
        return null;
    }

    private CsvTable readCsv(Path dir, CsvMapping mapping) {
        Map<String, Integer> labels = new LinkedHashMap<>();
        Path csv = null;
        try (Stream<Path> stream = Files.list(dir)) {
            csv = stream.filter(path -> path.getFileName().toString().toLowerCase().endsWith(".csv"))
                    .findFirst().orElse(null);
        } catch (IOException error) {
            LOG.warn("CSV 目录读取失败 ({})", error.getClass().getSimpleName());
        }
        if (csv == null) return new CsvTable("", List.of(), 0, null, null, labels, false, 0);
        String name = csv.getFileName().toString();
        List<String> lines;
        try {
            lines = Files.readAllLines(csv, StandardCharsets.UTF_8);
        } catch (IOException error) {
            LOG.warn("CSV 读取失败 ({})", error.getClass().getSimpleName());
            return new CsvTable(name, List.of(), 0, null, null, labels, false, 0);
        }
        if (lines.isEmpty()) return new CsvTable(name, List.of(), 0, null, null, labels, false, 0);
        List<String> columns = splitCsvLine(lines.get(0)).stream().map(String::trim).toList();
        int fileIndex = resolveColumn(columns, mapping == null ? null : mapping.fileColumn(), true);
        int labelIndex = resolveColumn(columns, mapping == null ? null : mapping.labelColumn(), false);
        int rows = lines.size() - 1;
        if (fileIndex < 0 || labelIndex < 0 || fileIndex == labelIndex)
            return new CsvTable(name, columns, rows, null, null, labels, false, rows);
        int unmatched = 0;
        for (int index = 1; index < lines.size(); index += 1) {
            List<String> cells = splitCsvLine(lines.get(index));
            if (cells.size() <= Math.max(fileIndex, labelIndex)) { unmatched += 1; continue; }
            String fileName = cells.get(fileIndex).trim();
            String label = cells.get(labelIndex).trim();
            if (fileName.isEmpty()) { unmatched += 1; continue; }
            if (label.matches("[0-9]")) labels.put(fileName, Integer.parseInt(label));
            else unmatched += 1;
        }
        return new CsvTable(name, columns, rows, columns.get(fileIndex), columns.get(labelIndex),
                labels, true, unmatched);
    }

    /** 猜测列名时认可的表头（先精确匹配，再按英文关键字包含匹配）。 */
    private static final List<String> FILE_HEADERS = List.of("file", "filename", "file_name", "name", "image",
            "image_path", "path", "文件名", "文件", "图片名", "图片", "图像", "路径");
    private static final List<String> LABEL_HEADERS = List.of("label", "labels", "digit", "digits", "class", "y",
            "标签", "数字", "类别", "标注");

    /**
     * 先按显式映射（列名或 1 起的序号），没有再按表头猜；返回 -1 表示没找到。
     * 显式给了列名却找不到时**不回落**到猜测，否则用户选了某列却静默用了别的列，比报错更难查。
     */
    static int resolveColumn(List<String> columns, String wanted, boolean forFile) {
        if (wanted != null && !wanted.isBlank()) {
            String target = wanted.trim();
            if (target.matches("[0-9]+")) {
                int index = Integer.parseInt(target) - 1;
                return index >= 0 && index < columns.size() ? index : -1;
            }
            for (int index = 0; index < columns.size(); index += 1)
                if (columns.get(index).trim().equalsIgnoreCase(target)) return index;
            return -1;
        }
        List<String> known = forFile ? FILE_HEADERS : LABEL_HEADERS;
        // 第一轮：精确匹配（中文表头通常就是这么写的）
        for (int index = 0; index < columns.size(); index += 1) {
            if (known.contains(columns.get(index).trim().toLowerCase())) return index;
        }
        // 第二轮：英文关键字包含匹配（如 image_path、label_v2）；中文不做包含，避免「标签路径」被当成文件列
        for (int index = 0; index < columns.size(); index += 1) {
            String key = columns.get(index).trim().toLowerCase();
            if (forFile) {
                if (key.contains("file") || key.contains("name") || key.contains("image") || key.contains("path"))
                    return index;
            } else if (key.contains("label") || key.contains("digit") || key.equals("class") || key.equals("y")) {
                return index;
            }
        }
        return -1;
    }

    /** 最小 CSV 行解析：支持字段用双引号包裹、字段内逗号与转义的 "" 。 */
    static List<String> splitCsvLine(String line) {
        List<String> cells = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean quoted = false;
        for (int index = 0; index < line.length(); index += 1) {
            char ch = line.charAt(index);
            if (ch == '"') {
                if (quoted && index + 1 < line.length() && line.charAt(index + 1) == '"') {
                    current.append('"');
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (ch == ',' && !quoted) {
                cells.add(current.toString());
                current.setLength(0);
            } else if (ch != '\r') {
                current.append(ch);
            }
        }
        cells.add(current.toString());
        return cells;
    }

    private static boolean csvBlocked(Preview preview) {
        return "csv".equals(preview.format()) && preview.csv() != null && !preview.csv().matched();
    }

    private static String csvNote() {
        return "CSV 的表头没匹配上文件列/标签列，请手动选择这两列后重新试运行";
    }

    private List<Path> imagesForLabel(Path dir, String format, int label, Map<String, Integer> csvLabels) {
        Map<String, Integer> skipped = new LinkedHashMap<>();
        return listImages(dir, format).stream()
                .filter(path -> {
                    Integer value = labelOf(dir, path, format, skipped, csvLabels);
                    return value != null && value == label;
                })
                .toList();
    }

    private long insertBatch(long workspaceId, long datasetId, String format, String source, long userId) {
        var keys = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                    INSERT INTO t_import_batch(workspace_id,dataset_id,format,source,created_by)
                    VALUES(?,?,?,?,?)
                    """, java.sql.Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, workspaceId);
            statement.setLong(2, datasetId);
            statement.setString(3, format);
            statement.setString(4, truncate(source));
            statement.setLong(5, userId);
            return statement;
        }, keys);
        Number key = keys.getKey();
        if (key == null) throw new IllegalStateException("import batch id not generated");
        return key.longValue();
    }

    private static String skippedText(Preview preview, int failed) {
        Map<String, Integer> detail = new LinkedHashMap<>(preview.skippedDetail());
        if (failed > 0) detail.merge("读取/校验失败", failed, Integer::sum);
        StringBuilder builder = new StringBuilder();
        detail.forEach((key, value) -> {
            if (value <= 0) return;
            if (builder.length() > 0) builder.append("；");
            builder.append(key).append(' ').append(value);
        });
        return builder.toString();
    }

    private static String truncate(String text) {
        return text != null && text.length() > 1000 ? text.substring(0, 1000) : text;
    }

    private static String sha256(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(bytes);
            StringBuilder builder = new StringBuilder();
            for (byte value : hash) builder.append(String.format("%02x", value));
            return builder.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
