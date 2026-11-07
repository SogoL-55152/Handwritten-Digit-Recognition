package com.hdr.v2.assets;

import com.hdr.v2.V2Exception;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;

@Service
public class CatalogueService {
    public record Model(String id,String name,String version,String scope,String workspaceId,String externalId,
                        Double accuracy,String accuracyDataset,String preprocessVersion,String description,
                        String status,String sha256,Long sizeBytes,String artifact) {}
    public record Dataset(String id,String name,String version,String scope,String workspaceId,
                          int trainSamples,int testSamples,String description) {}
    private static final String VISIBLE="status='ACTIVE' AND (scope='PUBLIC' OR (scope='WORKSPACE' AND workspace_id=?))";
    private final JdbcTemplate jdbc;
    public CatalogueService(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public List<Model> models(long wid) {
        return jdbc.query("SELECT * FROM t_v2_model WHERE "+VISIBLE+" ORDER BY id",CatalogueService::model,wid);
    }
    public Model model(long wid,long id) {
        return jdbc.query("SELECT * FROM t_v2_model WHERE id=? AND "+VISIBLE,CatalogueService::model,id,wid)
                .stream().findFirst().orElseThrow(()->new V2Exception(404,"模型不存在"));
    }
    /** 当前唯一活跃的公共模型；识别与新建空间都以它为准。 */
    public Model activeModel() {
        return jdbc.query("SELECT * FROM t_v2_model WHERE scope='PUBLIC' AND status='ACTIVE'",CatalogueService::model)
                .stream().findFirst().orElseThrow(()->new V2Exception(503,"没有活跃的公共模型","MODEL_UNAVAILABLE"));
    }
    public String activeModelId() { return activeModel().id(); }
    public Model defaultModel(long wid) {
        // W3：同一时刻只有一个活跃模型，工作空间默认模型不再是生效开关。
        return activeModel();
    }
    public List<Dataset> datasets(long wid) {
        return jdbc.query("SELECT * FROM t_v2_dataset WHERE "+VISIBLE+" ORDER BY id",CatalogueService::dataset,wid);
    }
    public Dataset dataset(long wid,long id) {
        return jdbc.query("SELECT * FROM t_v2_dataset WHERE id=? AND "+VISIBLE,CatalogueService::dataset,id,wid)
                .stream().findFirst().orElseThrow(()->new V2Exception(404,"数据集不存在"));
    }
    private static Model model(ResultSet rs,int row) throws SQLException {
        Long size=rs.getObject("size_bytes")==null?null:rs.getLong("size_bytes");
        return new Model(rs.getString("id"),rs.getString("name"),rs.getString("version"),rs.getString("scope"),
                rs.getString("workspace_id"),rs.getString("external_id"),(Double)rs.getObject("accuracy"),
                rs.getString("accuracy_dataset"),rs.getString("preprocess_version"),rs.getString("description"),
                rs.getString("status"),rs.getString("sha256"),size,rs.getString("artifact"));
    }
    private static Dataset dataset(ResultSet rs,int row) throws SQLException {
        return new Dataset(rs.getString("id"),rs.getString("name"),rs.getString("version"),rs.getString("scope"),
                rs.getString("workspace_id"),rs.getInt("train_samples"),rs.getInt("test_samples"),rs.getString("description"));
    }
}
