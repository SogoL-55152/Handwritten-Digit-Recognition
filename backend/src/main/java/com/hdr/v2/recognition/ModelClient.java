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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 模型服务客户端。W3 起不再固定单一基线：模型身份来自数据库行，是否允许推理由
 * 模型服务的本地注册表（摘要校验）决定；这里只做格式、回显一致性与错误映射。
 */
@Component
public class ModelClient {
    public record Prediction(int digit,double confidence) {}
    public record RegisteredModel(String modelId,String modelVersion,String preprocessVersion,String sha256,
                                  long sizeBytes,String artifact,boolean verified,boolean loaded,String reason) {}
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

    /** 模型服务本地注册表：只有 verified 的条目允许推理。 */
    public List<RegisteredModel> registry() {
        requireConfigured();
        try {
            JsonNode data=client.get().uri("/internal/v2/models").header("X-HDR-Internal-Token",internalToken)
                    .exchange((request,response)->read(response));
            List<RegisteredModel> models=new ArrayList<>();
            for(JsonNode node:data.path("models")) {
                if(!node.path("verified").isBoolean()) throw invalidResponse();
                models.add(new RegisteredModel(node.path("modelId").asText(""),node.path("modelVersion").asText(""),
                        node.path("preprocessVersion").asText(""),node.path("sha256").asText(""),
                        node.path("sizeBytes").asLong(0),node.path("artifact").asText(""),
                        node.path("verified").asBoolean(false),
                        node.path("loaded").asBoolean(false),node.path("reason").asText("")));
            }
            return models;
        } catch(V2Exception error) { throw error; }
        catch(Exception error) { throw unavailable(); }
    }

    /** 让模型服务重新读取 registry.json；返回重载后的注册表视图。 */
    public List<RegisteredModel> reloadRegistry() {
        requireConfigured();
        try {
            client.post().uri("/internal/v2/models/reload").header("X-HDR-Internal-Token",internalToken)
                    .exchange((request,response)->read(response));
            return registry();
        } catch(V2Exception error) { throw error; }
        catch(Exception error) { throw unavailable(); }
    }

    public Prediction predict(long workspaceId,String requestId,CatalogueService.Model model,ImageValidator.Image image) {
        return predict(workspaceId,requestId,model,image,false);
    }

