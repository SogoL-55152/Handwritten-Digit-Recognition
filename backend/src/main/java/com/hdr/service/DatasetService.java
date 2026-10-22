package com.hdr.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hdr.common.PageResult;
import com.hdr.dto.DatasetRequest;
import com.hdr.entity.Dataset;
import com.hdr.mapper.DatasetMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
public class DatasetService {

    private final DatasetMapper datasetMapper;

    public PageResult<Dataset> page(long page, long size) {
        Page<Dataset> result = datasetMapper.selectPage(new Page<>(page, size),
                Wrappers.<Dataset>lambdaQuery().orderByDesc(Dataset::getId));
        return PageResult.of(result.getRecords(), result.getTotal(), page, size);
    }

    public Dataset create(DatasetRequest request) {
        Dataset dataset = new Dataset();
        dataset.setName(request.name());
        dataset.setType(StringUtils.hasText(request.type()) ? request.type() : "MNIST");
        dataset.setSampleCount(request.sampleCount() == null ? 0 : request.sampleCount());
        dataset.setStoragePath(request.storagePath());
        dataset.setDescription(request.description());
        datasetMapper.insert(dataset);
        return dataset;
    }
}
