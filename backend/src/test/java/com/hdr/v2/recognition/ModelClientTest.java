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
    private final CatalogueService.Model model = new CatalogueService.Model("1", "MNIST", ModelClient.VERSION,
            "PUBLIC", null, ModelClient.MODEL, .991, "MNIST test", ModelClient.PREPROCESS, "Baseline");
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
                + "\",\"modelId\":\"" + ModelClient.MODEL + "\",\"modelVersion\":\"" + ModelClient.VERSION
                + "\",\"preprocessVersion\":\"" + ModelClient.PREPROCESS
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
    void missingCredentialDoesNotSendNetworkRequest() {
        ModelClient unconfigured = new ModelClient(RestClient.create("http://unused.test"), new ObjectMapper(), "");
        assertEquals(503, assertThrows(V2Exception.class, () -> unconfigured.predict(2, REQUEST, model, image)).getStatus());
        server.verify();
    }

    @Test
    void readinessRequiresManifestDigest() {
        server.expect(requestTo("http://model.test/internal/v2/ready"))
                .andExpect(header("X-HDR-Internal-Token", "internal-test-token"))
                .andRespond(withSuccess("{\"code\":0,\"data\":{\"status\":\"UP\",\"sha256\":\"wrong\"}}", MediaType.APPLICATION_JSON));
        assertEquals("DOWN", client.ready().get("status"));
        server.verify();
    }
}
