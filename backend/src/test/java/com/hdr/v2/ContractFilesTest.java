package com.hdr.v2;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** YAML parsing and local references only, not a full OpenAPI validator or Docker execution. */
class ContractFilesTest {
    private final Path root = Path.of(System.getProperty("basedir")).getParent();

    private Map<?, ?> read(String relative) throws IOException {
        var options = new LoaderOptions();
        options.setAllowDuplicateKeys(false);
        try (var stream = Files.newInputStream(root.resolve(relative))) {
            return new Yaml(new SafeConstructor(options)).load(stream);
        }
    }

    @Test
    void openApiParsesWithUniqueOperationsAndResolvableLocalReferences() throws IOException {
        var document = read("docs/api/openapi-v2.yaml");
        assertEquals("3.1.0", document.get("openapi"));
        Set<String> ids = new HashSet<>();
        check(document, document, ids);
        assertEquals(29, ids.size());
    }

    private void check(Object node, Map<?, ?> root, Set<String> ids) {
        if (node instanceof Map<?, ?> map) {
            if (map.get("operationId") instanceof String id) assertTrue(ids.add(id), "Duplicate operationId " + id);
            if (map.get("$ref") instanceof String ref) {
                assertTrue(ref.startsWith("#/"), "Only local contract references are expected");
                Object target = root;
                for (String key : ref.substring(2).split("/")) {
                    assertInstanceOf(Map.class, target, ref);
                    target = ((Map<?, ?>) target).get(key.replace("~1", "/").replace("~0", "~"));
                    assertNotNull(target, "Unresolved reference " + ref);
                }
            }
            map.values().forEach(value -> check(value, root, ids));
        } else if (node instanceof List<?> list) list.forEach(value -> check(value, root, ids));
    }

    @Test
    void composeDoesNotPublishInternalServicesOrMountLegacyInitialization() throws IOException {
        var document = read("docker-compose.yml");
        Map<?, ?> services = (Map<?, ?>) document.get("services");
        for (String name : List.of("mysql", "redis", "backend", "model-service")) {
            Map<?, ?> service = (Map<?, ?>) services.get(name);
            assertFalse(service.containsKey("ports"), name + " must not publish host ports");
        }
        Map<?, ?> frontend = (Map<?, ?>) services.get("frontend");
        assertTrue(((List<?>) frontend.get("ports")).get(0).toString().startsWith("127.0.0.1:"));
        assertFalse(Files.readString(root.resolve("docker-compose.yml")).contains("docker-entrypoint-initdb.d"));
    }

    @Test
    void pilotConfigurationKeepsPrivateServicesAndDisablesDevelopmentEntrypoints() throws IOException {
        var pilot = read("docker-compose.pilot.yml");
        var services = (Map<?, ?>) pilot.get("services");
        for (String name : List.of("mysql", "backend", "model-service")) {
            assertFalse(((Map<?, ?>) services.get(name)).containsKey("ports"));
        }
        var backend = (Map<?, ?>) services.get("backend");
        assertEquals("pilot", ((Map<?, ?>) backend.get("environment")).get("SPRING_PROFILES_ACTIVE"));
        var config = read("backend/src/main/resources/application-pilot.yml");
        var docs = (Map<?, ?>) config.get("springdoc");
        assertEquals(false, ((Map<?, ?>) docs.get("api-docs")).get("enabled"));
        var hdr = (Map<?, ?>) config.get("hdr");
        assertEquals(true, ((Map<?, ?>) hdr.get("pilot")).get("enabled"));
        assertEquals(false, ((Map<?, ?>) hdr.get("legacy")).get("auth-enabled"));
        assertEquals("none", ((Map<?, ?>) config.get("server")).get("forward-headers-strategy"));
    }

    @Test
    void ingressRetainsAccessLogsWithoutQueryStringsOrCredentials() throws IOException {
        for (String file : List.of("frontend/nginx.conf", "deploy/pilot/nginx-https.conf.template")) {
            String config = Files.readString(root.resolve(file));
            assertFalse(config.contains("access_log off"));
            int start = config.indexOf("log_format ");
            assertTrue(start >= 0);
            String format = config.substring(start, config.indexOf(';', start));
            assertTrue(format.contains("$request_method $uri $server_protocol"));
            assertTrue(format.contains("$status"));
            assertFalse(format.contains("$request_uri"));
            assertFalse(format.contains("$args"));
            assertFalse(format.contains("$http_authorization"));
            assertFalse(format.contains("$request_body"));
        }
    }

    @Test
    void ciKeepsFourJobsAndMysqlIntegrationProfile() throws IOException {
        var document = read(".github/workflows/ci.yml");
        Map<?, ?> jobs = (Map<?, ?>) document.get("jobs");
        assertEquals(Set.of("backend", "model-service", "frontend", "miniprogram"), jobs.keySet());
        Map<?, ?> backend = (Map<?, ?>) jobs.get("backend");
        assertTrue(((Map<?, ?>) backend.get("services")).containsKey("mysql"));
        assertTrue(backend.get("steps").toString().contains("-Pmysql-it verify"));
    }
}
