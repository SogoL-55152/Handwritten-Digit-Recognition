package com.hdr.v2.recognition;

import com.hdr.v2.V2Exception;
import com.hdr.v2.assets.CatalogueService;
import com.hdr.v2.platform.RateLimiter;
import com.hdr.v2.platform.W2Limits;
import com.hdr.v2.workspace.WorkspaceService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import java.sql.Statement;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Semaphore;

@Service
public class RecognitionService {
    public record Recognition(String recognitionId,String requestId,int digit,double confidence,String modelId,
            String modelVersion,String preprocessVersion,String source,long processingMs,String createdAt) {}
    /** 多位数的对外结果：整串 + 逐位 + 是否可接受。 */
    public record MultiResult(String recognitionId,String requestId,String text,boolean accepted,
            List<ModelClient.MultiDigit> digits,String modelId,String modelVersion,String preprocessVersion,
            String source,long processingMs,String createdAt) {}
    private record Existing(long id,String digest,String source,String status) {}
    private final JdbcTemplate jdbc;
    private final CatalogueService catalogue;
    private final WorkspaceService spaces;
    private final ModelClient model;
    private final RateLimiter limiter;
    private final W2Limits limits;
    private final Semaphore permits=new Semaphore(2);
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;
    private final RecognitionImageStore imageStore;

    public RecognitionService(JdbcTemplate jdbc,CatalogueService catalogue,WorkspaceService spaces,
                              ModelClient model,RateLimiter limiter,W2Limits limits,
                              com.fasterxml.jackson.databind.ObjectMapper mapper,RecognitionImageStore imageStore) {
        this.jdbc=jdbc; this.catalogue=catalogue; this.spaces=spaces; this.model=model; this.limiter=limiter;
        this.limits=limits; this.mapper=mapper; this.imageStore=imageStore;
    }
    public Recognition predict(long wid,long uid,String requestId,String source,ImageValidator.Image image) {
        return predict(wid,uid,requestId,source,image,false);
    }

