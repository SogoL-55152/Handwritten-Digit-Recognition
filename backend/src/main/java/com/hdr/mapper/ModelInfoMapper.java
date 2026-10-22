package com.hdr.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hdr.entity.ModelInfo;
import org.apache.ibatis.annotations.Select;

public interface ModelInfoMapper extends BaseMapper<ModelInfo> {

    @Select("SELECT COALESCE(AVG(accuracy), 0) FROM t_model WHERE deleted = 0 AND accuracy IS NOT NULL")
    Double averageAccuracy();
}
