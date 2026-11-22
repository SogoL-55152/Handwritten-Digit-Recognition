package com.hdr.v2.collection;

import com.hdr.v2.V2Exception;
import com.hdr.v2.recognition.ImageValidator;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;

/**
 * 用户自报标签的样本采集。只在用户明确同意时保存原图；
 * 同一工作空间+用户+图片摘要只保留一条，重复提交不写第二份文件。
 */
@Service
public class CollectedSampleService {
    private static final Logger LOG = LoggerFactory.getLogger(CollectedSampleService.class);
    private static final DateTimeFormatter MONTH = DateTimeFormatter.ofPattern("yyyyMM");

    public record Saved(long id, boolean duplicate, long contributedTotal) {}

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final Path root;

    public CollectedSampleService(JdbcTemplate jdbc, WorkspaceService spaces,
                                  @Value("${hdr.collected.dir:collected-samples}") String directory) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.root = Paths.get(directory).toAbsolutePath().normalize();
    }

    /**
     * 自动清理孤儿文件：服务启动 1 分钟后跑一次，之后按 hdr.collected.sweep-ms（默认 6 小时）重复。
     * 只处理 30 分钟前的文件，避免删掉「刚写完、记录尚未提交」的图片。
     */
    @org.springframework.scheduling.annotation.Scheduled(
            initialDelayString = "${hdr.collected.sweep.initial-delay-ms:60000}",
            fixedDelayString = "${hdr.collected.sweep.interval-ms:21600000}")
    public void sweepOrphans() {
        int deleted = 0;
        long freed = 0;
        long cutoff = System.currentTimeMillis() - java.time.Duration.ofMinutes(30).toMillis();
        try (java.util.stream.Stream<Path> stream = Files.walk(root)) {
            for (Path file : stream.filter(Files::isRegularFile).toList()) {
                try {
                    if (Files.getLastModifiedTime(file).toMillis() > cutoff) continue;
                } catch (IOException ignored) {
                    continue;
                }
                String relative = root.relativize(file).toString().replace('\\', '/');
                Long refs = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM t_collected_sample WHERE artifact_path=?", Long.class, relative);
                if (refs != null && refs > 0) continue;
                try {
                    freed += Files.size(file);
                    Files.deleteIfExists(file);
                    deleted += 1;
                } catch (IOException error) {
                    LOG.warn("自动清理孤儿文件失败 ({})", error.getClass().getSimpleName());
                }
            }
        } catch (IOException error) {
            LOG.warn("自动清理扫描失败 ({})", error.getClass().getSimpleName());
            return;
        }
        if (deleted > 0) LOG.info("自动清理孤儿文件: {} 个, 释放 {} 字节", deleted, freed);
    }

    /** 扫描整个采集目录，删除没有被任何记录引用的文件；返回删除数量。 */
    public Map<String, Object> cleanupOrphans(long workspaceId, long userId) {
        spaces.requireMember(workspaceId, userId);
        int deleted = 0;
        long freed = 0;
        try (java.util.stream.Stream<Path> stream = Files.walk(root)) {
            for (Path file : stream.filter(Files::isRegularFile).toList()) {
                String relative = root.relativize(file).toString().replace('\\', '/');
                Long refs = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM t_collected_sample WHERE artifact_path=?", Long.class, relative);
                if (refs != null && refs > 0) continue;
                try {
                    freed += Files.size(file);
                    Files.deleteIfExists(file);
                    deleted += 1;
                } catch (IOException error) {
                    LOG.warn("删除孤儿文件失败 ({})", error.getClass().getSimpleName());
                }
            }
        } catch (IOException error) {
            throw new V2Exception(503, "采集目录不可读", "STORAGE_UNAVAILABLE");
        }
        return Map.of("deleted", deleted, "freedBytes", freed);
    }

    /** 只删除没有被任何样本记录引用的文件（路径必须落在采集根目录内）。 */
    public void deleteArtifactIfOrphan(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) return;
        Path target = root.resolve(relativePath).normalize();
        if (!target.startsWith(root)) return;
        try {
            Long refs = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM t_collected_sample WHERE artifact_path=?", Long.class, relativePath);
            if (refs != null && refs > 0) return;
            Files.deleteIfExists(target);
        } catch (IOException error) {
            LOG.warn("删除孤儿图片失败 ({})", error.getClass().getSimpleName());
        }
    }

    /** 读取采集样本原图（artifact_path 是相对根目录的路径，校验不逃逸）。 */
    /** 返回 artifact 的绝对路径（导出训练数据时可直接硬链接，避免逐张读写）。 */
    public Path artifactPath(String relativePath) {
        if (relativePath == null || relativePath.isBlank())
            throw new V2Exception(404, "样本没有保存图片", "IMAGE_NOT_FOUND");
        Path target = root.resolve(relativePath).normalize();
        if (!target.startsWith(root) || !Files.isRegularFile(target))
            throw new V2Exception(404, "样本没有保存图片", "IMAGE_NOT_FOUND");
        return target;
    }

    public byte[] readArtifact(String relativePath) {
        if (relativePath == null || relativePath.isBlank())
            throw new V2Exception(404, "样本没有保存图片", "IMAGE_NOT_FOUND");
        Path target = root.resolve(relativePath).normalize();
        if (!target.startsWith(root) || !Files.isRegularFile(target))
            throw new V2Exception(404, "样本没有保存图片", "IMAGE_NOT_FOUND");
        try {
            return Files.readAllBytes(target);
        } catch (IOException error) {
            throw new V2Exception(503, "样本图片读取失败", "STORAGE_UNAVAILABLE");
        }
    }

    public Saved save(long workspaceId, long userId, Integer label, String labelText, boolean consent,
                      ImageValidator.Image image, Integer predictedDigit, String predictedText, Double confidence,
                      String modelVersion, Long recognitionId, String source) {
        return save(workspaceId, userId, label, labelText, consent, image, predictedDigit, predictedText,
                confidence, modelVersion, recognitionId, source, null);
    }

    /** 导入到某个数据集时传 datasetId：去重只看同一数据集内是否已有这张图。 */
    public Saved save(long workspaceId, long userId, Integer label, String labelText, boolean consent,
                      ImageValidator.Image image, Integer predictedDigit, String predictedText, Double confidence,
                      String modelVersion, Long recognitionId, String source, Long datasetId) {
        spaces.requireMember(workspaceId, userId);
        if (!consent) throw new V2Exception(400, "未同意采集时不会保存图片", "CONSENT_REQUIRED");
        boolean multi = labelText != null && !labelText.isBlank();
        if (multi) {
            if (!labelText.matches("[0-9]{1,4}")) throw new V2Exception(400, "多位标签必须是 1–4 位数字", "VALIDATION");
            if (label != null) throw new V2Exception(400, "单字标签与多位标签只能二选一", "VALIDATION");
        } else if (label == null || label < 0 || label > 9) {
            throw new V2Exception(400, "标签必须是 0–9，或提供 1–4 位数字串", "VALIDATION");
        }
        String digest = image.digest();
        List<Long> existing = jdbc.queryForList("""
                SELECT id FROM t_collected_sample WHERE workspace_id=? AND creator_id=? AND image_digest=?
                  AND source_dataset_id <=> ?
                """, Long.class, workspaceId, userId, digest, datasetId);
        if (!existing.isEmpty()) return new Saved(existing.get(0), true, contributedTotal(userId));

        String extension = "image/png".equals(image.contentType()) ? "png" : "jpg";
        Path target = resolveTarget(workspaceId, digest, extension);
        try {
            Files.createDirectories(target.getParent());
            Files.write(target, image.bytes());
        } catch (IOException error) {
            LOG.warn("Collected sample write failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "样本保存失败，请稍后重试", "STORAGE_UNAVAILABLE");
        }
        var keyHolder = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                    INSERT INTO t_collected_sample(workspace_id,creator_id,recognition_id,label,predicted_digit,
                        confidence,model_version,source,source_dataset_id,image_digest,artifact_path,size_bytes,
                        content_type,consent,sample_kind,label_text,predicted_text,digit_count)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
                    """, java.sql.Statement.RETURN_GENERATED_KEYS);
            statement.setLong(1, workspaceId);
            statement.setLong(2, userId);
            if (recognitionId == null) statement.setNull(3, java.sql.Types.BIGINT); else statement.setLong(3, recognitionId);
            if (label == null) statement.setNull(4, java.sql.Types.TINYINT); else statement.setInt(4, label);
            if (predictedDigit == null) statement.setNull(5, java.sql.Types.TINYINT);
            else statement.setInt(5, predictedDigit);
            if (confidence == null) statement.setNull(6, java.sql.Types.DOUBLE); else statement.setDouble(6, confidence);
            statement.setString(7, modelVersion);
            statement.setString(8, source == null || source.isBlank() ? "WEB" : source);
            if (datasetId == null) statement.setNull(9, java.sql.Types.BIGINT);
            else statement.setLong(9, datasetId);
            statement.setString(10, digest);
            statement.setString(11, root.relativize(target).toString().replace('\\', '/'));
            statement.setInt(12, image.bytes().length);
            statement.setString(13, image.contentType());
            statement.setString(14, multi ? "MULTI" : "SINGLE");
            if (multi) statement.setString(15, labelText); else statement.setNull(15, java.sql.Types.VARCHAR);
            if (predictedText == null || predictedText.isBlank()) statement.setNull(16, java.sql.Types.VARCHAR);
            else statement.setString(16, predictedText);
            if (multi) statement.setInt(17, labelText.length()); else statement.setNull(17, java.sql.Types.TINYINT);
            return statement;
        }, keyHolder);
        Number generated = keyHolder.getKey();
        if (generated == null) throw new IllegalStateException("Collected sample id not generated");
        return new Saved(generated.longValue(), false, contributedTotal(userId));
    }

    /** 只给本人看贡献数，不暴露其他用户的采集内容。 */
    public long contributedTotal(long userId) {
        Long value = jdbc.queryForObject("SELECT COUNT(*) FROM t_collected_sample WHERE creator_id=?", Long.class, userId);
        return value == null ? 0 : value;
    }

    public Map<String, Object> summary(long userId) {
        Map<String, Object> counts = jdbc.queryForMap("""
                SELECT COUNT(*) AS total, COUNT(DISTINCT label) AS labels FROM t_collected_sample WHERE creator_id=?
                """, userId);
        return Map.of("total", count(counts.get("total")), "labels", count(counts.get("labels")));
    }

    Path resolveTarget(long workspaceId, String digest, String extension) {
        Path target = root.resolve(Long.toString(workspaceId))
                .resolve(LocalDate.now().format(MONTH))
                .resolve(digest + "." + extension).normalize();
        if (!target.startsWith(root)) throw new V2Exception(400, "样本路径无效", "VALIDATION");
        return target;
    }

    private long count(Object value) {
        return value instanceof Number number ? number.longValue() : 0L;
    }
}
