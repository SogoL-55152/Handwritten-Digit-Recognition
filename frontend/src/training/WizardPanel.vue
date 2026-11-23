<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { listDatasets, listVersions, sampleImage, versionSamples, versionStats } from '@/api/datasets.js'
import { createTask, listTasks } from '@/api/training.js'
import { listModels } from '@/api/models.js'
import NetDiagram from '@/wizard/NetDiagram.vue'
import { ARCH_PRESETS, benchmarkStepMs, configHash, estimateFlops, estimateMemory, estimateTiming, formatDuration, inferShapes, lrPreview, memoryBreakdown, normalizeConfig, validateConfig } from '@/wizard/estimate.js'
import { PARAM_SCHEMA, defaultConfig, isVisible } from '@/wizard/schema.js'

const emit = defineEmits(['submitted', 'view-records'])

const user = useUserStore()
const workspace = useWorkspaceStore()

const config = reactive({ ...defaultConfig(), layers: JSON.parse(JSON.stringify(ARCH_PRESETS[1].layers)) })
const state = reactive({
  datasets: [], versions: [], stats: null, samples: [], total: 0,
  tasks: [], hash: '', loading: false, error: '', notice: '',
  datasetId: null, models: [], submitting: false
})
const imageUrls = reactive({})
const help = reactive({ open: false, item: null })
const LAYERS = [
  { key: 'conv1', label: 'conv1（卷积 32）' },
  { key: 'conv2', label: 'conv2（卷积 64）' },
  { key: 'fc1', label: 'fc1（全连接 128）' },
  { key: 'fc2', label: 'fc2（输出 10 类）' }
]

/** 参数卡片分组：只保留权重配置与核心训练参数，其余收进「高级配置」折叠。 */
const GROUPS = [
  { id: 'weights', title: '权重配置', keys: ['initFrom', 'trainFrom', 'trainableLayers'] },
  { id: 'core', title: '核心训练参数', keys: ['samples', 'photoRatio', 'epochs', 'learningRate', 'batchSize', 'earlyStop', 'patience'] }
]
const ADVANCED_KEYS = ['augRotate', 'augScale', 'augBrightness', 'augBlur', 'augMosaic',
  'optimizer', 'momentum', 'scheduler', 'amp', 'device', 'seed']

const ITEMS = Object.fromEntries(PARAM_SCHEMA.flatMap((group) => group.items.map((item) => [item.key, item])))
const groupItems = (group) => group.keys.map((key) => ITEMS[key]).filter(Boolean)
const advancedItems = () => ADVANCED_KEYS.map((key) => ITEMS[key]).filter(Boolean)

const snapshot = () => ({ workspaceId: Number(workspace.active?.id || 0), session: user.getSnapshot() })
const layers = computed(() => config.layers || [])
const archPresetName = computed(() => ARCH_PRESETS.find((item) => item.id === config.arch)?.name || config.arch)
const shapes = computed(() => inferShapes(layers.value))
const trainSamples = computed(() => {
  if (!state.stats) return 60000
  const train = (state.stats.bySplit || []).find((row) => row.key === 'TRAIN')
  return Math.max(1, train?.count || 0)
})
const memory = computed(() => estimateMemory(shapes.value.totalParams, shapes.value.activationsPerSample || 0, config.batchSize, config.amp && config.device === 'gpu'))
const timing = computed(() => estimateTiming({
  totalParams: shapes.value.totalParams,
  trainSamples: trainSamples.value,
  batch: config.batchSize,
  epochs: config.epochs,
  device: config.device
}))
const checks = computed(() => validateConfig({ config, shapes: shapes.value, memoryGb: memory.value, timing: timing.value }))
const flops = computed(() => estimateFlops(shapes.value))
const memoryParts = computed(() => memoryBreakdown(shapes.value.totalParams, shapes.value.activationsPerSample || 0,
  config.batchSize, config.amp && config.device === 'gpu'))
const groupSummary = (group) => groupItems(group)
  .filter((item) => isVisible(item, config))
  .map((item) => {
    const value = config[item.key]
    if (item.key === 'learningRate') return `lr ${Number(value).toExponential(1)}`
    if (item.key === 'earlyStop') return value ? `早停 ${config.patience} 轮` : '无早停'
    if (item.key === 'initFrom') return value ? `微调自 ${value}` : '从零训练'
    return String(value)
  })
  .slice(0, 4)
  .join(' · ')
