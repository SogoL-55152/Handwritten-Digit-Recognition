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
    /** 对比用：模型身份（注册表键由 modelId + version + preprocessVersion 三者共同决定）。 */
    public record CompareSide(String modelId,String version,String preprocessVersion) {}
    public record CompareRow(int index,int label,int digitA,double confidenceA,
                             int digitB,double confidenceB,boolean agree) {}
    public record CompareSummary(int samples,int labelled,int agreement,Double agreementRate,
                                 Double accuracyA,Double accuracyB,int bothRight,int onlyA,int onlyB,
                                 int bothWrong,Double meanConfidenceA,Double meanConfidenceB) {}
    public record CompareResult(CompareSide modelA,CompareSide modelB,CompareSummary summary,
                                List<CompareRow> rows,long processingMs) {}
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(ModelClient.class);
    private final RestClient client;
    /** 对比要一次跑很多张图，读超时单独放宽，避免沿用单张推理的 10s。 */
    private final RestClient compareClient;
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
        var compareFactory=new SimpleClientHttpRequestFactory();
        compareFactory.setConnectTimeout(2000); compareFactory.setReadTimeout(180000);
        this.compareClient=RestClient.builder().baseUrl(url).requestFactory(compareFactory).build();
    }
    public ModelClient(RestClient client,ObjectMapper mapper,String internalToken) {
        this.client=client; this.mapper=mapper; this.internalToken=internalToken;
        this.compareClient=client;
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

    /** 同一批图片分别喂给两个已注册模型；返回逐张预测、差异与汇总。 */
    public CompareResult compare(CompareSide a, CompareSide b, java.util.List<byte[]> images,
                                 java.util.List<Integer> labels) {
        requireConfigured();
        if (images.isEmpty() || images.size() != labels.size())
            throw new V2Exception(400, "对比图片与标签数量必须一致", "VALIDATION");
        var body = new LinkedMultiValueMap<String, Object>();
        body.add("modelAId", a.modelId()); body.add("modelAVersion", a.version());
        body.add("modelAPreprocess", a.preprocessVersion());
        body.add("modelBId", b.modelId()); body.add("modelBVersion", b.version());
        body.add("modelBPreprocess", b.preprocessVersion());
        body.add("labels", labels.stream().map(String::valueOf).collect(java.util.stream.Collectors.joining(",")));
        for (byte[] bytes : images) {
            var headers = new HttpHeaders();
            headers.setContentType(MediaType.IMAGE_PNG);
            body.add("image", new HttpEntity<>(new ByteArrayResource(bytes) {
                @Override public String getFilename() { return "sample.png"; }
            }, headers));
        }
        try {
            JsonNode data = compareClient.post().uri("/internal/v2/compare")
                    .header("X-HDR-Internal-Token", internalToken)
                    .contentType(MediaType.MULTIPART_FORM_DATA).body(body)
                    .exchange((request, response) -> read(response));
            return parseCompare(data, a, b, images.size());
        } catch (V2Exception error) {
            // 单张推理把"模型未注册"映射成 503（对线上识别有意义）；管理员点对比时更该知道是选错了模型
            if ("MODEL_UNAVAILABLE".equals(error.getCategory()))
                throw new V2Exception(400, "对比用模型在模型服务注册表中不可用（版本或预处理版本不匹配）",
                        "MODEL_NOT_ALLOWED");
            throw error;
        } catch (Exception error) {
            LOG.warn("Model compare transport failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(502, "模型对比调用失败或超时，请减少样本量后重试", "MODEL_UNAVAILABLE");
        }
    }

    private CompareResult parseCompare(JsonNode data, CompareSide a, CompareSide b, int expected) {
        JsonNode sideA = data.path("modelA");
        JsonNode sideB = data.path("modelB");
        if (!a.modelId().equals(sideA.path("modelId").asText())
                || !a.version().equals(sideA.path("modelVersion").asText())
                || !b.modelId().equals(sideB.path("modelId").asText())
                || !b.version().equals(sideB.path("modelVersion").asText()))
            throw new V2Exception(502, "模型对比返回的身份与请求不一致", "MODEL_RESPONSE_INVALID");
        JsonNode summary = data.path("summary");
        JsonNode rows = data.path("rows");
        if (!rows.isArray() || rows.size() != expected) throw invalidResponse();
        java.util.List<CompareRow> parsed = new ArrayList<>();
        for (JsonNode row : rows) {
            int label = row.path("label").asInt(-2);
            int digitA = row.path("digitA").asInt(-1);
            int digitB = row.path("digitB").asInt(-1);
            double confidenceA = row.path("confidenceA").asDouble(Double.NaN);
            double confidenceB = row.path("confidenceB").asDouble(Double.NaN);
            if (label < -1 || label > 9 || digitA < 0 || digitA > 9 || digitB < 0 || digitB > 9
                    || !Double.isFinite(confidenceA) || !Double.isFinite(confidenceB)
                    || confidenceA < 0 || confidenceA > 1 || confidenceB < 0 || confidenceB > 1)
                throw invalidResponse();
            parsed.add(new CompareRow(row.path("index").asInt(parsed.size()), label, digitA, confidenceA,
                    digitB, confidenceB, digitA == digitB));
        }
        CompareSummary parsedSummary = new CompareSummary(
                summary.path("samples").asInt(0), summary.path("labelled").asInt(0),
                summary.path("agreement").asInt(0),
                summary.hasNonNull("agreementRate") ? summary.path("agreementRate").asDouble() : null,
                summary.hasNonNull("accuracyA") ? summary.path("accuracyA").asDouble() : null,
                summary.hasNonNull("accuracyB") ? summary.path("accuracyB").asDouble() : null,
                summary.path("bothRight").asInt(0), summary.path("onlyA").asInt(0),
                summary.path("onlyB").asInt(0), summary.path("bothWrong").asInt(0),
                summary.hasNonNull("meanConfidenceA") ? summary.path("meanConfidenceA").asDouble() : null,
                summary.hasNonNull("meanConfidenceB") ? summary.path("meanConfidenceB").asDouble() : null);
        return new CompareResult(a, b, parsedSummary, java.util.List.copyOf(parsed),
                data.path("processingMs").asLong(0));
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
                    .contentType(MediaType.APPLICATION_JSON).body(body).exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 400) {
                            byte[] bytes = response.getBody().readNBytes(65537);
                            String message = "训练参数未通过模型服务校验";
                            try {
                                JsonNode root = mapper.readTree(bytes);
                                if (root != null && root.hasNonNull("message")) message = root.get("message").asText();
                            } catch (IOException ignored) {
                                // 保持通用文案
                            }
                            throw new V2Exception(400, message, "TRAINING_VALIDATION");
                        }
                        return read(response);
                    });
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
        return predictMulti(workspaceId, requestId, model, image, maxDigits, false);
    }

    /** enhance=true 只用于图片导入：先做照片增强再切分。 */
    public MultiPrediction predictMulti(long workspaceId, String requestId, CatalogueService.Model model,
                                        ImageValidator.Image image, int maxDigits, boolean enhance) {
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
            String uri="/internal/v2/predict/multi?maxDigits="+maxDigits+(enhance?"&enhance=1":"");
            JsonNode data=client.post().uri(uri).header("X-HDR-Internal-Token",internalToken)
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
        if(status==400) throw badRequest(bytes);
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
    /**
     * 400 有四种完全不同的原因，不能一律报成"图片不合法"，否则运维会照着错误提示去查图片：
     *   MODEL_NOT_ALLOWED → 数据库里的生效模型在模型服务注册表里不存在（版本或预处理版本不匹配），属于服务端配置问题；
     *   BLANK_IMAGE       → 用户没写东西；
     *   INVALID_REQUEST / VALIDATION → 请求字段与内部接口约定不一致（多半是版本不匹配）。
     * 未识别的 category 仍按"图片未通过校验"处理，保持历史行为。
     */
    private V2Exception badRequest(byte[] bytes) {
        JsonNode body=null;
        try { body=bytes.length==0?null:mapper.readTree(bytes); }
        catch(IOException ignored) { /* 非 JSON 响应按旧行为处理 */ }
        String category="";
        String message="";
        if(body!=null && body.isObject()) {
            message=body.path("message").asText("");
            if(body.path("data").isObject()) category=body.path("data").path("category").asText("");
        }
        switch(category) {
            case "MODEL_NOT_ALLOWED":
                return new V2Exception(503,
                        "当前生效的模型在模型服务注册表中不存在（版本或预处理版本不匹配），请在模型管理中注册并激活已发布的模型",
                        "MODEL_UNAVAILABLE");
            case "BLANK_IMAGE":
                return new V2Exception(400,message.isBlank()?"请先书写数字，不能识别空白图片":message,"BLANK_IMAGE");
            case "INVALID_REQUEST":
            case "VALIDATION":
                return new V2Exception(400,"请求字段与模型服务内部接口约定不一致","INVALID_REQUEST");
            default:
                return new V2Exception(400,"图片未通过模型服务校验","INVALID_IMAGE");
        }
    }

    private void requireConfigured() {
        if(internalToken.isBlank()) throw new V2Exception(503,"模型内部凭据尚未配置","MODEL_UNAVAILABLE");
    }
    private V2Exception invalidResponse() { return new V2Exception(502,"模型返回的数据不符合接口约定","MODEL_RESPONSE_INVALID"); }
}
