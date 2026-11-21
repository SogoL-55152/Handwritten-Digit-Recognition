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

    public record Preview(String format, int total, Map<String, Integer> labels, int skipped,
                          Map<String, Integer> skippedDetail, List<String> samples, String note,
                          String token, SelfCheck selfCheck) {}

    /** 抽样自检：用当前生效模型看这批图"像不像数字"。 */
    public record SelfCheck(int checked, int accepted, double avgConfidence, String note) {}

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

    public Preview preview(long workspaceId, long userId, String directory) {
        spaces.requireMember(workspaceId, userId);
        return scan(workspaceId, resolve(directory));
    }

    /** 上传 zip：解压到临时目录，返回预览与 token（确认导入时用 token）。 */
    public Preview previewZip(long workspaceId, long userId, MultipartFile file) {
        spaces.requireMember(workspaceId, userId);
        LOG.info("zip 导入预览: name={}, size={}MB", file.getOriginalFilename(),
                Math.round(file.getSize() / 1024.0 / 1024.0));
        Path temp = extractZip(file);
        Preview preview = scan(workspaceId, temp);
        return new Preview(preview.format(), preview.total(), preview.labels(), preview.skipped(),
                preview.skippedDetail(), preview.samples(), preview.note(), temp.toString(), preview.selfCheck());
    }

    public Map<String, Object> commitZip(long workspaceId, long userId, long datasetId, String token) {
        Path temp = Paths.get(token).toAbsolutePath().normalize();
        if (!temp.startsWith(root) || !Files.isDirectory(temp))
            throw new V2Exception(400, "临时目录无效或已过期", "TOKEN_INVALID");
        Map<String, Object> result = commit(workspaceId, userId, datasetId, temp.toString());
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

    @Transactional
    public Map<String, Object> commit(long workspaceId, long userId, long datasetId, String directory) {
        spaces.requireMember(workspaceId, userId);
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
        Preview preview = scan(workspaceId, dir);
        if (preview.total() == 0)
            throw new V2Exception(400, "没有识别到可导入的图片，请检查目录结构", "NO_SAMPLES");

        long batchId = insertBatch(workspaceId, datasetId, preview.format(), dir.toString(), userId);
        if ("idx".equals(preview.format())) {
            int[] counts = importIdx(workspaceId, userId, datasetId, batchId, dir);
            Map<String, Object> idxResult = new LinkedHashMap<>();
            idxResult.put("batchId", Long.toString(batchId));
            idxResult.put("format", "idx");
            idxResult.put("imported", counts[0]);
            idxResult.put("duplicates", 0);
            idxResult.put("failed", counts[1]);
            return idxResult;
        }
        int imported = 0;
        int duplicates = 0;
        int failed = 0;
        for (Map.Entry<String, Integer> row : preview.labels().entrySet()) {
            int label = Integer.parseInt(row.getKey());
            for (Path file : imagesForLabel(dir, preview.format(), label)) {
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
            }
        }
        jdbc.update("UPDATE t_import_batch SET imported=?, skipped=?, skipped_detail=? WHERE id=?",
                imported, preview.skipped() + failed, truncate(skippedText(preview, failed)), batchId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("batchId", Long.toString(batchId));
        result.put("format", preview.format());
        result.put("imported", imported);
        result.put("duplicates", duplicates);
        result.put("failed", failed);
        if (bboxCrops != null) {
            try (Stream<Path> stream = Files.walk(bboxCrops)) {
                stream.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (IOException ignored) { }
                });
            } catch (IOException error) {
                LOG.warn("清理裁剪目录失败 ({})", error.getClass().getSimpleName());
            }
        }
        return result;
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

    private Preview scan(long workspaceId, Path dir) {
        Map<String, Integer> labels = new LinkedHashMap<>();
        Map<String, Integer> skipped = new LinkedHashMap<>();
        List<String> samples = new ArrayList<>();
        String format = detectFormat(dir, skipped);
        if ("bbox".equals(format)) return bboxPreview(dir);
        if ("idx".equals(format)) return idxPreview(dir);
        List<Path> files = listImages(dir, format);
        int total = 0;
        for (Path file : files) {
            if (total >= MAX_FILES) { skipped.merge("超过上限", 1, Integer::sum); break; }
            Integer label = labelOf(dir, file, format, skipped);
            if (label == null) continue;
            labels.merge(String.valueOf(label), 1, Integer::sum);
            total += 1;
            if (samples.size() < 6) samples.add(dir.relativize(file).toString().replace('\\', '/'));
        }
        String note = switch (format) {
            case "folder" -> "识别为「按类别分文件夹」：子目录名必须是 0–9";
            case "csv" -> "识别为「CSV 标签」：按 csv 里的图片名与标签列匹配";
            default -> "识别为「文件名带标签」：取文件名中第一个数字作为标签";
        };
        return new Preview(format, total, labels, skipped.values().stream().mapToInt(Integer::intValue).sum(),
                skipped, samples, note, null,
                total == 0 ? null : selfCheck(workspaceId, files, dir, format, skipped));
    }

    /** 抽最多 8 张，用生效模型预测一次；接受率很低说明这批图可能不是数字。 */
    private SelfCheck selfCheck(long workspaceId, List<Path> files, Path dir, String format,
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
        if (checked == 0) return null;
        double avg = accepted == 0 ? 0 : confidenceSum / accepted;
        String note = accepted == 0
                ? "抽样 " + checked + " 张全部被拒识：这批图可能不是手写数字"
                : "抽样 " + checked + " 张，接受 " + accepted + " 张（平均置信度 " + String.format("%.2f", avg) + "）";
        return new SelfCheck(checked, accepted, Math.round(avg * 1000) / 1000.0, note);
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
        return new Preview("idx", total, labels, 0, new LinkedHashMap<>(), names, note, null, null);
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
        return new Preview("bbox", digits, labels2, multi + small, skipped, List.of(), note, null, null);
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

    private final Map<Path, Map<String, Integer>> csvCache = new java.util.concurrent.ConcurrentHashMap<>();

    private Integer labelOf(Path dir, Path file, String format, Map<String, Integer> skipped) {
        String relative = dir.relativize(file).toString().replace('\\', '/');
        if ("folder".equals(format)) {
            String head = relative.contains("/") ? relative.substring(0, relative.indexOf('/')) : "";
            if (head.matches("[0-9]")) return Integer.parseInt(head);
            skipped.merge("目录名不是 0–9", 1, Integer::sum);
            return null;
        }
        if ("csv".equals(format)) {
            Map<String, Integer> map = csvCache.computeIfAbsent(dir, this::readCsv);
            Integer label = map.get(file.getFileName().toString());
            if (label == null) skipped.merge("csv 里没有这个文件", 1, Integer::sum);
            return label;
        }
        Matcher matcher = Pattern.compile("(?:^|[^0-9])([0-9])(?:[^0-9]|$)").matcher(file.getFileName().toString());
        if (matcher.find()) return Integer.parseInt(matcher.group(1));
        skipped.merge("文件名里没有数字", 1, Integer::sum);
        return null;
    }

    private Map<String, Integer> readCsv(Path dir) {
        Map<String, Integer> map = new LinkedHashMap<>();
        try (Stream<Path> stream = Files.list(dir)) {
            Path csv = stream.filter(path -> path.getFileName().toString().toLowerCase().endsWith(".csv"))
                    .findFirst().orElse(null);
            if (csv == null) return map;
            List<String> lines = Files.readAllLines(csv, StandardCharsets.UTF_8);
            if (lines.isEmpty()) return map;
            String[] header = lines.get(0).split(",");
            int nameColumn = -1;
            int labelColumn = -1;
            for (int index = 0; index < header.length; index += 1) {
                String key = header[index].trim().toLowerCase();
                if (nameColumn < 0 && (key.contains("file") || key.contains("name") || key.contains("image"))) nameColumn = index;
                if (labelColumn < 0 && (key.contains("label") || key.contains("digit") || key.equals("class") || key.equals("y")))
                    labelColumn = index;
            }
            if (nameColumn < 0 || labelColumn < 0) return map;
            for (int index = 1; index < lines.size(); index += 1) {
                String[] cells = lines.get(index).split(",");
                if (cells.length <= Math.max(nameColumn, labelColumn)) continue;
                String name = cells[nameColumn].trim();
                String label = cells[labelColumn].trim();
                if (label.matches("[0-9]")) map.put(name, Integer.parseInt(label));
            }
        } catch (IOException error) {
            LOG.warn("CSV 读取失败 ({})", error.getClass().getSimpleName());
        }
        return map;
    }

    private List<Path> imagesForLabel(Path dir, String format, int label) {
        Map<String, Integer> skipped = new LinkedHashMap<>();
        return listImages(dir, format).stream()
                .filter(path -> {
                    Integer value = labelOf(dir, path, format, skipped);
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
