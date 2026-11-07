package com.hdr.v2.recognition;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;
import java.io.IOException;
import java.util.Map;

@Component
public class ModelClient {
    public static final String SHA="72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa";
    public static final String MODEL="mnist-cnn-w1",VERSION="w2-canvas-photo-3epoch",PREPROCESS="adaptive-mnist-v2";
    public record Prediction(int digit,double confidence) {}
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(ModelClient.class);
    private final RestClient client;
    private final ObjectMapper mapper;
    private final String internalToken;

    @org.springframework.beans.factory.annotation.Autowired
    public ModelClient(ObjectMapper mapper,
            @Value("${hdr.model-service.base-url:http://127.0.0.1:5001}") String url,
            @Value("${hdr.model-service.internal-token:}") String internalToken) {
        this.mapper=mapper; this.internalToken=internalToken;
        var factory=new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(2000); factory.setReadTimeout(10000);
        this.client=RestClient.builder().baseUrl(url).requestFactory(factory).build();
    }
    public ModelClient(RestClient client,ObjectMapper mapper,String internalToken) {
        this.client=client; this.mapper=mapper; this.internalToken=internalToken;
    }
    public Prediction predict(long workspaceId,String requestId,CatalogueService.Model model,ImageValidator.Image image) {
        requireConfigured();
        if(!MODEL.equals(model.externalId()) || !VERSION.equals(model.version()) || !PREPROCESS.equals(model.preprocessVersion()))
            throw new V2Exception(503,"当前模型版本尚未部署","MODEL_UNAVAILABLE");
        var body=new LinkedMultiValueMap<String,Object>();
        var headers=new HttpHeaders(); headers.setContentType(MediaType.parseMediaType(image.contentType()));
        body.add("image",new HttpEntity<>(new ByteArrayResource(image.bytes()) {
            @Override public String getFilename() { return "drawing"; }
        },headers));
        body.add("workspaceId",Long.toString(workspaceId)); body.add("requestId",requestId);
        body.add("modelId",model.externalId()); body.add("modelVersion",model.version()); body.add("preprocessVersion",model.preprocessVersion());
        try {
            JsonNode data=client.post().uri("/internal/v2/predict").header("X-HDR-Internal-Token",internalToken)
                    .contentType(MediaType.MULTIPART_FORM_DATA).body(body).exchange((request,response)->read(response));
            if(!requestId.equals(data.path("requestId").asText()) || !MODEL.equals(data.path("modelId").asText())
                    || !VERSION.equals(data.path("modelVersion").asText()) || !PREPROCESS.equals(data.path("preprocessVersion").asText())
                    || !data.path("digit").isIntegralNumber() || !data.path("digit").canConvertToInt()
                    || !data.path("confidence").isNumber()) throw invalidResponse();
            int digit=data.path("digit").asInt(-1); double confidence=data.path("confidence").asDouble(Double.NaN);
            if(digit<0 || digit>9 || !Double.isFinite(confidence) || confidence<0 || confidence>1) throw invalidResponse();
            return new Prediction(digit,confidence);
        } catch(V2Exception error) { throw error; }
        catch(Exception error) {
            LOG.warn("Internal prediction transport failed ({}, cause={})",error.getClass().getSimpleName(),
                    error.getCause()==null?"none":error.getCause().getClass().getSimpleName());
            throw new V2Exception(502,"模型调用失败或超时，请使用新的请求重试","MODEL_UNAVAILABLE");
        }
    }
    public Map<String,Object> ready() {
        requireConfigured();
        try {
            JsonNode data=client.get().uri("/internal/v2/ready").header("X-HDR-Internal-Token",internalToken)
                    .exchange((request,response)->read(response));
            if(!"UP".equals(data.path("status").asText()) || !MODEL.equals(data.path("modelId").asText())
                    || !VERSION.equals(data.path("modelVersion").asText()) || !PREPROCESS.equals(data.path("preprocessVersion").asText())
                    || !SHA.equals(data.path("sha256").asText())) throw invalidResponse();
            return Map.of("name","model-service","status","UP","detail",MODEL+" / "+VERSION);
        } catch(Exception error) { return Map.of("name","model-service","status","DOWN","detail","模型服务或可信基线未就绪"); }
    }
    private JsonNode read(org.springframework.http.client.ClientHttpResponse response) throws IOException {
        // HttpURLConnection initializes its error stream when status is resolved.
        // Reading the body first makes non-2xx responses throw before we can map them.
        int status=response.getStatusCode().value();
        byte[] bytes=response.getBody().readNBytes(65537);
        if(bytes.length>65536) throw invalidResponse();
        if(status==400) throw new V2Exception(400,"图片未通过模型服务校验","INVALID_IMAGE");
        if(status==413) throw new V2Exception(413,"图片超出模型服务限制","IMAGE_TOO_LARGE");
        if(status==422) {
            JsonNode rejected;
            try { rejected=mapper.readTree(bytes); }
            catch(IOException invalid) { throw invalidResponse(); }
            if(rejected==null || !rejected.path("code").isIntegralNumber() || !rejected.path("code").canConvertToInt()
                    || rejected.path("code").intValue()!=422 || !rejected.path("data").isObject()
                    || !"UNRECOGNIZED_INPUT".equals(rejected.path("data").path("category").asText())) throw invalidResponse();
            throw new V2Exception(422,"无法可靠识别该输入，请清空后重新书写单个数字。","UNRECOGNIZED_INPUT");
        }
        if(status==429) throw new V2Exception(429,"模型服务正忙，请稍后发起新的识别","MODEL_BUSY",1);
        if(status!=200) throw new V2Exception(status==503?503:502,"模型服务暂不可用","MODEL_UNAVAILABLE");
        JsonNode root=mapper.readTree(bytes);
        if(root==null || !root.path("code").isIntegralNumber() || !root.path("code").canConvertToInt()
                || root.path("code").intValue()!=0 || !root.path("data").isObject()) throw invalidResponse();
        return root.path("data");
    }
    private void requireConfigured() {
        if(internalToken.isBlank()) throw new V2Exception(503,"模型内部凭据尚未配置","MODEL_UNAVAILABLE");
    }
    private V2Exception invalidResponse() { return new V2Exception(502,"模型返回的数据不符合接口约定","MODEL_RESPONSE_INVALID"); }
}
