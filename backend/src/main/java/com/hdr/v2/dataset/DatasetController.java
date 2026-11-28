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
    private final ImportJobService jobs;
    private final SampleInspectionService inspection;
    private final com.hdr.v2.collection.CollectedSampleService collected;
    private final WorkspaceService spaces;

    public DatasetController(DatasetService datasets, DatasetImportService imports,
                             ImportWizardService wizard, ImportJobService jobs,
                             SampleInspectionService inspection,
                             com.hdr.v2.collection.CollectedSampleService collected,
                             WorkspaceService spaces) {
        this.datasets = datasets;
        this.imports = imports;
        this.wizard = wizard;
        this.jobs = jobs;
        this.inspection = inspection;
        this.collected = collected;
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

    /**
     * 服务器目录导入。fileColumn/labelColumn 只对 CSV 生效：留空表示自动按表头关键字猜，
     * 猜不中时预览会返回 csv.matched=false，前端把这两项变成可手动选择后重新试运行。
     */
    public record WizardCommand(String directory, String fileColumn, String labelColumn) {
        ImportWizardService.CsvMapping mapping() {
            return new ImportWizardService.CsvMapping(fileColumn, labelColumn);
        }
    }

    @PostMapping(value = "/datasets/import-wizard/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> wizardUpload(@PathVariable long workspaceId,
                                                    @RequestParam("file") java.util.List<org.springframework.web.multipart.MultipartFile> files,
                                                    @RequestParam(value = "path", required = false) java.util.List<String> paths,
                                                    HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(wizard.uploadPreview(workspaceId, user, files, paths));
    }

    public record UploadCommit(String token) {}

    @PostMapping("/datasets/{datasetId}/import-wizard/upload-commit")
    public Result<Map<String, Object>> wizardUploadCommit(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                          @RequestBody UploadCommit command,
                                                          HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null || command.token() == null)
            throw new V2Exception(400, "缺少上传标识", "VALIDATION");
        return Result.ok(wizard.commitUpload(workspaceId, user, datasetId, command.token()));
    }

    @PostMapping("/datasets/import-wizard/preview")
    public Result<ImportWizardService.Preview> wizardPreview(@PathVariable long workspaceId,
                                                             @RequestBody(required = false) WizardCommand command,
                                                             HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null) throw new V2Exception(400, "缺少目录路径", "VALIDATION");
        return Result.ok(wizard.preview(workspaceId, user, command.directory(), command.mapping()));
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
        return Result.ok(wizard.commit(workspaceId, user, datasetId, command.directory(), command.mapping()));
    }

    // ---------- 异步导入任务（大目录/大 zip 不再占着请求线程） ----------

    /**
     * sourceKind：DIRECTORY（服务器目录，用 directory）/ ZIP（已解压的 zip 临时目录，用 token）
     * / UPLOAD（浏览器上传的临时目录，用 token）。ZIP 与 UPLOAD 的目录在任务结束后自动清理。
     */
    public record ImportJobCommand(String directory, String token, String sourceKind,
                                   String fileColumn, String labelColumn) {}

    @PostMapping("/datasets/{datasetId}/import-jobs")
    public Result<ImportJobService.JobView> createImportJob(@PathVariable long workspaceId,
                                                           @PathVariable long datasetId,
                                                           @RequestBody(required = false) ImportJobCommand command,
                                                           HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        if (command == null) throw new V2Exception(400, "缺少导入参数", "VALIDATION");
        ImportWizardService.CsvMapping mapping =
                new ImportWizardService.CsvMapping(command.fileColumn(), command.labelColumn());
        return Result.ok(jobs.create(workspaceId, user, datasetId, command.sourceKind(),
                command.directory(), command.token(), mapping));
    }

    @GetMapping("/import-jobs/{jobId}")
    public Result<ImportJobService.JobView> importJob(@PathVariable long workspaceId, @PathVariable long jobId,
                                                     HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(jobs.get(workspaceId, user, jobId));
    }

    @PostMapping("/import-jobs/{jobId}/cancel")
    public Result<ImportJobService.JobView> cancelImportJob(@PathVariable long workspaceId,
                                                            @PathVariable long jobId,
                                                            HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(jobs.cancel(workspaceId, user, jobId));
    }

    @GetMapping("/import-jobs")
    public Result<List<ImportJobService.JobView>> listImportJobs(@PathVariable long workspaceId,
                                                                 @RequestParam(defaultValue = "10") int limit,
                                                                 HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(jobs.recent(workspaceId, user, limit));
    }

    /** 清理采集目录里没有被任何样本记录引用的文件（维护用）。 */    @PostMapping("/collected/cleanup-orphans")
    public Result<Map<String, Object>> cleanupOrphans(@PathVariable long workspaceId, HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(collected.cleanupOrphans(workspaceId, user));
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
        if (!"SUPER_ADMIN".equals(com.hdr.v2.auth.V2Principal.require(request).platformRole()))
            throw new V2Exception(403, "只有平台管理员可以使用归入识别采集", "FORBIDDEN");
        return Result.ok(Map.of("claimed", datasets.claimRecognition(workspaceId, user, datasetId)));
    }

    @DeleteMapping("/datasets/{datasetId}")
    public Result<Map<String, Object>> deleteDataset(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                     HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        datasets.deleteDataset(workspaceId, user, datasetId);
        return Result.ok(Map.of("deleted", Long.toString(datasetId)));
    }

    public record InspectCommand(Integer limit) {}

    /** 巡检：对未巡检样本跑一次多位数检测（标记不删除），可重复调用直到 remaining=0。 */
    @PostMapping("/datasets/{datasetId}/inspect")
    public Result<Map<String, Object>> inspect(@PathVariable long workspaceId, @PathVariable long datasetId,
                                               @RequestBody(required = false) InspectCommand command,
                                               HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        int limit = command == null || command.limit() == null ? 50 : command.limit();
        return Result.ok(inspection.inspect(workspaceId, user, datasetId, limit));
    }

    /** 删除被拒绝时用：哪些训练任务引用了该数据集。 */
    @GetMapping("/datasets/{datasetId}/references")
    public Result<List<Map<String, Object>>> references(@PathVariable long workspaceId, @PathVariable long datasetId,
                                                         HttpServletRequest request) {
        long user = authorize(workspaceId, request);
        return Result.ok(datasets.references(workspaceId, user, datasetId));
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