const bench = computed(() => benchmarkStepMs(state.tasks))
const timingText = computed(() => {
  if (!bench.value) return `按公式估算 ${formatDuration(timing.value.epochSeconds)}/轮`
  const steps = timing.value.steps
  const epochSeconds = (steps * bench.value.stepMs) / 1000
  return `按历史 ${bench.value.count} 个 epoch 校准约 ${formatDuration(epochSeconds)}/轮`
})
const lrPoints = computed(() => lrPreview(config.scheduler, Number(config.learningRate), Number(config.epochs)))
const blocking = computed(() => checks.value.some((item) => item.level === 'error'))
const jsonPreview = computed(() => JSON.stringify(normalizeConfig(config), null, 2))
const currentDataset = computed(() => state.datasets.find((item) => Number(item.id) === Number(state.datasetId)) || null)
const currentVersion = computed(() => state.versions.find((item) => Number(item.id) === Number(config.datasetVersionId)) || null)
const layerParams = computed(() => {
  const rows = shapes.value.rows || []
  const conv = rows.filter((row) => row.type === 'conv')
  const linear = rows.filter((row) => row.type === 'linear')
  return {
    conv1: conv[0]?.params || 0,
    conv2: conv[1]?.params || 0,
    fc1: linear[0]?.params || 0,
    fc2: linear[linear.length - 1]?.params || 0
  }
})
const frozenNames = computed(() => {
  const all = ['conv1', 'conv2', 'fc1', 'fc2']
  if (config.trainFrom === 'all') return []
  if (config.trainFrom === 'fc1') return ['conv1', 'conv2']
  if (config.trainFrom === 'fc2') return ['conv1', 'conv2', 'fc1']
  const trainable = config.trainableLayers || []
  return all.filter((name) => !trainable.includes(name))
})
const trainableParams = computed(() => {
  const trainable = config.trainFrom === 'custom'
    ? (config.trainableLayers || [])
    : config.trainFrom === 'fc1' ? ['fc1', 'fc2'] : config.trainFrom === 'fc2' ? ['fc2'] : ['conv1', 'conv2', 'fc1', 'fc2']
  return trainable.reduce((sum, name) => sum + (layerParams.value[name] || 0), 0)
})
const trainablePercent = computed(() => shapes.value.totalParams ? Math.round((trainableParams.value / shapes.value.totalParams) * 1000) / 10 : 0)
const labelRows = computed(() => (state.stats?.byLabel || []).map((row) => ({ label: String(row.key), count: row.count || 0 })))
const healthChecks = computed(() => {
  const rows = []
  const total = splitRows.value.reduce((sum, row) => sum + row.count, 0)
  const trainCount = splitRows.value.find((row) => row.key === 'TRAIN')?.count || 0
  if (state.stats) {
    if (trainCount === 0) rows.push({ level: 'error', text: '该版本训练集为 0，无法训练；请重新生成版本（样本少时把验证/测试比例设为 0）' })
    if (total > 0 && total < 100) rows.push({ level: 'warn', text: `样本只有 ${total} 条，建议先补到 100 条以上` })
    const counts = labelRows.value.map((row) => row.count)
    if (counts.length) {
      const min = Math.min(...counts)
      const max = Math.max(...counts)
      const missing = 10 - labelRows.value.length
      if (missing > 0) rows.push({ level: 'warn', text: `缺少 ${missing} 个数字类别的样本（0–9 中只有 ${labelRows.value.length} 类）` })
      if (min < 20) rows.push({ level: 'warn', text: `最少的一类只有 ${min} 条，可能学不稳（建议每类 ≥20）` })
      if (max > 0 && max / Math.max(1, min) >= 10) rows.push({ level: 'warn', text: `类别不均衡：最多 ${max} 条 / 最少 ${min} 条` })
    }
    const writers = state.stats?.version?.writerCount
    if (writers === 1) rows.push({ level: 'warn', text: '只有 1 位书写者：建议用随机划分，否则版本无法按人划分' })
    if (!rows.length) rows.push({ level: 'ok', text: '数据检查通过：划分、类别与书写者数量都正常' })
  } else {
    rows.push({ level: 'ok', text: '未选择数据版本：将使用内置 MNIST 训练' })
  }
  return rows
})
const comparableTask = computed(() => {
  const done = state.tasks.filter((task) => task.status === 'SUCCEEDED' && task.metrics?.history?.length)
    .sort((a, b) => Number(b.id) - Number(a.id))
  return done[0] || null
})
const comparableText = computed(() => {
  const task = comparableTask.value
  if (!task) return ''
  const history = task.metrics.history
  const seconds = history.reduce((sum, row) => sum + (row.durationMs || 0), 0) / 1000
  return `上次同类训练 #${task.id}：${task.metrics.config?.samples || '?'} 样本 · ${history.length} 轮 · 约 ${formatDuration(seconds)}`
})
const prepSeconds = computed(() => {
  const count = trainSamples.value
  return count * 0.012
})
/** 合并校验 + 数据体检成一张检查清单。 */
const allChecks = computed(() => [...checks.value, ...healthChecks.value])
const checkCounts = computed(() => {
  const counts = { ok: 0, warn: 0, error: 0 }
  for (const item of allChecks.value) if (counts[item.level] !== undefined) counts[item.level] += 1
  return counts
})

