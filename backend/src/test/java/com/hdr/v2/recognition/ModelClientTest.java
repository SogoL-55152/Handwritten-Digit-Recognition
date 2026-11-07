package com.hdr.v2.recognition;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

class ModelClientTest {
    private static final String REQUEST = "00000000-0000-4000-8000-000000000001";
    private static final String MODEL_ID = "mnist-cnn-w1";
    private static final String VERSION = "w2-canvas-photo-3epoch";
    private static final String PREPROCESS = "adaptive-mnist-v2";
    private static final String SHA = "72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa";
    private final CatalogueService.Model model = new CatalogueService.Model("1", "MNIST", VERSION,
            "PUBLIC", null, MODEL_ID, .977, "MNIST test", PREPROCESS, "Baseline", "ACTIVE", SHA, 1690340L,
            "w2-canvas-photo/checkpoint.pt");
    private final ImageValidator.Image image = new ImageValidator.Image(new byte[]{1, 2}, "digest", "image/png");
    private MockRestServiceServer server;
    private ModelClient client;

    @BeforeEach
    void setup() {
        RestClient.Builder builder = RestClient.builder().baseUrl("http://model.test");
        server = MockRestServiceServer.bindTo(builder).build();
        client = new ModelClient(builder.build(), new ObjectMapper(), "internal-test-token");
    }

    private String response(String code, String digit, String confidence) {
        return "{\"code\":" + code + ",\"data\":{\"requestId\":\"" + REQUEST
                + "\",\"modelId\":\"" + MODEL_ID + "\",\"modelVersion\":\"" + VERSION
                + "\",\"preprocessVersion\":\"" + PREPROCESS
                + "\",\"digit\":" + digit + ",\"confidence\":" + confidence + "}}";
    }

    private void expect(String body) {
        server.expect(requestTo("http://model.test/internal/v2/predict"))
                .andExpect(method(HttpMethod.POST)).andExpect(header("X-HDR-Internal-Token", "internal-test-token"))
                .andExpect(content().contentTypeCompatibleWith(MediaType.MULTIPART_FORM_DATA))
                .andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
    }

