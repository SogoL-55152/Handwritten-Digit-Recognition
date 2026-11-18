package com.hdr.v2.training;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import com.hdr.v2.collection.CollectedSampleService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把数据集版本的训练样本导出成"文件名带标签的 PNG 目录"，交给模型服务读取。
 * 只导出 TRAIN 划分；目录按版本号固定，重复导出覆盖同名文件。
 */
@Component
public class TrainingDataExporter {
    private static final Logger LOG = LoggerFactory.getLogger(TrainingDataExporter.class);

    private final JdbcTemplate jdbc;
    private final CollectedSampleService collected;
    private final ObjectMapper mapper;
    private final Path root;

    public TrainingDataExporter(JdbcTemplate jdbc, CollectedSampleService collected, ObjectMapper mapper,
                               @Value("${hdr.training.data-dir:training-data}") String directory) {
        this.jdbc = jdbc;
        this.collected = collected;
        this.mapper = mapper;
        this.root = Paths.get(directory).toAbsolutePath().normalize();
    }

    public record Exported(String directory, int count, Map<String, Integer> labels, int writers) {}

    public Exported export(long versionId) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT s.sample_id, s.label, s.writer_key, c.artifact_path
                FROM t_v2_dataset_sample s
                JOIN t_collected_sample c ON c.id = s.sample_id
                WHERE s.version_id=? AND s.split='TRAIN'
                ORDER BY s.id
                """, versionId);
        if (rows.isEmpty())
            throw new V2Exception(400, "该版本没有训练集样本，无法用于训练", "NO_TRAIN_SAMPLES");
        Path target = root.resolve("v" + versionId);
        try {
            Files.createDirectories(target);
            Map<String, Integer> labels = new LinkedHashMap<>();
            int written = 0;
            java.util.Set<String> writers = new java.util.HashSet<>();
            for (Map<String, Object> row : rows) {
                String label = String.valueOf(row.get("label"));
                if (!label.matches("[0-9]{1,4}")) continue;
                byte[] bytes;
                try {
                    bytes = collected.readArtifact(String.valueOf(row.get("artifact_path")));
                } catch (V2Exception missing) {
                    LOG.warn("Skip unreadable sample {} for version {}", row.get("sample_id"), versionId);
                    continue;
                }
                String name = label + "_" + row.get("sample_id") + ".png";
                Files.write(target.resolve(name), bytes);
                labels.merge(label, 1, Integer::sum);
                writers.add(String.valueOf(row.get("writer_key")));
                written += 1;
            }
            if (written == 0) throw new V2Exception(400, "该版本的训练样本没有可读图片", "NO_TRAIN_SAMPLES");
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("versionId", versionId);
            manifest.put("count", written);
            manifest.put("labels", labels);
            manifest.put("writers", writers.size());
            Files.writeString(target.resolve("manifest.json"),
                    mapper.writeValueAsString(manifest) + "\n");
            return new Exported(target.toString(), written, labels, writers.size());
        } catch (IOException error) {
            LOG.warn("Training data export failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "训练数据导出失败，请稍后重试", "STORAGE_UNAVAILABLE");
        }
    }
}