function hintFor(item) {
  const steps = Math.max(1, Math.ceil(Number(config.samples) / Number(config.batchSize)))
  switch (item.key) {
    case 'datasetVersionId':
      return state.stats ? `训练 ${trainSamples.value} 条 · 共 ${state.stats.version?.sampleCount || 0} 条` : '按内置 MNIST 60,000 条估算'
    case 'samples':
      return `≈ ${steps} 步/轮（batch ${config.batchSize}）`
    case 'epochs':
      return config.earlyStop ? `合计最多 ${steps * Number(config.epochs)} 步；早停可能提前结束` : `合计约 ${steps * Number(config.epochs)} 步`
    case 'learningRate':
      return config.initFrom ? '微调建议 1e-4 ~ 5e-4' : '从零训练建议 1e-3 左右'
    case 'batchSize':
      return `内存约 ${memory.value.toFixed(2)} GB`
    case 'photoRatio':
      return `约 ${Math.round(Number(config.samples) * Number(config.photoRatio)).toLocaleString()} 张/轮走照片模拟`
    case 'trainFrom':
      return `可训练 ${trainableParams.value.toLocaleString()} 参数（${trainablePercent.value}%）`
    case 'trainableLayers':
      return `已选 ${(config.trainableLayers || []).length} / 4 层`
    case 'patience':
      return `最多可省约 ${Math.max(0, Number(config.epochs) - Number(config.patience))} 轮`
    case 'earlyStop':
      return config.earlyStop ? `验证不提升连续 ${config.patience} 轮即停` : '不提前结束，按轮数跑满'
    case 'initFrom':
      return config.initFrom ? '在已有权重上继续训练' : '不使用起点权重'
    case 'device':
      return config.device === 'gpu' ? 'GPU 约为 CPU 的 10 倍速度' : '无 GPU 时按 CPU 估算'
    case 'seed':
      return '相同种子 + 相同配置 = 可复现'
    default:
      return ''
  }
}

const splitRows = computed(() => {
  const rows = state.stats?.bySplit || []
  const total = rows.reduce((sum, row) => sum + (row.count || 0), 0) || 1
  return ['TRAIN', 'VAL', 'TEST'].map((key) => {
    const count = rows.find((row) => row.key === key)?.count || 0
    return { key, count, percent: Math.round((count / total) * 100) }
  })
})

function applyPreset(id) {
  config.arch = id
  const preset = ARCH_PRESETS.find((item) => item.id === id)
  if (preset) config.layers = JSON.parse(JSON.stringify(preset.layers))
}

function updateLayer(index, key, value) {
  const layer = config.layers[index]
  if (!layer) return
  layer[key] = value
  config.layers = [...config.layers]
}

function releaseImages() {
  Object.values(imageUrls).forEach((url) => URL.revokeObjectURL(url))
  Object.keys(imageUrls).forEach((key) => delete imageUrls[key])
}

async function loadDatasets() {
  if (!workspace.active?.id) return
  state.loading = true
  state.error = ''
  try {
    state.datasets = await listDatasets(snapshot())
  } catch (error) {
    state.error = error?.message || '数据集加载失败'
  } finally {
    state.loading = false
  }
}

async function loadVersions(datasetId) {
  state.versions = []
  config.datasetVersionId = null
  if (!datasetId) return
  try {
    state.versions = await listVersions(snapshot(), datasetId)
    const ready = state.versions.find((item) => item.status === 'READY' && item.sampleCount > 0)
    if (ready) await selectVersion(ready.id)
  } catch (error) {
    state.error = error?.message || '版本加载失败'
  }
}

async function selectVersion(versionId) {
  config.datasetVersionId = versionId
  releaseImages()
  if (!versionId) { state.stats = null; state.samples = []; return }
  try {
    state.stats = await versionStats(snapshot(), versionId)
    const page = await versionSamples(snapshot(), versionId, { page: 1, size: 8 })
    state.samples = page.items || []
    state.total = page.total || 0
    for (const item of state.samples) {
      try {
        const blob = await sampleImage(snapshot(), versionId, item.id)
        imageUrls[item.id] = URL.createObjectURL(blob)
      } catch (error) { /* 单张失败不影响其它 */ }
    }
  } catch (error) {
    state.error = error?.message || '版本数据加载失败'
  }
}

async function loadModels() {
  try {
    state.models = await listModels(user.getSnapshot())
  } catch (error) {
    state.models = []
  }
}

function selectDatasetValue(value) {
  state.datasetId = value ? Number(value) : null
  void loadVersions(state.datasetId)
}

function toggleLayer(key) {
  const current = Array.isArray(config.trainableLayers) ? config.trainableLayers : []
  if (key === 'fc2' && current.includes('fc2')) {
    state.error = 'fc2（最后一层）必须可训练'
    return
  }
  state.error = ''
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
  config.trainableLayers = LAYERS.map((layer) => layer.key).filter((item) => next.includes(item))
}

