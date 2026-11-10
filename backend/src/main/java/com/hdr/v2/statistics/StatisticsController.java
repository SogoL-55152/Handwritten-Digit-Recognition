package com.hdr.v2.statistics;

import com.hdr.common.Result;
import com.hdr.v2.V2Exception;
import com.hdr.v2.auth.V2Principal;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

/** 统计接口：空间成员看自己空间，平台运营看全局。 */
@RestController
public class StatisticsController {
    private final StatisticsService statistics;

    public StatisticsController(StatisticsService statistics) {
        this.statistics = statistics;
    }

    @GetMapping("/api/v2/workspaces/{workspaceId}/statistics")
    public Result<StatisticsService.SpaceStatistics> space(@PathVariable long workspaceId,
                                                           @RequestParam(defaultValue = "7") int days,
                                                           HttpServletRequest request) {
        return Result.ok(statistics.forSpace(workspaceId, V2Principal.require(request).userId(), days));
    }

    @GetMapping("/api/v2/platform/statistics")
    public Result<StatisticsService.PlatformStatistics> platform(@RequestParam(defaultValue = "30") int days,
                                                                 HttpServletRequest request) {
        V2Principal principal = V2Principal.require(request);
        if (!"SUPER_ADMIN".equals(principal.platformRole()))
            throw new V2Exception(403, "无平台运营权限", "FORBIDDEN");
        return Result.ok(statistics.platform(days));
    }
}