    @Test
    void returnsRealPredictionAndSendsInternalAuthenticatedMultipart() {
        expect(response("0", "7", "0.98"));
        assertEquals(new ModelClient.Prediction(7, .98), client.predict(2, REQUEST, model, image));
        server.verify();
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "10", "4294967296", "4294967297", "9223372036854775808", "1.0", "\"1\"", "null"})
    void rejectsInvalidDigitsIncludingIntegerWraparound(String digit) {
        expect(response("0", digit, "0.5"));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
        server.verify();
    }

    @ParameterizedTest
    @ValueSource(strings = {"-0.01", "1.01", "1e999", "\"0.5\"", "null"})
    void rejectsInvalidConfidence(String confidence) {
        expect(response("0", "3", confidence));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
    }

    @Test
    void rejectsWrappedEnvelopeCodeAndMismatchedRequest() {
        expect(response("4294967296", "3", "0.5"));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
        server.verify();
        server.reset();
        expect(response("0", "3", "0.5").replace(REQUEST, "different-request"));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
    }

    @Test
    void boundsUpstreamBody() {
        expect(" ".repeat(65537));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
    }

    @Test
    void upstreamFailureIsNotRetried() {
        server.expect(requestTo("http://model.test/internal/v2/predict")).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE));
        assertEquals(503, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
        server.verify();
    }

    @Test
    void upstreamBusyPreservesRateLimitCategoryWithoutRetrying() {
        server.expect(requestTo("http://model.test/internal/v2/predict")).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        var error = assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image));
        assertEquals(429, error.getStatus());
        assertEquals("MODEL_BUSY", error.getCategory());
        assertEquals(1, error.getRetryAfterSeconds());
        server.verify();
    }

    @Test
    void uncertainInputIsBusiness422WithSanitizedMessageAndNoRetry() {
        server.expect(requestTo("http://model.test/internal/v2/predict"))
                .andRespond(withStatus(HttpStatus.UNPROCESSABLE_ENTITY).contentType(MediaType.APPLICATION_JSON)
                        .body("{\"code\":422,\"message\":\"private internal path\",\"data\":{\"category\":\"UNRECOGNIZED_INPUT\",\"digit\":7}}"));
        var error = assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image));
        assertEquals(422, error.getStatus());
        assertEquals("UNRECOGNIZED_INPUT", error.getCategory());
        assertFalse(error.getMessage().contains("private"));
        server.verify();
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{", "{\"code\":422,\"data\":{\"category\":\"UNKNOWN\"}}", "{\"code\":\"422\",\"data\":{\"category\":\"UNRECOGNIZED_INPUT\"}}"})
    void malformedOrUnknown422RemainsUpstreamError(String body) {
        server.expect(requestTo("http://model.test/internal/v2/predict"))
                .andRespond(withStatus(HttpStatus.UNPROCESSABLE_ENTITY).contentType(MediaType.APPLICATION_JSON).body(body));
        assertEquals(502, assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, model, image)).getStatus());
    }

    @Test
    void realHttpRejectionIsNotTurnedIntoTransportFailure() throws Exception {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/v2/predict", exchange -> {
            try (exchange) {
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{\"code\":422,\"data\":{\"category\":\"UNRECOGNIZED_INPUT\"}}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(422, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        server.start();
        try {
            var liveClient = new ModelClient(new ObjectMapper(), "http://127.0.0.1:" + server.getAddress().getPort(), "test-token");
            assertEquals(422, assertThrows(V2Exception.class, () -> liveClient.predict(2, REQUEST, model, image)).getStatus());
        } finally { server.stop(0); }
    }

    @Test
    void missingCredentialDoesNotSendNetworkRequest() {
        ModelClient unconfigured = new ModelClient(RestClient.create("http://unused.test"), new ObjectMapper(), "");
        assertEquals(503, assertThrows(V2Exception.class, () -> unconfigured.predict(2, REQUEST, model, image)).getStatus());
        server.verify();
    }

    @Test
    void readinessRequiresAtLeastOneVerifiedModel() {
        server.expect(requestTo("http://model.test/internal/v2/ready"))
                .andExpect(header("X-HDR-Internal-Token", "internal-test-token"))
                .andRespond(withSuccess("{\"code\":0,\"data\":{\"status\":\"UP\",\"verifiedModels\":0}}",
                        MediaType.APPLICATION_JSON));
        assertEquals("DOWN", client.ready().get("status"));
        server.verify();
    }

    @Test
    void readinessReportsVerifiedModels() {
        server.expect(requestTo("http://model.test/internal/v2/ready"))
                .andRespond(withSuccess("{\"code\":0,\"data\":{\"status\":\"UP\",\"verifiedModels\":2}}",
                        MediaType.APPLICATION_JSON));
        assertEquals("UP", client.ready().get("status"));
        server.verify();
    }

    @Test
    void registryListingParsesVerifiedAndRejectedEntries() {
        server.expect(requestTo("http://model.test/internal/v2/models"))
                .andExpect(header("X-HDR-Internal-Token", "internal-test-token"))
                .andRespond(withSuccess("{\"code\":0,\"data\":{\"models\":["
                        + "{\"modelId\":\"mnist-cnn-w1\",\"modelVersion\":\"" + VERSION + "\",\"preprocessVersion\":\""
                        + PREPROCESS + "\",\"sha256\":\"" + SHA + "\",\"sizeBytes\":1690340,"
                        + "\"artifact\":\"w2-canvas-photo/checkpoint.pt\",\"verified\":true,\"loaded\":false},"
                        + "{\"modelId\":\"mnist-cnn-w1\",\"modelVersion\":\"broken\",\"verified\":false,"
                        + "\"reason\":\"RegistryInvalid\"}]}}", MediaType.APPLICATION_JSON));
        var models = client.registry();
        assertEquals(2, models.size());
        assertTrue(models.get(0).verified());
        assertEquals(SHA, models.get(0).sha256());
        assertEquals("w2-canvas-photo/checkpoint.pt", models.get(0).artifact());
        assertFalse(models.get(1).verified());
        assertEquals("RegistryInvalid", models.get(1).reason());
        server.verify();
    }

    @Test
    void modelWithoutArtifactIdentityIsUnavailable() {
        var unidentified = new CatalogueService.Model("1", "MNIST", VERSION, "PUBLIC", null, MODEL_ID, .9,
                "MNIST test", PREPROCESS, "Baseline", "INACTIVE", null, null, null);
        var error = assertThrows(V2Exception.class, () -> client.predict(2, REQUEST, unidentified, image));
        assertEquals(503, error.getStatus());
        server.verify();
    }
}