    /** enhance=true 只用于图片导入路径：先做照片增强再识别。 */
    public Recognition predict(long wid,long uid,String requestId,String source,ImageValidator.Image image,
                               boolean enhance) {
        validateRequest(requestId,source);
        spaces.requireMember(wid,uid);
        List<Existing> previous=existing(wid,uid,requestId);
        if(!previous.isEmpty()) return repeat(wid,uid,previous.get(0),source,image.digest());
        limiter.check("recognition:global",240,60);
        limiter.check("recognition:user:"+uid,limits.recognitionPerMinute(),60);
        limiter.check("recognition:space:"+wid,limits.recognitionPerMinute(),60);
        if(!permits.tryAcquire()) throw new V2Exception(429,"推理服务正忙，请稍后重试","CONCURRENCY_LIMIT",2);
        long started=System.nanoTime();
        long id=0;
        try {
            CatalogueService.Model selected=catalogue.defaultModel(wid);
            String stored=imageStore.save(wid,image);
            GeneratedKeyHolder keys=new GeneratedKeyHolder();
            try {
                jdbc.update(connection->{
                    var statement=connection.prepareStatement("INSERT INTO t_recognition_v2(workspace_id,creator_id,request_id,image_digest,image_path,image_type,source,model_id,model_version,preprocess_version) VALUES(?,?,?,?,?,?,?,?,?,?)",Statement.RETURN_GENERATED_KEYS);
                    statement.setLong(1,wid); statement.setLong(2,uid); statement.setString(3,requestId);
                    statement.setString(4,image.digest()); statement.setString(5,stored);
                    statement.setString(6,image.contentType()); statement.setString(7,source);
                    statement.setLong(8,Long.parseLong(selected.id()));
                    statement.setString(9,selected.version()); statement.setString(10,selected.preprocessVersion()); return statement;
                },keys);
            } catch(DuplicateKeyException conflict) {
                return repeat(wid,uid,existing(wid,uid,requestId).get(0),source,image.digest());
            }
            id=keys.getKey().longValue();
            // Autocommit above: never hold a database transaction during a model request.
            ModelClient.Prediction prediction=model.predict(wid,requestId,selected,image,enhance);
            long elapsed=(System.nanoTime()-started)/1_000_000L;
            int saved=jdbc.update("UPDATE t_recognition_v2 SET status='SUCCEEDED',digit=?,confidence=?,processing_ms=? WHERE id=? AND status='PROCESSING'",prediction.digit(),prediction.confidence(),elapsed,id);
            if(saved!=1) throw new V2Exception(409,"请求状态已失效，结果未确认","REQUEST_FAILED");
            return get(wid,uid,id);
        } catch(RuntimeException error) {
            if(id!=0) {
                // 记下失败原因（拒识 vs 服务失败），否则统计只能混成一个 FAILED。
                String code = error instanceof V2Exception v2 ? v2.getCategory() : null;
                String failureCode = code == null ? null : code.substring(0, Math.min(32, code.length()));
                try { jdbc.update("UPDATE t_recognition_v2 SET status='FAILED', failure_code=? WHERE id=? AND status='PROCESSING'",failureCode,id); }
                catch(RuntimeException ignored) { /* Remains unknown; never automatically replay the model request. */ }
            }
            throw error;
        } finally { permits.release(); }
    }
    /** 多位数：切分 + 逐字识别后落库；同一 requestId 重复提交返回已存结果。 */
    public MultiResult predictMulti(long wid,long uid,String requestId,String source,int maxDigits,
                                    ImageValidator.Image image) {
        validateRequest(requestId,source);
        if(maxDigits<1 || maxDigits>4) throw new V2Exception(400,"maxDigits 必须是 1–4","VALIDATION");
        spaces.requireMember(wid,uid);
        List<Existing> previous=existing(wid,uid,requestId);
        if(!previous.isEmpty()) return repeatMulti(wid,uid,previous.get(0),source,image.digest());
        limiter.check("recognition:global",240,60);
        limiter.check("recognition:user:"+uid,limits.recognitionPerMinute(),60);
        limiter.check("recognition:space:"+wid,limits.recognitionPerMinute(),60);
        if(!permits.tryAcquire()) throw new V2Exception(429,"推理服务正忙，请稍后重试","CONCURRENCY_LIMIT",2);
        long started=System.nanoTime();
        long id=0;
        try {
            CatalogueService.Model selected=catalogue.defaultModel(wid);
            String stored=imageStore.save(wid,image);
            GeneratedKeyHolder keys=new GeneratedKeyHolder();
            try {
                jdbc.update(connection->{
                    var statement=connection.prepareStatement("INSERT INTO t_recognition_v2(workspace_id,creator_id,request_id,image_digest,image_path,image_type,source,model_id,model_version,preprocess_version) VALUES(?,?,?,?,?,?,?,?,?,?)",Statement.RETURN_GENERATED_KEYS);
                    statement.setLong(1,wid); statement.setLong(2,uid); statement.setString(3,requestId);
                    statement.setString(4,image.digest()); statement.setString(5,stored);
                    statement.setString(6,image.contentType()); statement.setString(7,source);
                    statement.setLong(8,Long.parseLong(selected.id()));
                    statement.setString(9,selected.version()); statement.setString(10,selected.preprocessVersion()); return statement;
                },keys);
            } catch(DuplicateKeyException conflict) {
                return repeatMulti(wid,uid,existing(wid,uid,requestId).get(0),source,image.digest());
            }
            id=keys.getKey().longValue();
            ModelClient.MultiPrediction prediction=model.predictMulti(wid,requestId,selected,image,maxDigits);
            long elapsed=(System.nanoTime()-started)/1_000_000L;
            int saved=jdbc.update("""
                    UPDATE t_recognition_v2 SET status='SUCCEEDED',result_text=?,digits_json=?,accepted=?,
                        processing_ms=? WHERE id=? AND status='PROCESSING'
                    """,prediction.text(),digitsJson(prediction),prediction.accepted()?1:0,elapsed,id);
            if(saved!=1) throw new V2Exception(409,"请求状态已失效，结果未确认","REQUEST_FAILED");
            return getMulti(wid,uid,id);
        } catch(RuntimeException error) {
            if(id!=0) {
                String code=error instanceof V2Exception v2 ? v2.getCategory() : null;
                String failureCode=code==null?null:code.substring(0,Math.min(32,code.length()));
                try { jdbc.update("UPDATE t_recognition_v2 SET status='FAILED', failure_code=? WHERE id=? AND status='PROCESSING'",failureCode,id); }
                catch(RuntimeException ignored) { /* 保持未知，不自动重放请求 */ }
            }
            throw error;
        } finally { permits.release(); }
    }

