<script setup>
import { computed, ref } from 'vue'
import * as api from '@/api/models.js'
import { allVersions } from '@/api/datasets.js'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import {
  disagreementRows, domainRows, formatPercent, metaRows, summaryLine, verdict
} from '@/models/compare.js'

const props = defineProps({ models: { type: Array, default: () => [] } })
const emit = defineEmits(['close'])

const user = useUserStore()
const workspace = useWorkspaceStore()
const snapshot = () => ({ workspaceId: Number(workspace.active?.id || 0), session: user.getSnapshot() })

const versionA = ref(props.models[0]?.version || '')
const versionB = ref(props.models[1]?.version || '')
const versions = ref([])
const datasetVersionId = ref(null)
const limit = ref(50)
const result = ref(null)
const error = ref('')
const loading = ref(false)
const loadingVersions = ref(false)

const canRun = computed(() => versionA.value && versionB.value && versionA.value !== versionB.value
  && datasetVersionId.value !== null && !loading.value)

const meta = computed(() => metaRows(result.value))
const domains = computed(() => domainRows(result.value))
const diffs = computed(() => disagreementRows(result.value, 20))
const line = computed(() => summaryLine(result.value))
const judge = computed(() => verdict(result.value))

async function loadVersions() {
  loadingVersions.value = true
  try {
    const list = await allVersions(snapshot())
    versions.value = Array.isArray(list) ? list : []
    const ready = versions.value.find((item) => item.status === 'READY' && Number(item.sample_count) > 0)
    if (ready) datasetVersionId.value = Number(ready.id)
  } catch (failure) {
    error.value = failure?.message || '数据集版本加载失败；对比需要至少一个带标签的版本'
  } finally {
    loadingVersions.value = false
  }
}

async function run() {
  if (!canRun.value) return
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await api.compareModels({
      versionA: versionA.value,
      versionB: versionB.value,
      datasetVersionId: datasetVersionId.value,
      limit: Number(limit.value)
    }, user.getSnapshot())
  } catch (failure) {
    error.value = failure?.message || '对比失败'
  } finally {
    loading.value = false
  }
}

function sampleUrl(sampleId) {
  const wid = snapshot().workspaceId
  const vid = result.value && result.value.datasetVersionId
  if (!wid || !vid || !sampleId) return ''
  return `/api/v2/workspaces/${wid}/dataset-versions/${vid}/samples/${sampleId}/image`
}

function whoLabel(who) {
  return { A: 'A 对', B: 'B 对', 'both-wrong': '都错', both: '都对', unknown: '无标签' }[who] || who
}

loadVersions()
</script>

<template>
  <div class="modal-mask" role="dialog" aria-modal="true" aria-label="模型对比">
    <div class="modal-card compare-card">
      <div class="section-heading">
        <h2>模型对比</h2>
        <button type="button" class="link-button" @click="emit('close')">关闭</button>
      </div>
      <p class="muted">
        选两个版本 + 一个数据集版本：先用同一批带标签样本分别跑两个模型，再并排各自的训练指标。
        只读评估，不会改动生效模型，也不写识别记录。
      </p>

      <div class="compare-form">
        <label>模型 A
          <select v-model="versionA">
            <option v-for="model in props.models" :key="model.id" :value="model.version">
              {{ model.version }}（{{ model.status }}）
            </option>
          </select>
        </label>
        <label>模型 B
          <select v-model="versionB">
            <option v-for="model in props.models" :key="model.id" :value="model.version">
              {{ model.version }}（{{ model.status }}）
            </option>
          </select>
        </label>
        <label>数据集版本
          <select v-model.number="datasetVersionId" :disabled="loadingVersions">
            <option v-if="!versions.length" :value="null">— 没有可用版本 —</option>
            <option v-for="item in versions" :key="item.id" :value="Number(item.id)">
              #{{ item.id }} {{ item.dataset_name }} · {{ item.version }}（{{ item.sample_count }} 样本）
            </option>
          </select>
        </label>
        <label>样本数
          <input v-model.number="limit" type="number" min="1" max="200" />
        </label>
        <button :disabled="!canRun" @click="run">{{ loading ? '对比中…' : '开始对比' }}</button>
      </div>

      <p v-if="versionA && versionA === versionB" class="notice error">两个模型版本不能相同。</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <p v-if="loading" class="notice" role="status">正在用同一批样本跑两个模型，样本多时需要几十秒…</p>

      <template v-if="result">
        <p class="compare-verdict">
          {{ line }}<template v-if="judge">；{{ judge.text }}</template>
        </p>
        <p v-if="result.skipped" class="muted">有 {{ result.skipped }} 张样本读不到，已跳过。</p>

        <div class="table-wrap">
          <table>
            <thead><tr><th>项</th><th>A · {{ result.modelA.version }}</th><th>B · {{ result.modelB.version }}</th></tr></thead>
            <tbody>
              <tr v-for="row in meta" :key="row.label">
                <td>{{ row.label }}</td>
                <td>{{ row.a }}</td>
                <td>{{ row.b }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="domains.length">
          <h3>训练时的三域指标</h3>
          <p class="hint">这是各自训练结束时在自己评估集上算的，样本不同、不能直接横向比；下面的本次评估才是可比数字。</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>评估域</th><th>A 准确率</th><th>B 准确率</th><th>A 宏F1</th><th>B 宏F1</th></tr></thead>
              <tbody>
                <tr v-for="row in domains" :key="row.domain">
                  <td>{{ row.label }}</td>
                  <td>{{ row.accuracyA }}</td>
                  <td>{{ row.accuracyB }}</td>
                  <td>{{ row.f1A }}</td>
                  <td>{{ row.f1B }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <h3>差异样本（{{ diffs.length }} / 判得不一致的前 {{ diffs.length }} 条）</h3>
        <p v-if="!diffs.length" class="muted">这批样本上两个模型判得完全一致。</p>
        <ul v-else class="compare-diffs">
          <li v-for="row in diffs" :key="row.sampleId">
            <img v-if="sampleUrl(row.sampleId)" :src="sampleUrl(row.sampleId)"
                 :alt="`样本 ${row.sampleId}`" class="compare-thumb" />
            <span class="diff-id">#{{ row.sampleId }}</span>
            <span>真值 <b>{{ row.label < 0 ? '无' : row.label }}</b></span>
            <span>A 判 <b>{{ row.digitA }}</b>（{{ formatPercent(row.confidenceA) }}）</span>
            <span>B 判 <b>{{ row.digitB }}</b>（{{ formatPercent(row.confidenceB) }}）</span>
            <span class="diff-who" :class="'who-' + row.who">{{ whoLabel(row.who) }}</span>
          </li>
        </ul>
        <p v-if="result.processingMs" class="hint">模型服务本次耗时 {{ result.processingMs }} ms。</p>
      </template>
    </div>
  </div>
</template>
