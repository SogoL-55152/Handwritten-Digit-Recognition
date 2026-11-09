package com.hdr.v2.migration;

import org.flywaydb.core.Flyway;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Explicit offline W1 upgrade utility, never called by application startup. */
public final class W1UpgradeHelper {
    private W1UpgradeHelper() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !"--confirm-w1-baseline".equals(args[0])) {
            throw new IllegalArgumentException("Usage: --confirm-w1-baseline <database-name> <backup-file> <backup-sha256>");
        }
        String url = requiredEnvironment("W2_UPGRADE_URL");
        String username = requiredEnvironment("W2_UPGRADE_USERNAME");
        String password = requiredEnvironment("W2_UPGRADE_PASSWORD");
        Path backup = Path.of(args[2]);
        if (!Files.isRegularFile(backup) || Files.size(backup) == 0) {
            throw new IllegalStateException("A verified nonempty offline backup is required");
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(backup)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        if (!HexFormat.of().formatHex(digest.digest()).equalsIgnoreCase(args[3])) {
            throw new IllegalStateException("Backup checksum mismatch");
        }
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url, username, password);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        if (!args[1].equals(jdbc.queryForObject("SELECT DATABASE()", String.class))) {
            throw new IllegalStateException("Selected database does not match the explicit confirmation");
        }
        validate(jdbc);
        Flyway.configure().dataSource(dataSource).baselineVersion("1")
                .baselineDescription("Validated offline W1 upgrade")
                .baselineOnMigrate(false).cleanDisabled(true).load().baseline();
        System.out.println("W1 baseline recorded. No W2 migration was run. Start the application only after reviewing the backup and configuration.");
    }

    /** Fails closed for anything other than the exact supported W1 schema. No mutation. */
    public static void validate(JdbcTemplate jdbc) {
        Map<String, TableShape> expected = baselineShape();
        List<Map<String, Object>> tables = jdbc.queryForList("""
                SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE()
                """);
        Set<String> names = new HashSet<>();
        for (Map<String, Object> table : tables) {
            names.add(text(table.get("TABLE_NAME")));
            if (!"BASE TABLE".equals(table.get("TABLE_TYPE")) || !"InnoDB".equals(table.get("ENGINE"))
                    || !text(table.get("TABLE_COLLATION")).startsWith("utf8mb4_")) fail("Unsupported table engine, view, or character set");
        }
        if (!names.equals(expected.keySet())) fail("Expected exactly the five W1 tables and no Flyway history");
        for (String table : expected.keySet()) {
            Map<String, ColumnShape> columns = new LinkedHashMap<>();
            jdbc.query("""
                    SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLLATION_NAME
                    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
                    ORDER BY ORDINAL_POSITION
                    """, rs -> {
                String collation = rs.getString("COLLATION_NAME");
                if (collation != null && !collation.startsWith("utf8mb4_")) fail("Unexpected column character set");
                columns.put(rs.getString("COLUMN_NAME"), new ColumnShape(
                        normalizeType(rs.getString("COLUMN_TYPE")), "YES".equals(rs.getString("IS_NULLABLE")),
                        normalizeDefault(rs.getString("COLUMN_DEFAULT")), normalizeExtra(rs.getString("EXTRA"))));
            }, table);
            if (!columns.equals(expected.get(table).columns())) fail("W1 column mismatch in " + table);
            Map<String, IndexShape> indexes = new LinkedHashMap<>();
            jdbc.query("""
                    SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX
                    """, rs -> {
                if (rs.getObject("SUB_PART") != null) fail("Prefix indexes are not supported W1 indexes");
                String index = rs.getString("INDEX_NAME");
                IndexShape previous = indexes.get(index);
                String columnsList = (previous == null ? "" : previous.columns() + ",") + rs.getString("COLUMN_NAME");
                indexes.put(index, new IndexShape(rs.getBoolean("NON_UNIQUE"), columnsList));
            }, table);
            if (!indexes.equals(expected.get(table).indexes())) fail("W1 index mismatch in " + table);
        }
        for (String query : List.of(
                "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
                "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
                "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()",
                "SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()",
                "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'")) {
            Long count = jdbc.queryForObject(query, Long.class);
            if (count == null || count != 0) fail("Unexpected W1 database objects or constraints");
        }
    }

    static Map<String, TableShape> baselineShape() {
        String sql;
        try (InputStream stream = W1UpgradeHelper.class.getResourceAsStream("/db/migration/V1__w1_baseline.sql")) {
            if (stream == null) throw new IllegalStateException("W1 baseline resource missing");
            sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot read W1 baseline", e);
        }
        Map<String, TableShape> tables = new LinkedHashMap<>();
        Matcher tableMatcher = Pattern.compile("CREATE TABLE IF NOT EXISTS (\\w+) \\((.*?)\\) ENGINE", Pattern.DOTALL).matcher(sql);
        while (tableMatcher.find()) {
            Map<String, ColumnShape> columns = new LinkedHashMap<>();
            Map<String, IndexShape> indexes = new LinkedHashMap<>();
            for (String line : tableMatcher.group(2).split("\\R")) {
                line = line.strip().replaceFirst(",$", "");
                if (line.isEmpty()) continue;
                Matcher index = Pattern.compile("(UNIQUE )?KEY (\\w+) \\(([^)]+)\\)").matcher(line);
                if (index.matches()) {
                    indexes.put(index.group(2), new IndexShape(index.group(1) == null, index.group(3).replace(" ", "")));
                    continue;
                }
                Matcher column = Pattern.compile("(\\w+)\\s+([A-Z]+(?:\\(\\d+\\))?)(.*)").matcher(line);
                if (!column.matches()) fail("Unexpected baseline grammar");
                String clauses = column.group(3);
                Matcher value = Pattern.compile("DEFAULT (NULL|'[^']*'|\\w+)").matcher(clauses);
                String defaultValue = value.find() ? value.group(1) : null;
                if ("NULL".equals(defaultValue)) defaultValue = null;
                if (defaultValue != null && defaultValue.startsWith("'")) defaultValue = defaultValue.substring(1, defaultValue.length() - 1);
                String extra = clauses.contains("AUTO_INCREMENT") ? "auto_increment" : "";
                if (clauses.contains("ON UPDATE CURRENT_TIMESTAMP")) extra = "on update current_timestamp";
                columns.put(column.group(1), new ColumnShape(normalizeType(column.group(2)), !clauses.contains("NOT NULL"),
                        normalizeDefault(defaultValue), extra));
                if (clauses.contains("PRIMARY KEY")) indexes.put("PRIMARY", new IndexShape(false, column.group(1)));
            }
            tables.put(tableMatcher.group(1), new TableShape(columns, indexes));
        }
        if (tables.size() != 5) fail("Incomplete W1 baseline");
        return tables;
    }

    private static String normalizeType(String type) {
        return type.toLowerCase(Locale.ROOT).replaceAll("(bigint|int|tinyint)\\(\\d+\\)", "$1");
    }
    private static String normalizeDefault(String value) {
        return value == null ? null : value.replace("CURRENT_TIMESTAMP()", "CURRENT_TIMESTAMP")
                .replace("current_timestamp()", "CURRENT_TIMESTAMP");
    }
    private static String normalizeExtra(String value) {
        return value.toLowerCase(Locale.ROOT).replace("default_generated", "").replace("current_timestamp()", "current_timestamp").strip();
    }
    private static String text(Object value) { return value == null ? "" : value.toString(); }
    private static void fail(String message) { throw new IllegalStateException(message); }
    private static String requiredEnvironment(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) throw new IllegalStateException("Missing environment setting: " + key);
        return value;
    }
    record ColumnShape(String type, boolean nullable, String defaultValue, String extra) {}
    record IndexShape(boolean nonUnique, String columns) {}
    record TableShape(Map<String, ColumnShape> columns, Map<String, IndexShape> indexes) {}
}
