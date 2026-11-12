<script setup>
import { ref } from 'vue'
import * as api from '@/api/models.js'
import { useUserStore } from '@/stores/user.js'
import { createModelAdmin, summarize, canActivate, canDisable, canDelete } from '@/models/controller.js'
import { originOf, provenanceDetail } from '@/models/provenance.js'

const user = useUserStore()
const admin = createModelAdmin({ api, getSession: () => user.getSnapshot() })
const models = ref([])
const error = ref('')
const notice = ref('')
const loading = ref(false)
const busy = ref(false)

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    models.value = await admin.list()
  } catch (failure) {
    error.value = failure?.message || '模型列表加载失败'
  } finally {
    loading.value = false
  }
}

async function act(label, task) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await task()
    notice.value = label
    models.value = await admin.list()
  } catch (failure) {
    error.value = failure?.message || '操作失败'
  } finally {
    busy.value = false
  }
}

const activate = (id) => act('已切换生效模型；新的识别请求立即使用该模型。', () => admin.activate(id))
const disable = (id) => act('模型已停用。', () => admin.disable(id))
const remove = (id) => act('模型已删除。', () => admin.remove(id))
const reload = () => act('已让模型服务重新读取注册表。', () => admin.reloadRegistry())

refresh()
</script>

<template>
  <div class="stack wide-gap">
    <div class="section-heading">
      <p class="muted">同一时刻只有一个模型生效。切换只影响新的识别请求；历史记录保留当时的模型版本。</p>
      <div class="row-actions">
        <button :disabled="busy" @click="reload">重新读取注册表</button>
        <button :disabled="loading || busy" @click="refresh">刷新列表</button>
      </div>
    </div>
    <p v-if="loading" class="notice" role="status">正在加载模型列表…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <section v-if="models.length" class="panel">
      <h2>公共模型</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>模型</th><th>状态</th><th>文件</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="model in models" :key="model.id">
              <td>
                {{ model.externalId }}<small class="cell-detail">版本 {{ model.version }}</small>
                <span class="origin-badge" :class="'origin-' + originOf(model).tone">{{ originOf(model).label }}</span>
                <small class="cell-detail">{{ provenanceDetail(model) }}</small>
                <small class="cell-detail">预处理 {{ model.preprocessVersion }}</small>
                <small class="cell-detail">{{ summarize(model).registryLabel }}</small>
              </td>
              <td>{{ summarize(model).statusLabel }}<small class="cell-detail">ID {{ model.id }}</small></td>
              <td>
                {{ summarize(model).artifact }}
                <small class="cell-detail">{{ summarize(model).digest }} · {{ summarize(model).sizeLabel }}</small>
              </td>
              <td>
                <button v-if="canActivate(model)" :disabled="busy" @click="activate(model.id)">设为生效</button>
                <button v-if="canDisable(model)" :disabled="busy" @click="disable(model.id)">停用</button>
                <button v-if="canDelete(model)" :disabled="busy" @click="remove(model.id)">删除</button>
                <span v-if="!canActivate(model) && !canDisable(model) && !canDelete(model)" class="muted">不可操作</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-else-if="!loading && !error" class="panel"><p class="muted">没有可管理的公共模型。</p></section>
  </div>
</template>
