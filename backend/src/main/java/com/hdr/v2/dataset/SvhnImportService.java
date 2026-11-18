package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import com.hdr.v2.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 按钮触发的 SVHN 导入：后端拉起 model-service 里的导入脚本（本地一体化）。
 *
 * 只允许读取配置根目录（hdr.import.root）下的路径，避免任意文件读取。
 * 生产环境应该换成队列任务；这里是本地演示的简化：同步执行、返回汇总。
 */
@Service
public class SvhnImportService {
    private static final Logger LOG = LoggerFactory.getLogger(SvhnImportService.class);
    private static final int MAX_PER_LABEL = 20000;

    private final JdbcTemplate jdbc;
    private final WorkspaceService spaces;
    private final Path python;
    private final Path script;
    private final Path root;
    private final int port;
    private final long timeoutSeconds;

    public SvhnImportService(JdbcTemplate jdbc, WorkspaceService spaces,
                             @Value("${hdr.import.python:python}") String python,
                             @Value("${hdr.import.script:model-service/tools/svhn_import.py}") String script,
                             @Value("${hdr.import.root:.}") String root,
                             @Value("${server.port:8080}") int port,
                             @Value("${hdr.import.timeout-seconds:900}") long timeoutSeconds) {
        this.jdbc = jdbc;
        this.spaces = spaces;
        this.python = Paths.get(python).toAbsolutePath().normalize();
        this.script = Paths.get(script).toAbsolutePath().normalize();
        this.root = Paths.get(root).toAbsolutePath().normalize();
        this.port = port;
        this.timeoutSeconds = timeoutSeconds;
    }

    /** 列出允许根目录下含 digitStruct.mat 的目录（最多 3 层），供页面下拉选择。 */
    public java.util.List<Map<String, Object>> sources() {
        java.util.List<Map<String, Object>> found = new ArrayList<>();
        if (!Files.isDirectory(root)) return found;
        int maxDepth = 3;
        try (var stream = Files.walk(root, maxDepth)) {
            stream.filter(Files::isDirectory)
                    .filter(path -> !path.getFileName().toString().startsWith("."))
                    .filter(path -> !path.toString().contains("node_modules"))
                    .filter(path -> !path.toString().contains("collected-samples"))
                    .filter(path -> Files.isRegularFile(path.resolve("digitStruct.mat")))
                    .limit(100)
                    .forEach(path -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("path", path.toString());
                        row.put("name", root.relativize(path).toString().replace('\\', '/'));
                        found.add(row);
                    });
        } catch (IOException error) {
            LOG.warn("Scanning import sources failed ({})", error.getClass().getSimpleName());
        }
        return found;
    }

    public Map<String, Object> importSvhn(long workspaceId, long userId, long datasetId,
                                          String directory, Integer perLabel, String authorization) {
        spaces.requireMember(workspaceId, userId);
        Long owned = jdbc.queryForObject(
                "SELECT COUNT(*) FROM t_v2_dataset WHERE id=? AND workspace_id=? AND status='ACTIVE'",
                Long.class, datasetId, workspaceId);
        if (owned == null || owned == 0) throw new V2Exception(404, "数据集不存在", "DATASET_NOT_FOUND");
        if (perLabel == null || perLabel < 1 || perLabel > MAX_PER_LABEL)
            throw new V2Exception(400, "每类数量必须在 1.." + MAX_PER_LABEL, "VALIDATION");
        if (directory == null || directory.isBlank())
            throw new V2Exception(400, "缺少数据集目录", "VALIDATION");
        if (authorization == null || !authorization.startsWith("Bearer "))
            throw new V2Exception(401, "缺少访问令牌", "UNAUTHORIZED");

        Path dir = Paths.get(directory).toAbsolutePath().normalize();
        if (!dir.startsWith(root))
            throw new V2Exception(400, "目录必须位于允许的导入根目录下：" + root, "PATH_NOT_ALLOWED");
        if (!Files.isDirectory(dir)) throw new V2Exception(400, "目录不存在：" + dir, "PATH_NOT_FOUND");
        Path labels = dir.resolve("digitStruct.mat");
        if (!Files.isRegularFile(labels))
            throw new V2Exception(400, "目录下没有 digitStruct.mat，无法读取标签", "LABELS_NOT_FOUND");
        if (!Files.isRegularFile(script))
            throw new V2Exception(503, "导入脚本不存在：" + script, "IMPORT_SCRIPT_MISSING");

        List<String> command = new ArrayList<>(List.of(
                python.toString(), "-I", "-u", script.toString(),
                "--images", dir.toString(),
                "--labels", labels.toString(),
                "--dataset-id", Long.toString(datasetId),
                "--per-label", Integer.toString(perLabel),
                "--batch", "20",
                "--api", "http://127.0.0.1:" + port,
                "--token", authorization.substring("Bearer ".length()),
                "--workspace", Long.toString(workspaceId)));
        return run(command);
    }

    private Map<String, Object> run(List<String> command) {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(true);
        builder.environment().put("PYTHONIOENCODING", "utf-8");
        long started = System.currentTimeMillis();
        try {
            Process process = builder.start();
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append('\n');
                }
            }
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                throw new V2Exception(504, "导入超时（" + timeoutSeconds + " 秒），请减少每类数量", "IMPORT_TIMEOUT");
            }
            int exit = process.exitValue();
            String text = output.toString();
            LOG.info("SVHN import exit={} in {}ms", exit, System.currentTimeMillis() - started);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("exitCode", exit);
            result.put("seconds", Math.round((System.currentTimeMillis() - started) / 100.0) / 10.0);
            result.put("summary", lastJson(text));
            result.put("log", tail(text, 4000));
            if (exit != 0) {
                result.put("message", "导入脚本执行失败，请查看日志");
            }
            return result;
        } catch (IOException error) {
            LOG.warn("SVHN import failed to start ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "无法启动导入脚本，请检查 Python 路径配置", "IMPORT_UNAVAILABLE");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new V2Exception(503, "导入被中断", "IMPORT_UNAVAILABLE");
        }
    }

    /** 脚本最后会打印一段 JSON 汇总；取"包含 imported 字段"的最后一段。 */
    private Map<String, Object> lastJson(String text) {
        com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        int position = text.length();
        while (true) {
            int start = text.lastIndexOf('{', position - 1);
            if (start < 0) break;
            try {
                com.fasterxml.jackson.databind.JsonNode node = mapper.readTree(text.substring(start));
                if (node.isObject() && node.has("imported")) {
                    return mapper.convertValue(node,
                            new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
                }
            } catch (Exception ignored) {
                // 不是完整 JSON，继续往前找
            }
            position = start;
        }
        return Map.of();
    }

    private static String tail(String text, int limit) {
        return text.length() <= limit ? text : text.substring(text.length() - limit);
    }
}
