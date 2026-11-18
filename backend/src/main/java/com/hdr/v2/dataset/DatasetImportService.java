package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.collection.CollectedSampleService;
import com.hdr.v2.recognition.ImageValidator;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 把外部图片导入成工作空间的采集样本（之后才能建版本）。 */
@Service
public class DatasetImportService {
    private static final Logger LOG = LoggerFactory.getLogger(DatasetImportService.class);
    private static final int MAX_FILES = 200;

    public record Result(int imported, int duplicates, int failed, int total) {}

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final CollectedSampleService collected;
    private final ImageValidator images;

    public DatasetImportService(JdbcTemplate jdbc, WorkspaceService spaces, CollectedSampleService collected,
                               ImageValidator images) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.collected = collected;
        this.images = images;
    }

    @Transactional
    public Result importFiles(long workspaceId, long userId, long datasetId, Integer label, List<MultipartFile> files) {
        spaces.requireMember(workspaceId, userId);
        Long exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_dataset WHERE id=? AND workspace_id=? AND status='ACTIVE'",
                Long.class, datasetId, workspaceId);
        if (exists == null || exists == 0) throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
        if (label == null || label < 0 || label > 9)
            throw new V2Exception(400, "导入时必须指定 0–9 的单字标签", "VALIDATION");
        if (files == null || files.isEmpty()) throw new V2Exception(400, "没有选择文件", "VALIDATION");
        if (files.size() > MAX_FILES)
            throw new V2Exception(400, "单次最多导入 " + MAX_FILES + " 张", "TOO_MANY_FILES");

        int imported = 0;
        int duplicates = 0;
        int failed = 0;
        List<Long> savedIds = new ArrayList<>();
        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) { failed += 1; continue; }
            try {
                ImageValidator.Image image = images.validate(file);
                CollectedSampleService.Saved saved = collected.save(workspaceId, userId, label, null, true, image,
                        null, null, null, null, null, "IMPORT");
                if (saved.duplicate()) {
                    duplicates += 1;
                } else {
                    imported += 1;
                    savedIds.add(saved.id());
                }
            } catch (V2Exception error) {
                LOG.info("Import rejected a file ({})", error.getCategory());
                failed += 1;
            } catch (RuntimeException error) {
                LOG.warn("Import failed for a file ({})", error.getClass().getSimpleName());
                failed += 1;
            }
        }
        if (!savedIds.isEmpty()) {
            String placeholders = String.join(",", java.util.Collections.nCopies(savedIds.size(), "?"));
            Object[] args = new Object[savedIds.size() + 2];
            args[0] = datasetId;
            for (int index = 0; index < savedIds.size(); index += 1) args[index + 1] = savedIds.get(index);
            args[args.length - 1] = datasetId;
            List<Object> ordered = new ArrayList<>();
            ordered.add(datasetId);
            ordered.addAll(savedIds);
            jdbc.update("UPDATE t_collected_sample SET sample_kind='IMPORTED', source_dataset_id=?, imported_at=UTC_TIMESTAMP() WHERE id IN ("
                    + placeholders + ")", ordered.toArray());
        }
        return new Result(imported, duplicates, failed, files.size());
    }
}
