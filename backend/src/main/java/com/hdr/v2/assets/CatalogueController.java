package com.hdr.v2.assets;

import com.hdr.common.Result;
import com.hdr.v2.auth.V2Principal;
import com.hdr.v2.workspace.WorkspaceService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/v2/workspaces/{workspaceId}")
public class CatalogueController {
    private final WorkspaceService spaces;
    private final CatalogueService catalogue;
    public CatalogueController(WorkspaceService spaces,CatalogueService catalogue) { this.spaces=spaces; this.catalogue=catalogue; }
    private void authorize(long wid,HttpServletRequest request) { spaces.requireMember(wid,V2Principal.require(request).userId()); }
    @GetMapping("/models")
    public Result<List<CatalogueService.Model>> models(@PathVariable long workspaceId,HttpServletRequest request) {
        authorize(workspaceId,request); return Result.ok(catalogue.models(workspaceId));
    }
    @GetMapping("/models/{id}")
    public Result<CatalogueService.Model> model(@PathVariable long workspaceId,@PathVariable long id,HttpServletRequest request) {
        authorize(workspaceId,request); return Result.ok(catalogue.model(workspaceId,id));
    }
    @GetMapping("/default-model")
    public Result<CatalogueService.Model> defaultModel(@PathVariable long workspaceId,HttpServletRequest request) {
        authorize(workspaceId,request); return Result.ok(catalogue.defaultModel(workspaceId));
    }
    @GetMapping("/datasets")
    public Result<List<CatalogueService.Dataset>> datasets(@PathVariable long workspaceId,HttpServletRequest request) {
        authorize(workspaceId,request); return Result.ok(catalogue.datasets(workspaceId));
    }
    @GetMapping("/datasets/{id}")
    public Result<CatalogueService.Dataset> dataset(@PathVariable long workspaceId,@PathVariable long id,HttpServletRequest request) {
        authorize(workspaceId,request); return Result.ok(catalogue.dataset(workspaceId,id));
    }
}