    public MultiResult getMulti(long wid,long uid,long id) {
        spaces.requireMember(wid,uid);
        List<MultiResult> rows=jdbc.query("""
                SELECT * FROM t_recognition_v2 WHERE id=? AND workspace_id=? AND creator_id=? AND status='SUCCEEDED'
                """,(rs,i)->new MultiResult(
                rs.getString("id"),rs.getString("request_id"),rs.getString("result_text"),
                rs.getInt("accepted")==1,parseDigits(rs.getString("digits_json")),rs.getString("model_id"),
                rs.getString("model_version"),rs.getString("preprocess_version"),rs.getString("source"),
                rs.getLong("processing_ms"),rs.getTimestamp("created_at").toInstant().toString()),id,wid,uid);
        if(rows.isEmpty()) throw new V2Exception(404,"识别记录不存在");
        return rows.get(0);
    }

    private MultiResult repeatMulti(long wid,long uid,Existing prior,String source,String digest) {
        if(!prior.digest().equals(digest) || !prior.source().equals(source))
            throw new V2Exception(409,"相同请求标识不能用于不同图片或来源","IDEMPOTENCY_CONFLICT");
        if(prior.status().equals("SUCCEEDED")) return getMulti(wid,uid,prior.id());
        if(prior.status().equals("PROCESSING")) {
            int expired=jdbc.update("UPDATE t_recognition_v2 SET status='FAILED' WHERE id=? AND status='PROCESSING' AND created_at < ?",prior.id(),java.sql.Timestamp.from(Instant.now().minusSeconds(30)));
            if(expired==0) throw new V2Exception(409,"请求正在处理中，请稍后查询","IN_PROGRESS");
        }
        throw new V2Exception(409,"原请求未成功或结果未知；不会自动重复推理，请发起新的操作","REQUEST_FAILED");
    }

    private String digitsJson(ModelClient.MultiPrediction prediction) {
        var array=mapper.createArrayNode();
        for(ModelClient.MultiDigit item:prediction.digits()) {
            var node=mapper.createObjectNode();
            node.put("digit",item.digit()); node.put("confidence",item.confidence());
            node.put("margin",item.margin()); node.put("left",item.left()); node.put("right",item.right());
            array.add(node);
        }
        return array.toString();
    }

    private List<ModelClient.MultiDigit> parseDigits(String json) {
        if(json==null || json.isBlank()) return List.of();
        try {
            var list=new java.util.ArrayList<ModelClient.MultiDigit>();
            for(var node:mapper.readTree(json))
                list.add(new ModelClient.MultiDigit(node.path("digit").asInt(),node.path("confidence").asDouble(),
                        node.path("margin").asDouble(),node.path("left").asInt(),node.path("right").asInt()));
            return List.copyOf(list);
        } catch(Exception ignored) { return List.of(); }
    }

    /** 预处理预览：只做增强，不写库、不计数。 */
    public byte[] enhanceImage(ImageValidator.Image image) { return model.enhanceImage(image); }

    public Recognition get(long wid,long uid,long id) {
        spaces.requireMember(wid,uid);
        List<Recognition> rows=jdbc.query("SELECT * FROM t_recognition_v2 WHERE id=? AND workspace_id=? AND creator_id=? AND status='SUCCEEDED'",(rs,i)->new Recognition(
                rs.getString("id"),rs.getString("request_id"),rs.getInt("digit"),rs.getDouble("confidence"),rs.getString("model_id"),
                rs.getString("model_version"),rs.getString("preprocess_version"),rs.getString("source"),rs.getLong("processing_ms"),rs.getTimestamp("created_at").toInstant().toString()),id,wid,uid);
        if(rows.isEmpty()) throw new V2Exception(404,"识别记录不存在");
        return rows.get(0);
    }
    /** 单条记录详情：单字与多位数共用；只允许本人查看。 */
    public record Detail(String recognitionId,String requestId,String status,Integer digit,String resultText,
            Boolean accepted,Double confidence,Long processingMs,String modelId,String modelVersion,
            String preprocessVersion,String source,String failureCode,String createdAt,boolean hasImage) {}

