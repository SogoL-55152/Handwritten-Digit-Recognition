package com.hdr.v2.workspace;

import com.hdr.common.Result;
import com.hdr.v2.auth.V2Principal;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v2/workspaces")
public class WorkspaceController {
    private final WorkspaceService workspaces;

    public WorkspaceController(WorkspaceService workspaces) {
        this.workspaces = workspaces;
    }

    @GetMapping
    public Result<List<WorkspaceService.Workspace>> list(HttpServletRequest request) {
        return Result.ok(workspaces.list(V2Principal.require(request).userId()));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Result<WorkspaceService.Workspace> create(@Valid @RequestBody CreateWorkspace body, HttpServletRequest request) {
        return Result.ok(workspaces.create(V2Principal.require(request).userId(), body.name()));
    }

    @GetMapping("/{workspaceId}")
    public Result<WorkspaceService.Workspace> get(@PathVariable long workspaceId, HttpServletRequest request) {
        return Result.ok(workspaces.requireMember(workspaceId, V2Principal.require(request).userId()));
    }

    public record CreateWorkspace(@NotBlank @Size(max = 64) String name) {}
}
