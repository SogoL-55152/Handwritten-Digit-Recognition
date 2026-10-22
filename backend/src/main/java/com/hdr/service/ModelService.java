package com.hdr.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hdr.client.ModelServiceClient;
import com.hdr.common.BusinessException;
import com.hdr.common.PageResult;
import com.hdr.entity.ModelInfo;
import com.hdr.mapper.ModelInfoMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class ModelService {

    private final ModelInfoMapper modelMapper;
    private final ModelServiceClient modelServiceClient;

    public PageResult<ModelInfo> page(long page, long size) {
        Page<ModelInfo> result = modelMapper.selectPage(new Page<>(page, size),
                Wrappers.<ModelInfo>lambdaQuery().orderByDesc(ModelInfo::getId));
        return PageResult.of(result.getRecords(), result.getTotal(), page, size);
    }

    public List<ModelInfo> listAll() {
        return modelMapper.selectList(Wrappers.<ModelInfo>lambdaQuery().orderByDesc(ModelInfo::getId));
    }

    public ModelInfo activeOrNull() {
        return modelMapper.selectOne(Wrappers.<ModelInfo>lambdaQuery()
                .eq(ModelInfo::getActive, 1)
                .last("LIMIT 1"));
    }

    /**
     * 切换活跃模型：先同步模型服务，再在事务内更新本地状态。
     */
    @Transactional
    public ModelInfo activate(Long id) {
        ModelInfo model = require(id);
        if (Integer.valueOf(1).equals(model.getActive())) {
            return model;
        }
        if (StringUtils.hasText(model.getExternalId())) {
            modelServiceClient.activateModel(model.getExternalId());
        }
        modelMapper.update(null, Wrappers.<ModelInfo>lambdaUpdate()
                .eq(ModelInfo::getActive, 1)
                .set(ModelInfo::getActive, 0));
        model.setActive(1);
        modelMapper.updateById(model);
        log.info("Activated model {} ({})", model.getName(), model.getId());
        return model;
    }

    public void delete(Long id) {
        ModelInfo model = require(id);
        if (Integer.valueOf(1).equals(model.getActive())) {
            throw new BusinessException(400, "活跃模型不可删除，请先切换其他模型");
        }
        modelMapper.deleteById(id);
    }

    public ModelInfo createFromTraining(String name, String externalId, String filePath, Double accuracy) {
        ModelInfo model = new ModelInfo();
        model.setName(name);
        model.setExternalId(externalId);
        model.setFilePath(filePath);
        model.setAccuracy(accuracy);
        model.setActive(0);
        model.setVersion(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")));
        model.setDescription("训练任务自动登记");
        modelMapper.insert(model);
        return model;
    }

    public ModelInfo require(Long id) {
        ModelInfo model = modelMapper.selectById(id);
        if (model == null) {
            throw new BusinessException(404, "模型不存在");
        }
        return model;
    }
}
