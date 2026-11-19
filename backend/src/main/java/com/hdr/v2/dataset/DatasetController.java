package com.hdr.v2.dataset;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.util.ArrayList;

import java.util.List;
import java.util.Map;

/** 数据集版本：构建、查看统计、分页浏览样本与缩略图。 */
@RestController
@RequestMapping("/api/v2/workspaces/{workspaceId}")
public class DatasetController {
    private final DatasetService datasets;
    private final DatasetImportService imports;
    private final ImportWizardService wizard;
    private final WorkspaceService spaces;

    public DatasetController(DatasetService datasets, DatasetImportService imports,                              ImportWizardService wizard, WorkspaceService spaces) {
        this.datasets = datasets;
        this.imports = imports;
        this.wizard = wizard;
        this.spaces = spaces;
    }

    public record CreateCommand(String name, String description) {}

    private long authorize(long workspaceId, HttpServletRequest request) {
        long user = V2Principal.require(request).userId();
        spaces.requireMember(workspaceId, user);
        return user;
    }

    @PostMapping("/datasets")
    public Result<Map<String, Object>> createDataset(@PathVariable long workspaceId,
                                                     @RequestBody(required = false) CreateCommand command,
                                                     HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null || command.name() == null || command.name().isBlank())
            throw new V2Exception(400, "缺少数据集名称", "VALIDATION");
        return Result.ok(datasets.createDataset(workspaceId, user, command.name(), command.description()));
    }

    @PostMapping("/datasets/{datasetId}/versions")
    public Result<DatasetService.Version> build(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                @RequestBody(required = false) DatasetService.BuildCommand command,
                                                HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null) throw new V2Exception(400, "缺少版本参数", "VALIDATION");
        return Result.ok(datasets.createVersion(workspaceId, user, datasetId, command));
    }

    @PostMapping(value = "/datasets/{datasetId}/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<DatasetImportService.Result> importSamples(@PathVariable long workspaceId,
                                                             @PathVariable long datasetId,
                                                             @RequestParam("label") Integer label,
                                                             @RequestParam(value = "files", required = false) List<MultipartFile> files,
                                                             HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(imports.importFiles(workspaceId, user, datasetId, label, files == null ? List.of() : files));
    }

    public record WizardCommand(String directory) {}

    @PostMapping("/datasets/import-wizard/preview")
    public Result<ImportWizardService.Preview> wizardPreview(@PathVariable long workspaceId,
                                                             @RequestBody(required = false) WizardCommand command,
                                                             HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null) throw new V2Exception(400, "缺少目录路径", "VALIDATION");
        return Result.ok(wizard.preview(workspaceId, user, command.directory()));
    }

    public record WizardToken(String token) {}

    @PostMapping(value = "/datasets/import-wizard/zip-preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ImportWizardService.Preview> zipPreview(@PathVariable long workspaceId,
                                                          @RequestParam("file") MultipartFile file,
                                                          HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(wizard.previewZip(workspaceId, user, file));
    }

    @PostMapping("/datasets/{datasetId}/import-wizard/zip")
    public Result<Map<String, Object>> zipCommit(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                 @RequestBody(required = false) WizardToken command,
                                                 HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null || command.token() == null)
            throw new V2Exception(400, "缺少临时目录 token", "VALIDATION");
        return Result.ok(wizard.commitZip(workspaceId, user, datasetId, command.token()));
    }

    @PostMapping("/datasets/{datasetId}/import-wizard")
    public Result<Map<String, Object>> wizardCommit(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                    @RequestBody(required = false) WizardCommand command,
                                                    HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null) throw new V2Exception(400, "缺少目录路径", "VALIDATION");
        return Result.ok(wizard.commit(workspaceId, user, datasetId, command.directory()));
    }

    @GetMapping("/import-batches")
    public Result<List<Map<String, Object>>> importBatches(@PathVariable long workspaceId,
                                                           HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(wizard.batches(workspaceId, user));
    }

    @DeleteMapping("/import-batches/{batchId}")
    public Result<Map<String, Object>> rollbackBatch(@PathVariable long workspaceId, @PathVariable long batchId,
                                                     HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(wizard.rollback(workspaceId, user, batchId));
    }

    @GetMapping("/dataset-versions")
    public Result<List<Map<String, Object>>> allVersions(@PathVariable long workspaceId,
                                                         @RequestParam(value = "limit", defaultValue = "50") int limit,
                                                         HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(datasets.allVersions(workspaceId, user, Math.min(200, Math.max(1, limit))));
    }

    @PostMapping("/datasets/{datasetId}/claim-samples")
    public Result<Map<String, Object>> claimSamples(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                    HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(Map.of("claimed", datasets.claimRecognition(workspaceId, user, datasetId)));
    }

    @DeleteMapping("/datasets/{datasetId}")
    public Result<Map<String, Object>> deleteDataset(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                     HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        datasets.deleteDataset(workspaceId, user, datasetId);
        return Result.ok(Map.of("deleted", Long.toString(datasetId)));
    }

    @GetMapping("/datasets/{datasetId}/versions")
    public Result<List<DatasetService.Version>> versions(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                         HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(datasets.versions(workspaceId, user, datasetId));
    }

    @GetMapping("/dataset-versions/{versionId}")
    public Result<DatasetService.Version> version(@PathVariable long workspaceId, @PathVariable long versionId,
                                                  HttpServletRequest request) {
        authorize(workspaceId, request);
        return Result.ok(datasets.version(workspaceId, versionId));
    }

    @GetMapping("/dataset-versions/{versionId}/stats")
    public Result<Map<String, Object>> stats(@PathVariable long workspaceId, @PathVariable long versionId,
                                             HttpServletRequest request) {
        authorize(workspaceId, request);
        return Result.ok(datasets.stats(workspaceId, versionId));
    }

    @DeleteMapping("/datasets/{datasetId}/versions/{versionId}")
    public Result<Map<String, Object>> deleteVersion(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                     @PathVariable long versionId, HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        datasets.deleteVersion(workspaceId, user, datasetId, versionId);
        return Result.ok(Map.of("deleted", Long.toString(versionId)));
    }

    @DeleteMapping("/datasets/{datasetId}/versions/{versionId}/samples/{sampleId}")
    public Result<Map<String, Object>> removeSample(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                    @PathVariable long versionId, @PathVariable long sampleId,
                                                    HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        datasets.removeSample(workspaceId, user, datasetId, versionId, sampleId);
        return Result.ok(Map.of("deleted", Long.toString(sampleId)));
    }

    @GetMapping("/dataset-versions/{versionId}/samples")
    public Result<Map<String, Object>> samples(@PathVariable long workspaceId, @PathVariable long versionId,
                                               @RequestParam(defaultValue = "1") int page,
                                               @RequestParam(defaultValue = "24") int size,
                                               @RequestParam(required = false) String split,
                                               @RequestParam(required = false) Integer label,
                                               HttpServletRequest request) {
        authorize(workspaceId, request);
        List<DatasetService.Sample> items = datasets.samples(workspaceId, versionId, page, size, split, label);
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("items", items);
        body.put("page", Math.max(1, page));
        body.put("size", Math.min(60, Math.max(1, size)));
        body.put("total", datasets.count(versionId));
        return Result.ok(body);
    }

    @GetMapping("/dataset-versions/{versionId}/samples/{sampleId}/image")
    public org.springframework.http.ResponseEntity<byte[]> image(@PathVariable long workspaceId,
                                                                 @PathVariable long versionId,
                                                                 @PathVariable long sampleId,
                                                                 HttpServletRequest request) {
        authorize(workspaceId, request);
        return org.springframework.http.ResponseEntity.ok()
                .header("Cache-Control", "private, max-age=300")
                .contentType(MediaType.IMAGE_PNG)
                .body(datasets.image(workspaceId, versionId, sampleId));
    }
}
