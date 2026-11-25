package com.hdr.v2.recognition;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

/** 模型对比客户端的解析与错误映射；真实推理由模型服务自己的契约测试覆盖。 */
class ModelClientCompareTest {
    private static final String MODEL_ID = "mnist-cnn-w1";
    private static final String PREPROCESS = "adaptive-mnist-v2";
    private static final ModelClient.CompareSide A = new ModelClient.CompareSide(MODEL_ID, "v-a", PREPROCESS);
    private static final ModelClient.CompareSide B = new ModelClient.CompareSide(MODEL_ID, "v-b", PREPROCESS);
    private static final List<byte[]> IMAGES = List.of(new byte[]{1, 2}, new byte[]{3, 4});
    private static final List<Integer> LABELS = List.of(7, 3);

    private MockRestServiceServer server;
    private ModelClient client;

    @BeforeEach
    void setup() {
        RestClient.Builder builder = RestClient.builder().baseUrl("http://model.test");
        server = MockRestServiceServer.bindTo(builder).build();
        client = new ModelClient(builder.build(), new ObjectMapper(), "internal-test-token");
    }

    private String body(String versionA, String versionB, int rows) {
        StringBuilder json = new StringBuilder("{\"code\":0,\"message\":\"ok\",\"data\":{")
                .append("\"modelA\":{\"modelId\":\"").append(MODEL_ID).append("\",\"modelVersion\":\"")
                .append(versionA).append("\",\"preprocessVersion\":\"").append(PREPROCESS).append("\"},")
                .append("\"modelB\":{\"modelId\":\"").append(MODEL_ID).append("\",\"modelVersion\":\"")
                .append(versionB).append("\",\"preprocessVersion\":\"").append(PREPROCESS).append("\"},")
                .append("\"summary\":{\"samples\":2,\"labelled\":2,\"agreement\":1,\"agreementRate\":0.5,")
                .append("\"accuracyA\":0.5,\"accuracyB\":1.0,\"bothRight\":1,\"onlyA\":0,\"onlyB\":1,")
                .append("\"bothWrong\":0,\"meanConfidenceA\":0.9,\"meanConfidenceB\":0.8},")
                .append("\"rows\":[")
                .append("{\"index\":0,\"label\":7,\"digitA\":7,\"confidenceA\":0.91,\"digitB\":7,\"confidenceB\":0.81,\"agree\":true},")
                .append("{\"index\":1,\"label\":3,\"digitA\":9,\"confidenceA\":0.89,\"digitB\":3,\"confidenceB\":0.79,\"agree\":false}");
        if (rows > 2) {
            json.append(",{\"index\":2,\"label\":1,\"digitA\":1,\"confidenceA\":0.5,\"digitB\":1,\"confidenceB\":0.5,\"agree\":true}");
        }
        return json.append("],\"processingMs\":42}}").toString();
    }

    private void expect(String json) {
        server.expect(requestTo("http://model.test/internal/v2/compare"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("X-HDR-Internal-Token", "internal-test-token"))
                .andExpect(content().contentTypeCompatibleWith(MediaType.MULTIPART_FORM_DATA))
                .andRespond(withSuccess(json, MediaType.APPLICATION_JSON));
    }

    @Test
    void parsesRowsAndSummary() {
        expect(body("v-a", "v-b", 2));
        ModelClient.CompareResult result = client.compare(A, B, IMAGES, LABELS);
        assertEquals("v-a", result.modelA().version());
        assertEquals("v-b", result.modelB().version());
        assertEquals(2, result.rows().size());
        assertEquals(7, result.rows().get(0).digitA());
        assertTrue(result.rows().get(0).agree());
        assertEquals(9, result.rows().get(1).digitA());
        assertEquals(3, result.rows().get(1).digitB());
        assertFalse(result.rows().get(1).agree());
        assertEquals(0.5, result.summary().agreementRate());
        assertEquals(1, result.summary().onlyB());
        assertEquals(42L, result.processingMs());
        server.verify();
    }

    @Test
    void rejectsRowCountMismatch() {
        expect(body("v-a", "v-b", 3));
        V2Exception error = assertThrows(V2Exception.class, () -> client.compare(A, B, IMAGES, LABELS));
        assertEquals(502, error.getStatus());
        assertEquals("MODEL_RESPONSE_INVALID", error.getCategory());
    }

    @Test
    void rejectsIdentityEchoMismatch() {
        expect(body("other-version", "v-b", 2));
        V2Exception error = assertThrows(V2Exception.class, () -> client.compare(A, B, IMAGES, LABELS));
        assertEquals(502, error.getStatus());
    }

    @Test
    void rejectsDigitOutOfRange() {
        String json = body("v-a", "v-b", 2).replace("\"digitA\":9", "\"digitA\":12");
        expect(json);
        assertEquals(502, assertThrows(V2Exception.class, () -> client.compare(A, B, IMAGES, LABELS)).getStatus());
    }

    @Test
    void unregisteredModelBecomesAnActionable400() {
        server.expect(requestTo("http://model.test/internal/v2/compare"))
                .andRespond(withStatus(HttpStatus.BAD_REQUEST).contentType(MediaType.APPLICATION_JSON)
                        .body("{\"code\":400,\"message\":\"只允许使用已注册且预处理版本匹配的模型\","
                                + "\"data\":{\"category\":\"MODEL_NOT_ALLOWED\"}}"));
        V2Exception error = assertThrows(V2Exception.class, () -> client.compare(A, B, IMAGES, LABELS));
        assertEquals(400, error.getStatus());
        assertEquals("MODEL_NOT_ALLOWED", error.getCategory());
        assertTrue(error.getMessage().contains("对比用模型"));
    }

    @Test
    void rejectsEmptyInput() {
        assertThrows(V2Exception.class, () -> client.compare(A, B, List.of(), List.of()));
        assertThrows(V2Exception.class, () -> client.compare(A, B, IMAGES, List.of(7)));
    }
}
