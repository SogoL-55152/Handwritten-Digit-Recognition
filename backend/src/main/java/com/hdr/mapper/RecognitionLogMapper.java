package com.hdr.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hdr.entity.RecognitionLog;
import org.apache.ibatis.annotations.Select;

import java.util.List;
import java.util.Map;

public interface RecognitionLogMapper extends BaseMapper<RecognitionLog> {

    @Select("""
            SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, COUNT(*) AS count
            FROM t_recognition_log
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
            ORDER BY date
            """)
    List<Map<String, Object>> countByDay();

    @Select("""
            SELECT COALESCE(m.name, '未知模型') AS name, COUNT(r.id) AS value
            FROM t_recognition_log r
            LEFT JOIN t_model m ON r.model_id = m.id
            GROUP BY m.name
            ORDER BY value DESC
            """)
    List<Map<String, Object>> countByModel();
}