function openHelp(item) {
  help.open = true
  help.item = item || null
}

function openManual() {
  openHelp(null)
}

function closeHelp() {
  help.open = false
  help.item = null
}

function applyTemplate(kind) {
  if (kind === 'quick') {
    Object.assign(config, { epochs: 3, samples: 10000, batchSize: 64, learningRate: 0.001, earlyStop: true, patience: 2 })
  } else if (kind === 'accurate') {
    Object.assign(config, { epochs: 12, samples: 60000, batchSize: 128, learningRate: 0.0005, earlyStop: true, patience: 4 })
  } else {
    Object.assign(config, { epochs: 8, samples: 30000, batchSize: 64, learningRate: 0.0008, photoRatio: 0.8, earlyStop: true, patience: 3 })
  }
  applyPreset(config.arch)
}

async function submitTraining() {
  if (state.submitting) return
  state.error = ''
  state.notice = ''
  if (!state.datasetId) { state.error = '请先在数据区选择一个数据集'; return }
  if (blocking.value) { state.error = '参数校验未通过，请先修正'; return }
  state.submitting = true
  try {
    const payload = {
      epochs: Number(config.epochs),
      samples: Number(config.samples),
      batchSize: Number(config.batchSize),
      learningRate: Number(config.learningRate),
      seed: Number(config.seed),
      photoRatio: Number(config.photoRatio),
      useEmnist: false,
      initFrom: config.initFrom || null,
      datasetVersionId: config.datasetVersionId || null,
      earlyStop: Boolean(config.earlyStop),
      patience: Number(config.patience) || 3,
      augRotate: Number(config.augRotate) || 0,
      augScale: Number(config.augScale) || 0,
      augBrightness: Number(config.augBrightness) || 0,
      augBlur: Number(config.augBlur) || 0,
      augMosaic: Number(config.augMosaic) || 0,
      trainFrom: config.trainFrom || 'all',
      trainableLayers: config.trainFrom === 'custom' ? (config.trainableLayers || []) : undefined
    }
    const created = await createTask(state.datasetId, payload, user.getSnapshot())
    state.notice = `已提交训练任务 #${created.id}，数据准备在后台进行，进度与日志见「训练记录」。`
    await loadTasks()
    emit('submitted', created.id)
  } catch (error) {
    state.error = error?.message || '提交训练任务失败'
  } finally {
    state.submitting = false
  }
}

async function loadTasks() {
  try {
    state.tasks = await listTasks(user.getSnapshot(), 20)
  } catch (error) {
    state.error = error?.message || '训练任务加载失败'
  }
}

function lrText(value) {
  return Number(value).toExponential(1)
}

function setLr(value) {
  config.learningRate = Number(value)
}

async function refreshHash() {
  state.hash = await configHash(config)
}

watch(() => state.hash, () => {})
watch(() => [config.arch, config.optimizer, config.learningRate, config.batchSize, config.epochs,
  config.seed, config.device, config.amp, config.earlyStop, config.patience, config.datasetVersionId],
() => { void refreshHash() }, { immediate: true })

watch(() => workspace.active?.id, (id) => {
  if (id) void loadDatasets()
}, { immediate: true })

onMounted(async () => {
  await loadModels()
  await loadTasks()
})
onBeforeUnmount(releaseImages)
</script>