    public Prediction predict(long workspaceId,String requestId,CatalogueService.Model model,ImageValidator.Image image,
                              boolean enhance) {
        requireConfigured();
        if(model.sha256()==null || model.sha256().isBlank() || model.artifact()==null || model.artifact().isBlank())
            throw new V2Exception(503,"当前模型缺少可信文件信息","MODEL_UNAVAILABLE");
        var body=new LinkedMultiValueMap<String,Object>();
        var headers=new HttpHeaders(); headers.setContentType(MediaType.parseMediaType(image.contentType()));
        body.add("image",new HttpEntity<>(new ByteArrayResource(image.bytes()) {
            @Override public String getFilename() { return "drawing"; }
        },headers));
        body.add("workspaceId",Long.toString(workspaceId)); body.add("requestId",requestId);
        body.add("modelId",model.externalId()); body.add("modelVersion",model.version());
        body.add("preprocessVersion",model.preprocessVersion());
        try {
            String uri=enhance?"/internal/v2/predict?enhance=1":"/internal/v2/predict";
            JsonNode data=client.post().uri(uri).header("X-HDR-Internal-Token",internalToken)
                    .contentType(MediaType.MULTIPART_FORM_DATA).body(body).exchange((request,response)->read(response));
            if(!requestId.equals(data.path("requestId").asText())
                    || !model.externalId().equals(data.path("modelId").asText())
                    || !model.version().equals(data.path("modelVersion").asText())
                    || !model.preprocessVersion().equals(data.path("preprocessVersion").asText())
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
            int verified=data.path("verifiedModels").asInt(0);
            if(!"UP".equals(data.path("status").asText()) || verified<1) throw invalidResponse();
            return Map.of("name","model-service","status","UP","detail",verified+" verified model(s)");
        } catch(Exception error) { return Map.of("name","model-service","status","DOWN","detail","模型服务或可信模型未就绪"); }
    }

    /** 把训练任务交给模型服务的 Celery 队列；返回 Celery 任务 ID。 */
    public String enqueueTraining(String taskId, Map<String,Object> params) {
        requireConfigured();
        try {
            var body = Map.of("taskId", taskId, "params", params);
            JsonNode data = client.post().uri("/internal/v2/training").header("X-HDR-Internal-Token", internalToken)
                    .contentType(MediaType.APPLICATION_JSON).body(body).exchange((request, response) -> read(response));
            String celeryTaskId = data.path("celeryTaskId").asText("");
            if (celeryTaskId.isBlank() || celeryTaskId.length() > 64) throw invalidResponse();
            return celeryTaskId;
        } catch(V2Exception error) { throw error; }
        catch(Exception error) {
            LOG.warn("Training enqueue transport failed ({})",error.getClass().getSimpleName());
            throw new V2Exception(503,"训练队列暂不可用，请稍后重试","QUEUE_UNAVAILABLE");
        }
    }

    public record MultiDigit(int digit, double confidence, double margin, int left, int right) {}
    public record MultiPrediction(String text, java.util.List<MultiDigit> digits, boolean accepted, int maxDigits) {}

    /** 多位数字预览：切分与逐字推理都在模型服务内完成；不写数据库由调用方决定。 */
    public MultiPrediction predictMulti(long workspaceId, String requestId, CatalogueService.Model model,
                                        ImageValidator.Image image, int maxDigits) {
        requireConfigured();
        if(model.sha256()==null || model.sha256().isBlank() || model.artifact()==null || model.artifact().isBlank())
            throw new V2Exception(503,"当前模型缺少可信文件信息","MODEL_UNAVAILABLE");
        var body=new LinkedMultiValueMap<String,Object>();
        var headers=new HttpHeaders(); headers.setContentType(MediaType.parseMediaType(image.contentType()));
        body.add("image",new HttpEntity<>(new ByteArrayResource(image.bytes()) {
            @Override public String getFilename() { return "drawing"; }
        },headers));
        body.add("workspaceId",Long.toString(workspaceId)); body.add("requestId",requestId);
        body.add("modelId",model.externalId()); body.add("modelVersion",model.version());
        body.add("preprocessVersion",model.preprocessVersion());
        // 位数走查询参数：multipart 的 part 数有上限（字段也占 part），不再往表单里加字段。
        try {
            JsonNode data=client.post().uri("/internal/v2/predict/multi?maxDigits="+maxDigits).header("X-HDR-Internal-Token",internalToken)
                    .contentType(MediaType.MULTIPART_FORM_DATA).body(body).exchange((request,response)->read(response));
            String text=data.path("text").asText("");
            if(!requestId.equals(data.path("requestId").asText()) || !model.version().equals(data.path("modelVersion").asText())
                    || !data.path("digits").isArray() || text.isBlank() || text.length()>maxDigits
                    || !text.matches("[0-9]+") || data.path("digits").size()!=text.length()
                    || !data.path("accepted").isBoolean()) throw invalidResponse();
            var digits=new java.util.ArrayList<MultiDigit>();
            for(JsonNode item:data.path("digits")) {
                if(!item.path("digit").isIntegralNumber() || !item.path("confidence").isNumber()
                        || !item.path("margin").isNumber()) throw invalidResponse();
                int digit=item.path("digit").asInt(-1);
                double confidence=item.path("confidence").asDouble(Double.NaN);
                double margin=item.path("margin").asDouble(Double.NaN);
                if(digit<0 || digit>9 || !Double.isFinite(confidence) || confidence<0 || confidence>1) throw invalidResponse();
                digits.add(new MultiDigit(digit,confidence,Double.isFinite(margin)?margin:0,
                        item.path("left").asInt(0),item.path("right").asInt(0)));
            }
            return new MultiPrediction(text,java.util.List.copyOf(digits),data.path("accepted").asBoolean(),maxDigits);
        } catch(V2Exception error) { throw error; }
        catch(Exception error) {
            LOG.warn("Multi-digit prediction transport failed ({})",error.getClass().getSimpleName());
            throw new V2Exception(502,"模型调用失败或超时，请使用新的请求重试","MODEL_UNAVAILABLE");
        }
    }


    /** 返回增强后的图片（白底黑字 + 加粗），用于前端预览；不落库、不参与识别。 */
    public byte[] enhanceImage(ImageValidator.Image image) {
        requireConfigured();
        var body=new LinkedMultiValueMap<String,Object>();
        var headers=new HttpHeaders(); headers.setContentType(MediaType.parseMediaType(image.contentType()));
        body.add("image",new HttpEntity<>(new ByteArrayResource(image.bytes()) {
            @Override public String getFilename() { return "drawing"; }
        },headers));
        try {
            return client.post().uri("/internal/v2/enhance").header("X-HDR-Internal-Token",internalToken)
                    .contentType(MediaType.MULTIPART_FORM_DATA).body(body)
                    .exchange((request,response)->{
                        if(response.getStatusCode().value()!=200) throw invalidResponse();
                        return response.getBody().readNBytes((int)com.hdr.v2.platform.W2Limits.IMAGE_MAX_BYTES+1);
                    });
        } catch(V2Exception error) { throw error; }
        catch(Exception error) {
            LOG.warn("Enhance preview failed ({})",error.getClass().getSimpleName());
            throw new V2Exception(502,"预处理预览失败，请稍后重试","MODEL_UNAVAILABLE");
        }
    }

    private V2Exception unavailable() { return new V2Exception(502,"模型注册表暂时不可用，请稍后重试","MODEL_UNAVAILABLE"); }

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
                    || rejected.path("code").intValue()!=422 || !rejected.path("data").isObject()) throw invalidResponse();
            String category=rejected.path("data").path("category").asText();
            // UNRECOGNIZED_INPUT：单字拒识；DIGIT_LIMIT：多位数超过上限（只有多位数预览会返回）。
            if("DIGIT_LIMIT".equals(category))
                throw new V2Exception(422,rejected.path("message").asText("检测到超过位数上限，请减少一位后重试"),"DIGIT_LIMIT");
            if(!"UNRECOGNIZED_INPUT".equals(category)) throw invalidResponse();
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
