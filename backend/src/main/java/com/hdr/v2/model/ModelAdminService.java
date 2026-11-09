package com.hdr.v2.model;

import com.hdr.v2.V2Exception;
import com.hdr.v2.recognition.ModelClient;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 模型管理：数据库是"哪个模型生效"的唯一权威，模型服务的 registry.json 是
 * "哪些文件可信"的唯一权威。注册与激活都必须两边一致，任何一边缺信息都拒绝。
 */
@Service
public class ModelAdminService {
    public record ModelView(String id,String externalId,String version,String preprocessVersion,String status,
                            Double accuracy,String accuracyDataset,String sha256,Long sizeBytes,String artifact,
                            boolean inRegistry,boolean verified,String registryReason) {}
    public record RegisterCommand(String externalId,String version) {}
    private final JdbcTemplate jdbc;
    private final ModelClient client;
    public ModelAdminService(JdbcTemplate jdbc,ModelClient client) { this.jdbc=jdbc; this.client=client; }

    public List<ModelView> list() {
        List<ModelRow> rows=jdbc.query("SELECT * FROM t_v2_model WHERE scope='PUBLIC' ORDER BY id",ModelAdminService::row);
        Map<String,ModelClient.RegisteredModel> registry=new HashMap<>();
        for(ModelClient.RegisteredModel entry:client.registry()) registry.put(key(entry.modelId(),entry.modelVersion()),entry);
        List<ModelView> views=new ArrayList<>();
        for(ModelRow row:rows) {
            ModelClient.RegisteredModel entry=registry.get(key(row.externalId(),row.version()));
            views.add(new ModelView(row.id(),row.externalId(),row.version(),row.preprocessVersion(),row.status(),
                    row.accuracy(),row.accuracyDataset(),row.sha256(),row.sizeBytes(),row.artifact(),
                    entry!=null,entry!=null&&entry.verified(),entry==null?"NOT_IN_REGISTRY":(entry.verified()?"":entry.reason())));
        }
        return views;
    }

    @Transactional
    public ModelView register(RegisterCommand command) {
        String externalId=token(command==null?null:command.externalId(),"externalId");
        String version=token(command.version(),"version");
        Long existing=jdbc.query("SELECT COUNT(*) FROM t_v2_model WHERE scope='PUBLIC' AND external_id=? AND version=?",
                (rs,i)->rs.getLong(1),externalId,version).get(0);
        if(existing!=null && existing>0) throw new V2Exception(409,"该模型版本已注册","MODEL_EXISTS");
        // 先让模型服务重载本地注册表，再要求文件已通过摘要校验。
        List<ModelClient.RegisteredModel> registry=client.reloadRegistry();
        ModelClient.RegisteredModel entry=registry.stream()
                .filter(item->externalId.equals(item.modelId())&&version.equals(item.modelVersion()))
                .findFirst().orElseThrow(()->new V2Exception(400,"模型服务注册表中没有该模型文件","MODEL_NOT_REGISTERED"));
        if(!entry.verified()) throw new V2Exception(409,"模型文件未通过摘要校验，不能注册","MODEL_UNVERIFIED");
        jdbc.update("""
                INSERT INTO t_v2_model(name,version,scope,external_id,accuracy,accuracy_dataset,preprocess_version,
                    description,status,sha256,size_bytes,artifact)
                VALUES(?,?,'PUBLIC',?,NULL,NULL,?,?,'INACTIVE',?,?,?)
                """,externalId+" "+version,version,externalId,entry.preprocessVersion(),
                "Registered from model-service registry; not active until an admin activates it",
                entry.sha256(),entry.sizeBytes(),entry.artifact());
        Long id=jdbc.queryForObject("SELECT id FROM t_v2_model WHERE scope='PUBLIC' AND external_id=? AND version=?",
                Long.class,externalId,version);
        return view(id);
    }

    @Transactional
    public ModelView activate(long id) {
        ModelRow target=requireRow(id);
        if("DISABLED".equals(target.status())) throw new V2Exception(409,"已停用的模型需要先重新启用","MODEL_DISABLED");
        List<ModelClient.RegisteredModel> registry=client.reloadRegistry();
        ModelClient.RegisteredModel entry=registry.stream()
                .filter(item->target.externalId().equals(item.modelId())&&target.version().equals(item.modelVersion()))
                .findFirst().orElseThrow(()->new V2Exception(409,"模型文件不在服务端注册表中","MODEL_NOT_REGISTERED"));
        if(!entry.verified()) throw new V2Exception(409,"模型文件未通过摘要校验","MODEL_UNVERIFIED");
        if(!entry.sha256().equals(target.sha256())) throw new V2Exception(409,"数据库与模型文件的摘要不一致","MODEL_DIGEST_MISMATCH");
        // 串行化激活：只有一个提交能成功留下 ACTIVE。
        jdbc.query("SELECT id FROM t_v2_model WHERE scope='PUBLIC' FOR UPDATE",(rs,i)->rs.getLong(1));
        jdbc.update("UPDATE t_v2_model SET status='INACTIVE' WHERE scope='PUBLIC' AND status='ACTIVE' AND id<>?",id);
        jdbc.update("UPDATE t_v2_model SET status='ACTIVE' WHERE id=?",id);
        return view(id);
    }

    @Transactional
    public ModelView disable(long id) {
        ModelRow row=requireRow(id);
        if("ACTIVE".equals(row.status())) throw new V2Exception(409,"不能停用当前活跃模型；请先激活其他模型","MODEL_ACTIVE");
        jdbc.update("UPDATE t_v2_model SET status='DISABLED' WHERE id=?",id);
        return view(id);
    }

    @Transactional
    public void delete(long id) {
        ModelRow row=requireRow(id);
        if("ACTIVE".equals(row.status())) throw new V2Exception(409,"不能删除当前活跃模型","MODEL_ACTIVE");
        Long used=jdbc.queryForObject("SELECT COUNT(*) FROM t_recognition_v2 WHERE model_id=?",Long.class,Long.parseLong(row.id()));
        if(used!=null && used>0) throw new V2Exception(409,"该模型已有识别记录，只能停用不能删除","MODEL_IN_USE");
        jdbc.update("DELETE FROM t_v2_model WHERE id=?",id);
    }

    private ModelView view(long id) {
        return list().stream().filter(item->item.id().equals(Long.toString(id))).findFirst()
                .orElseThrow(()->new V2Exception(404,"模型不存在"));
    }
    private ModelRow requireRow(long id) {
        return jdbc.query("SELECT * FROM t_v2_model WHERE id=? AND scope='PUBLIC'",ModelAdminService::row,id)
                .stream().findFirst().orElseThrow(()->new V2Exception(404,"模型不存在"));
    }
    private static String token(String value,String field) {
        if(value==null || value.isBlank() || value.length()>64 || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]*"))
            throw new V2Exception(400,"字段 "+field+" 格式无效","VALIDATION");
        return value;
    }
    private static String key(String modelId,String version) { return modelId+"\u0000"+version; }
    private record ModelRow(String id,String externalId,String version,String preprocessVersion,String status,
                            Double accuracy,String accuracyDataset,String sha256,Long sizeBytes,String artifact) {}
    private static ModelRow row(ResultSet rs,int index) throws SQLException {
        Object size=rs.getObject("size_bytes");
        return new ModelRow(rs.getString("id"),rs.getString("external_id"),rs.getString("version"),
                rs.getString("preprocess_version"),rs.getString("status"),(Double)rs.getObject("accuracy"),
                rs.getString("accuracy_dataset"),rs.getString("sha256"),size==null?null:((Number)size).longValue(),
                rs.getString("artifact"));
    }
}