<template>
  <div class="stack wide-gap wizard-panel">
    <section class="panel">
      <div class="wizard-head">
        <div>
          <div class="wizard-title-row">
            <div>
              <p class="eyebrow">TRAIN</p>
              <h2>训练模型</h2>
            </div>
          </div>
          <p class="muted">选数据、调参数，点「开始训练」后到「训练记录」看准备进度与逐轮输出。</p>
        </div>
        <button type="button" class="manual-button" @click="openManual">用户手册</button>
      </div>
      <p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" class="notice" role="status">{{ state.notice }}<button type="button" class="link" @click="emit('view-records')">去训练记录</button></p>
    </section>

    <!-- 数据选择 -->
    <section class="panel">
      <div class="dataset-bar">
        <h3>数据</h3>
        <label class="field-row-line">数据集
          <select @change="selectDatasetValue($event.target.value)">
            <option :value="''">不使用版本（仅内置 MNIST）</option>
            <option v-for="item in state.datasets" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label v-if="state.versions.length" class="field-row-line">版本
          <select :value="config.datasetVersionId || ''" @change="selectVersion($event.target.value ? Number($event.target.value) : null)">
            <option :value="''">不使用</option>
            <option v-for="item in state.versions" :key="item.id" :value="item.id">{{ item.version }} · {{ item.sampleCount }} 条</option>
          </select>
        </label>
        <p class="muted">{{ state.stats ? `训练样本 ${trainSamples} 条（版本快照，后续新增样本不会自动进来）` : '未选版本时按内置 MNIST 60,000 条估算' }}</p>
      </div>
      <div v-if="state.stats" class="split-bar">
        <div v-for="row in splitRows" :key="row.key" class="split-seg" :class="'seg-' + row.key.toLowerCase()"
             :style="{ width: Math.max(2, row.percent) + '%' }">
          {{ row.key }} {{ row.count }}
        </div>
      </div>
      <div v-if="state.samples.length" class="wizard-samples">
        <figure v-for="item in state.samples" :key="item.id" class="wizard-sample">
          <img v-if="imageUrls[item.id]" :src="imageUrls[item.id]" :alt="'样本 ' + item.label" />
          <span v-else class="sample-placeholder">无图</span>
          <figcaption>{{ item.label }}</figcaption>
        </figure>
      </div>
    </section>

    <!-- 参数调整 -->
    <section class="wizard-params">
      <div class="stack wizard-form">
        <section class="panel summary-card">
          <h3>本次训练摘要</h3>
          <div class="summary-grid">
            <div class="summary-item">
              <small>数据集</small>
              <strong>{{ currentDataset?.name || '内置 MNIST' }}{{ currentVersion ? ' · ' + currentVersion.version : '' }}</strong>
              <span v-if="state.stats" class="muted">训练 {{ splitRows[0].count }} · 验证 {{ splitRows[1].count }} · 测试 {{ splitRows[2].count }}</span>
              <span v-else class="muted">60,000 条内置样本</span>
            </div>
            <div class="summary-item">
              <small>权重配置</small>
              <strong>{{ config.initFrom ? '微调 ' + config.initFrom : '从零训练' }}</strong>
              <span class="muted">{{ config.trainFrom === 'all' ? '全量更新' : '部分冻结' }} · 可训练 {{ trainableParams.toLocaleString() }}（{{ trainablePercent }}%）· {{ archPresetName }}</span>
            </div>
            <div class="summary-item">
              <small>核心训练参数</small>
              <strong>{{ config.samples.toLocaleString() }} 样本 · {{ config.epochs }} 轮</strong>
              <span class="muted">lr {{ Number(config.learningRate).toExponential(1) }} · batch {{ config.batchSize }} · 照片增广 {{ config.photoRatio }} · {{ config.earlyStop ? '早停 ' + config.patience : '无早停' }}</span>
            </div>
            <div class="summary-item">
              <small>预估</small>
              <strong>{{ formatDuration(timing.epochSeconds) }}/轮 · 合计 {{ formatDuration(timing.totalSeconds) }}</strong>
              <span class="muted">内存 {{ memory.toFixed(2) }} GB · 数据准备约 {{ formatDuration(prepSeconds) }}</span>
            </div>
          </div>
          <div class="summary-risks">
            <span v-for="(check, index) in healthChecks.filter((item) => item.level !== 'ok').slice(0, 3)" :key="index"
                  class="risk-chip" :class="'risk-' + check.level">{{ check.text }}</span>
            <span v-if="!healthChecks.some((item) => item.level !== 'ok')" class="risk-chip risk-ok">✓ 数据与参数检查通过</span>
          </div>
        </section>

        <div class="template-bar">
          <span class="muted">参数模板：</span>
          <button type="button" @click="applyTemplate('quick')">快速上手</button>
          <button type="button" @click="applyTemplate('accurate')">高精度</button>
          <button type="button" @click="applyTemplate('robust')">手机笔迹鲁棒</button>
        </div>

        <div class="param-groups">
          <details v-for="group in GROUPS" :key="group.id" class="panel param-group-card collapsible-card">
            <summary>{{ group.title }}<small class="muted">{{ groupSummary(group) }}</small></summary>
            <div v-if="group.id === 'weights'" class="param-line">
              <label for="p-arch">网络结构 <button type="button" class="help" title="训练网络的结构预设；改动会即时反映在右侧结构图与估算里" @click.stop="openHelp({ key: 'arch', label: '网络结构', detail: '训练网络的结构预设。\n常规：默认 cnn2（两个卷积层 + 两个全连接）已经适合本项目；机器慢可选 LeNet-5（快）。\n注意：结构改动会改变参数量与训练耗时，估算面板会即时更新。' })">ⓘ</button></label>
              <select id="p-arch" :value="config.arch" @change="applyPreset($event.target.value)">
                <option v-for="preset in ARCH_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
              </select>
            </div>
            <template v-for="item in groupItems(group)" :key="item.key">
              <div v-if="isVisible(item, config)" class="param-line">
                <label :for="'p-' + item.key">
                  {{ item.label }} <button type="button" class="help" :title="item.help" @click.stop="openHelp(item)">ⓘ</button>
                  <span v-if="item.displayOnly" class="readonly-badge" title="当前训练管线固定，只参与估算">仅估算</span>
                </label>
                <select v-if="item.widget === 'select'" :id="'p-' + item.key" v-model="config[item.key]">
                  <template v-if="item.options?.from === 'models'">
                    <option :value="null">从零训练</option>
                    <option v-for="model in state.models" :key="model.version" :value="model.version">
                      {{ model.version }}{{ model.status === 'ACTIVE' ? '（生效中）' : '' }}
                    </option>
                  </template>
                  <template v-else>
                    <option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </template>
                </select>
                <div v-else-if="item.widget === 'log-slider'" class="log-slider">
                  <input :id="'p-' + item.key" type="range" :min="Math.log10(item.min)" :max="Math.log10(item.max)"
                         step="0.1" :value="Math.log10(config[item.key])" @input="setLr(10 ** Number($event.target.value))" />
                  <input type="number" :value="config[item.key]" step="any" @change="setLr($event.target.value)" />
                  <small>{{ lrText(config[item.key]) }}</small>
                </div>
                <div v-else-if="item.widget === 'segmented'" class="segmented">
                  <button v-for="option in item.options" :key="option" type="button"
                          :class="{ active: Number(config[item.key]) === option }" @click="config[item.key] = option">{{ option }}</button>
                </div>
                <div v-else-if="item.widget === 'slider'" class="simple-slider">
                  <input :id="'p-' + item.key" type="range" v-model.number="config[item.key]" :min="item.min" :max="item.max" :step="item.step" />
                  <span>{{ config[item.key] }}</span>
                </div>
                <input v-else-if="item.widget === 'number'" :id="'p-' + item.key" v-model.number="config[item.key]" type="number" :min="item.min" :max="item.max" />
                <div v-else-if="item.widget === 'layers'" class="layer-checks">
                  <label v-for="layer in LAYERS" :key="layer.key" class="layer-check">
                    <input type="checkbox" :checked="(config.trainableLayers || []).includes(layer.key)"
                           :disabled="layer.key === 'fc2'" @change="toggleLayer(layer.key)" />
                    {{ layer.label }}
                  </label>
                  <p class="hint">fc2 固定可训练；其余按需勾选。</p>
                </div>
                <input v-else-if="item.widget === 'switch'" :id="'p-' + item.key" type="checkbox" class="switch-input" v-model="config[item.key]" />
                <p v-if="hintFor(item)" class="param-hint">{{ hintFor(item) }}</p>
              </div>
            </template>
            <div v-if="group.id === 'core'" class="lr-preview-inline">
              <svg class="lr-preview" viewBox="0 0 240 40" preserveAspectRatio="none">
                <polyline fill="none" stroke="#2f6fd0" stroke-width="2"
                          :points="lrPoints.map((point, index) => `${(index / Math.max(1, lrPoints.length - 1)) * 240},${40 - (point.lr / Math.max(1e-9, lrPoints[0].lr)) * 36}`).join(' ')" />
              </svg>
              <p class="muted">{{ config.scheduler === 'constant' ? '常数学习率' : config.scheduler === 'cosine' ? '余弦退火' : '分段衰减' }}（仅预览）</p>
            </div>
          </details>

          <details class="panel param-group-card advanced-card">
            <summary>高级配置<span class="muted">{{ state.hash ? 'config_hash ' + state.hash : '' }}</span></summary>
            <h3 class="advanced-sub">增强项（旋转 / 缩放 / 亮度 / 模糊 / 马赛克）</h3>
            <template v-for="item in advancedItems()" :key="item.key">
              <div v-if="isVisible(item, config)" class="param-line">
                <label :for="'p-' + item.key">
                  {{ item.label }} <button type="button" class="help" :title="item.help" @click.stop="openHelp(item)">ⓘ</button>
                  <span v-if="item.displayOnly" class="readonly-badge" title="当前训练管线固定，只参与估算">仅估算</span>
                </label>
                <select v-if="item.widget === 'select'" :id="'p-' + item.key" v-model="config[item.key]">
                  <option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <div v-else-if="item.widget === 'slider'" class="simple-slider">
                  <input :id="'p-' + item.key" type="range" v-model.number="config[item.key]" :min="item.min" :max="item.max" :step="item.step" />
                  <span>{{ config[item.key] }}</span>
                </div>
                <input v-else-if="item.widget === 'number'" :id="'p-' + item.key" v-model.number="config[item.key]" type="number" :min="item.min" :max="item.max" />
                <input v-else-if="item.widget === 'switch'" :id="'p-' + item.key" type="checkbox" class="switch-input" v-model="config[item.key]" />
                <p v-if="hintFor(item)" class="param-hint">{{ hintFor(item) }}</p>
              </div>
            </template>
            <h3 class="advanced-sub">网络图层（谨慎修改，默认结构已够用）</h3>
            <div class="layer-editor">
              <div v-for="(layer, index) in layers" :key="index" class="layer-row">
                <span class="layer-index">{{ index + 1 }}</span>
                <span class="layer-name">{{ layer.type.toUpperCase() }}</span>
                <template v-if="layer.type === 'conv'">
                  <label>卷积核 <input type="number" min="1" max="128" :value="layer.filters" @change="updateLayer(index, 'filters', Number($event.target.value))" /></label>
                  <label>kernel <input type="number" min="1" max="7" :value="layer.kernel" @change="updateLayer(index, 'kernel', Number($event.target.value))" /></label>
                  <label>padding <input type="number" min="0" max="3" :value="layer.padding" @change="updateLayer(index, 'padding', Number($event.target.value))" /></label>
                </template>
                <label v-else-if="layer.type === 'linear'">units <input type="number" min="4" max="2048" :value="layer.units" @change="updateLayer(index, 'units', Number($event.target.value))" /></label>
                <span v-else class="layer-fixed">固定</span>
              </div>
            </div>
            <details class="json-preview">
              <summary>配置摘要（JSON）</summary>
              <pre>{{ jsonPreview }}</pre>
            </details>
          </details>

          <details class="panel param-group-card collapsible-card structure-card">
            <summary>结构图与估算<small class="muted">{{ shapes.totalParams.toLocaleString() }} 参数 · 单 epoch {{ formatDuration(timing.epochSeconds) }} · 合计 {{ formatDuration(timing.totalSeconds) }}</small></summary>
            <div class="structure-body">
              <NetDiagram :layers="layers" :frozen="frozenNames" />
              <p class="muted">🔒 = 已冻结（不更新）· 当前可训练 {{ trainableParams.toLocaleString() }} / {{ shapes.totalParams.toLocaleString() }} 参数（{{ trainablePercent }}%）</p>
            </div>
            <div class="estimate-cards">
              <div class="estimate-card"><small>参数量</small><strong>{{ shapes.totalParams.toLocaleString() }}</strong></div>
              <div class="estimate-card"><small>内存</small><strong>{{ memory.toFixed(2) }} GB</strong></div>
              <div class="estimate-card"><small>单 epoch</small><strong>{{ formatDuration(timing.epochSeconds) }}</strong></div>
              <div class="estimate-card"><small>总耗时</small><strong>{{ formatDuration(timing.totalSeconds) }}</strong></div>
            </div>
            <p class="muted">单步约 {{ timing.stepMs.toFixed(1) }} ms · {{ timing.steps }} 步/轮 · 训练样本 {{ trainSamples }} · {{ timingText }}</p>
            <p class="muted">FLOPs ≈ {{ flops.toExponential(2) }}</p>
            <div class="estimate-breakdown">
              <span>数据准备 ≈ {{ formatDuration(prepSeconds) }}（命中缓存更快）</span>
              <span>产物登记 ≈ 2s</span>
              <span v-if="comparableText">{{ comparableText }}</span>
            </div>
            <div class="memory-split">
              <span>权重 {{ memoryParts.weightsGb.toFixed(3) }}</span>
              <span>梯度 {{ memoryParts.gradsGb.toFixed(3) }}</span>
              <span>优化器 {{ memoryParts.optimizerGb.toFixed(3) }}</span>
              <span>激活 {{ memoryParts.activationsGb.toFixed(3) }}</span>
            </div>
          </details>

          <details class="panel param-group-card collapsible-card checks-card">
            <summary>检查<small class="muted">{{ checkCounts.ok }} 通过 · {{ checkCounts.warn }} 提醒 · {{ checkCounts.error }} 错误</small></summary>
            <ul class="check-list">
              <li v-for="(check, index) in allChecks" :key="index" :class="'check-' + check.level">
                <span>{{ check.level === 'ok' ? '✓' : check.level === 'warn' ? '⚠' : '✗' }}</span>{{ check.text }}
              </li>
            </ul>
            <div v-if="labelRows.length" class="label-mini-bars">
              <div v-for="row in labelRows" :key="row.label" class="label-mini">
                <span>{{ row.label }}</span>
                <i :style="{ width: Math.max(2, (row.count / Math.max(1, ...labelRows.map((item) => item.count))) * 100) + '%' }"></i>
                <small>{{ row.count }}</small>
              </div>
            </div>
          </details>
        </div>

        <div class="wizard-footer">
          <span class="muted">config_hash {{ state.hash }}</span>
          <button class="primary" :disabled="state.submitting || blocking" @click="submitTraining">
            {{ state.submitting ? '提交中…' : '开始训练' }}
          </button>
        </div>
      </div>
    </section>

    <div v-if="help.open" class="modal-mask" @click.self="closeHelp">
      <section class="modal-card help-card">
        <header class="modal-head">
          <div>
            <h3>{{ help.item ? help.item.label : '训练模型 · 用户手册' }}</h3>
            <p class="muted">{{ help.item ? (help.item.displayOnly ? '仅参与估算，不影响真实训练' : '真实参与训练') : '点每个参数旁的 ⓘ 看单条详细说明' }}</p>
          </div>
          <button class="link" @click="closeHelp">关闭</button>
        </header>

        <div v-if="help.item" class="help-detail">
          <p v-for="line in help.item.detail.split('\n')" :key="line">{{ line }}</p>
          <p class="muted">当前取值：{{ config[help.item.key] ?? '—' }}</p>
        </div>

        <div v-else class="help-groups">
          <article class="flow-article">
            <h4>整体流程（先看这里）</h4>
            <p class="muted">一个页面完成训练：上方选数据、调参数，点「开始训练」，下方日志实时看准备进度与逐轮输出。</p>
            <ol class="flow-list">
              <li>
                <strong>准备数据</strong>
                <p>数据集页 → 新建数据集 → 导入数据集（文件夹 / CSV / 文件名 / zip / 带框多位数 / IDX）。导入成功后会自动生成一个版本。</p>
                <p><router-link to="/datasets">去数据集页</router-link></p>
              </li>
              <li>
                <strong>选数据版本</strong>
                <p>本页「数据」区：选数据集 + 版本。版本是快照，之后补的样本不会自动进来，要重新生成版本。</p>
              </li>
              <li>
                <strong>决定从哪开始</strong>
                <p>「微调起点」选当前生效模型 = 微调（快、稳）；选「从零训练」= 用内置 MNIST + 你的样本重训（慢，但不受旧模型限制）。</p>
              </li>
              <li>
                <strong>设参数</strong>
                <p>第一次跑先按「快速上手」：样本 10,000、3 轮、学习率 1e-3、早停开。跑通后再调学习率与轮数，别一次改多个。</p>
              </li>
              <li>
                <strong>提交训练</strong>
                <p>点「开始训练」立即返回任务号；数据准备（导出/渲染）在后台进行，「训练记录」里会显示准备进度百分比。</p>
              </li>
              <li>
                <strong>看进度与结果</strong>
                <p>「训练记录」页有日志、逐轮曲线、三域评估与混淆矩阵。</p>
              </li>
              <li>
                <strong>上线</strong>
                <p>新模型不差于当前模型时，到「模型管理」页激活；识别接口随即切换到新模型。</p>
                <p><router-link to="/models">去模型管理</router-link></p>
              </li>
            </ol>
          </article>

          <article v-for="group in PARAM_SCHEMA" :key="group.id">
            <h4>{{ group.title }}</h4>
            <div v-for="item in group.items" :key="item.key" class="help-row">
              <div class="help-row-head">
                <strong>{{ item.label }}</strong>
                <span v-if="item.displayOnly" class="readonly-badge">仅估算</span>
                <code>{{ item.key }}</code>
              </div>
              <p v-for="line in item.detail.split('\n')" :key="line">{{ line }}</p>
            </div>
          </article>
          <article>
            <h4>常见问题</h4>
            <div class="help-row">
              <div class="help-row-head"><strong>提交后很久没动静？</strong></div>
              <p>看下方日志与任务状态条的准备进度：准备数据阶段没有逐轮输出，属正常；几十秒到几分钟取决于版本大小与是否命中缓存。同配置再次训练会直接复用渲染缓存，准备时间大幅缩短。</p>
            </div>
            <div class="help-row">
              <div class="help-row-head"><strong>准确率不涨？</strong></div>
              <p>先查数据（标签分布、多位数样本、抽样自检），再降学习率或加样本；盲目加轮数通常没用。</p>
            </div>
            <div class="help-row">
              <div class="help-row-head"><strong>早停太早？</strong></div>
              <p>把耐心从 2 提到 3~4；画板模拟准确率波动大是正常现象。</p>
            </div>
          </article>

          <article>
            <h4>三套常用配置</h4>
            <div class="help-row">
              <div class="help-row-head"><strong>快速上手</strong></div>
              <p>样本 10,000 ｜ 3 轮 ｜ 学习率 1e-3 ｜ batch 64 ｜ 早停开、耐心 2</p>
              <p>用途：先确认数据与链路没问题，几十秒出结果。</p>
            </div>
            <div class="help-row">
              <div class="help-row-head"><strong>高精度</strong></div>
              <p>样本 60,000 ｜ 8~12 轮 ｜ 学习率 5e-4 ｜ batch 128 ｜ 早停开、耐心 4</p>
              <p>用途：数据量大、机器有空闲时冲精度；CPU 约 10 分钟起。</p>
            </div>
            <div class="help-row">
              <div class="help-row-head"><strong>手机笔迹微调</strong></div>
              <p>基于生效模型微调 ｜ 样本 10,000 ｜ 3~5 轮 ｜ 学习率 3e-4 ｜ 照片增广 0.3~0.6</p>
              <p>用途：用自己的手写数据适配，注意别把学习率调大。</p>
            </div>
          </article>
        </div>

        <footer class="modal-foot">
          <button @click="closeHelp">知道了</button>
        </footer>
      </section>
    </div>
  </div>
</template>
