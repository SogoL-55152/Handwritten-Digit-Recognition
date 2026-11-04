<script setup>
import { getResource } from '@/api/workspaces.js'
import { useWorkspaceResource } from '@/workspace/use-resource.js'
const resource = useWorkspaceResource(async (snapshot) => {
  const [models, datasets, defaultModel] = await Promise.all(['models', 'datasets', 'default-model'].map((path) => getResource(snapshot, path)))
  if (!Array.isArray(models) || !Array.isArray(datasets) || !defaultModel?.id) throw new Error('资产接口返回了无效信息')
  return { models, datasets, defaultModel }
})
const state = resource.state
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '未提供' }
</script>

<template>
  <div class="stack wide-gap">
    <div class="section-heading"><p class="muted">公共资产与当前空间默认引用只读展示。元数据存在不代表推理服务已就绪。</p><button :disabled="state.loading" @click="resource.load()">刷新资产</button></div>
    <p v-if="state.loading" class="notice" role="status">正在加载当前空间的资产…</p>
    <p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
    <template v-if="state.data">
      <section class="panel"><p class="eyebrow">当前空间的默认引用</p><h2>{{ state.data.defaultModel.name }}</h2><dl class="details"><dt>模型标识</dt><dd>{{ state.data.defaultModel.externalId }}</dd><dt>版本</dt><dd>{{ state.data.defaultModel.version }}</dd><dt>预处理</dt><dd>{{ state.data.defaultModel.preprocessVersion }}</dd><dt>评测来源</dt><dd>{{ state.data.defaultModel.accuracyDataset || '未提供' }}</dd><dt>离线评测准确率</dt><dd>{{ percent(state.data.defaultModel.accuracy) }}（不是线上准确率）</dd></dl><p>{{ state.data.defaultModel.description }}</p><p class="muted">默认模型由服务器解析；W2 不提供切换、上传或删除操作。</p></section>
      <section class="panel"><h2>模型列表</h2><div class="table-wrap"><table><thead><tr><th>模型</th><th>版本 / 预处理</th><th>范围</th><th>离线评测</th></tr></thead><tbody><tr v-for="model in state.data.models" :key="model.id"><td>{{ model.name }}<small class="cell-detail">{{ model.externalId }} · ID {{ model.id }}</small><details><summary>查看模型详情</summary><p>{{ model.description }}</p></details></td><td>{{ model.version }}<small class="cell-detail">{{ model.preprocessVersion }}</small></td><td>{{ model.scope }}</td><td>{{ percent(model.accuracy) }}<small class="cell-detail">{{ model.accuracyDataset || '评测来源未提供' }}</small></td></tr><tr v-if="!state.data.models.length"><td colspan="4">没有可访问的模型</td></tr></tbody></table></div></section>
      <section class="panel"><h2>数据集列表</h2><div class="table-wrap"><table><thead><tr><th>数据集</th><th>版本 / 范围</th><th>训练样本</th><th>测试样本</th></tr></thead><tbody><tr v-for="dataset in state.data.datasets" :key="dataset.id"><td>{{ dataset.name }}<small class="cell-detail">{{ dataset.description }}</small></td><td>{{ dataset.version }}<small class="cell-detail">{{ dataset.scope }}</small></td><td>{{ dataset.trainSamples ?? '未提供' }}</td><td>{{ dataset.testSamples ?? '未提供' }}</td></tr><tr v-if="!state.data.datasets.length"><td colspan="4">没有可访问的数据集</td></tr></tbody></table></div><p class="muted">仅元数据展示，不提供数据文件下载或训练提交。</p></section>
    </template>
  </div>
</template>