    public Detail detail(long wid,long uid,long id) {
        spaces.requireMember(wid,uid);
        java.util.List<Detail> rows=jdbc.query("""
                SELECT * FROM t_recognition_v2 WHERE id=? AND workspace_id=? AND creator_id=?
                """,(rs,i)->new Detail(rs.getString("id"),rs.getString("request_id"),rs.getString("status"),
                rs.getObject("digit")==null?null:rs.getInt("digit"),rs.getString("result_text"),
                rs.getInt("accepted")==1,rs.getObject("confidence")==null?null:rs.getDouble("confidence"),
                rs.getObject("processing_ms")==null?null:rs.getLong("processing_ms"),rs.getString("model_id"),
                rs.getString("model_version"),rs.getString("preprocess_version"),rs.getString("source"),
                rs.getString("failure_code"),rs.getTimestamp("created_at").toInstant().toString(),
                rs.getString("image_path")!=null),id,wid,uid);
        if(rows.isEmpty()) throw new V2Exception(404,"识别记录不存在");
        return rows.get(0);
    }

    /** 读取该记录的原图；旧记录没有图时返回 404。 */
    public record StoredImage(byte[] bytes,String contentType) {}

    public StoredImage image(long wid,long uid,long id) {
        spaces.requireMember(wid,uid);
        java.util.List<String> paths=jdbc.query("SELECT image_path FROM t_recognition_v2 WHERE id=? AND workspace_id=? AND creator_id=?",
                (rs,i)->rs.getString(1),id,wid,uid);
        if(paths.isEmpty()) throw new V2Exception(404,"识别记录不存在");
        String path=paths.get(0);
        byte[] bytes=imageStore.read(path);
        return new StoredImage(bytes,imageStore.contentTypeOf(path).orElse("application/octet-stream"));
    }

    private List<Existing> existing(long wid,long uid,String requestId) {
        return jdbc.query("SELECT id,image_digest,source,status FROM t_recognition_v2 WHERE workspace_id=? AND creator_id=? AND request_id=?",(rs,i)->new Existing(rs.getLong(1),rs.getString(2),rs.getString(3),rs.getString(4)),wid,uid,requestId);
    }
    private Recognition repeat(long wid,long uid,Existing prior,String source,String digest) {
        if(!prior.digest().equals(digest) || !prior.source().equals(source)) throw new V2Exception(409,"相同请求标识不能用于不同图片或来源","IDEMPOTENCY_CONFLICT");
        if(prior.status().equals("SUCCEEDED")) return get(wid,uid,prior.id());
        if(prior.status().equals("PROCESSING")) {
            int expired=jdbc.update("UPDATE t_recognition_v2 SET status='FAILED' WHERE id=? AND status='PROCESSING' AND created_at < ?",prior.id(),java.sql.Timestamp.from(Instant.now().minusSeconds(30)));
            if(expired==0) throw new V2Exception(409,"请求正在处理中，请稍后查询","IN_PROGRESS");
        }
        throw new V2Exception(409,"原请求未成功或结果未知；不会自动重复推理，请发起新的操作","REQUEST_FAILED");
    }
    public static void validateRequest(String id,String source) {
        try { if(!UUID.fromString(id).toString().equalsIgnoreCase(id)) throw new IllegalArgumentException(); }
        catch(Exception error) { throw new V2Exception(400,"Idempotency-Key必须为UUID","VALIDATION"); }
        if(!"WEB".equals(source) && !"MINIPROGRAM".equals(source)) throw new V2Exception(400,"识别来源不支持","VALIDATION");
    }
}
