<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { listDatasets, listVersions, sampleImage, versionSamples, versionStats } from '@/api/datasets.js'
import { createTask, eventsTicket, listTasks, trainingLogs } from '@/api/training.js'
import { listModels } from '@/api/models.js'
import { taskDetail } from '@/training/detail.js'
import { createTrainingEvents } from '@/training/events.js'
import { isActiveStatus, liveLabel, shouldPoll } from '@/training/live.js'
import TrainingCurve from '@/training/TrainingCurve.vue'
import TrainingMatrix from '@/training/TrainingMatrix.vue'
import StepCurve from '@/training/StepCurve.vue'
import { ARCH_PRESETS, benchmarkStepMs, configHash, estimateFlops, estimateMemory, estimateTiming, formatDuration, inferShapes, lrPreview, memoryBreakdown, normalizeConfig, overfitSignal, validateConfig } from '@/wizard/estimate.js'
import { PARAM_SCHEMA, defaultConfig, isVisible } from '@/wizard/schema.js'

const user = useUserStore()
const workspace = useWorkspaceStore()

const STEPS = ['数据与参数', '监控与评估']
const step = ref(1)
const config = reactive({ ...defaultConfig(), layers: JSON.parse(JSON.stringify(ARCH_PRESETS[1].layers)) })
const live = reactive({ logs: '', elapsed: 0 })
let liveTimer = null
const liveStatus = ref('connecting')

/** SSE 推来的任务按 id 覆盖；新任务插到最前面（与训练记录页同一套规则）。 */
function mergeLiveTask(incoming) {
  if (!incoming || !incoming.id) return
  const index = state.tasks.findIndex((item) => String(item.id) === String(incoming.id))
  if (index >= 0) state.tasks.splice(index, 1, incoming)
  else state.tasks.unshift(incoming)
  state.tasks = [...state.tasks].sort((a, b) => Number(b.id) - Number(a.id))
}

const events = createTrainingEvents({
  api: { eventsTicket },
  getSession: () => user.getSnapshot(),
  onTask: (task) => mergeLiveTask(task),
  onStatus: (status) => { liveStatus.value = status }
})
const liveStateLabel = computed(() => liveLabel(liveStatus.value))
const state = reactive({
  datasets: [], versions: [], stats: null, samples: [], total: 0,
  tasks: [], taskId: null, hash: '', loading: false, error: '', notice: '',
  datasetId: null, models: [], submitting: false
})
const imageUrls = reactive({})
const errors = ref([])
const openGroups = reactive({ data: true, structure: true, hyper: true, runtime: true })
const help = reactive({ open: false, item: null })
const LAYERS = [
  { key: 'conv1', label: 'conv1（卷积 32）' },
  { key: 'conv2', label: 'conv2（卷积 64）' },
  { key: 'fc1', label: 'fc1（全连接 128）' },
  { key: 'fc2', label: 'fc2（输出 10 类）' }
]

const snapshot = () => ({ workspaceId: Number(workspace.active?.id || 0), session: user.getSnapshot() })
const archPreset = computed(() => ARCH_PRESETS.find((item) => item.id === config.arch) || ARCH_PRESETS[1])
const layers = computed(() => config.layers || [])
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
const layerRows = computed(() => (shapes.value.rows || []).map((row) => ({
  ...row,
  percent: shapes.value.totalParams ? Math.round((row.params / shapes.value.totalParams) * 1000) / 10 : 0
})))
const groupSummary = (group) => group.items
  .filter((item) => isVisible(item, config))
  .map((item) => {
    const value = config[item.key]
    if (item.key === 'learningRate') return `lr ${Number(value).toExponential(1)}`
    if (item.key === 'earlyStop') return value ? `早停 ${config.patience} 轮` : '无早停'
    if (item.key === 'initFrom') return value ? `微调自 ${value}` : '从零训练'
    if (item.key === 'datasetVersionId') return value ? '指定版本' : '不使用版本'
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
const overfit = computed(() => overfitSignal(selectedTask.value?.metrics?.history))
const lrPoints = computed(() => lrPreview(config.scheduler, Number(config.learningRate), Number(config.epochs)))
const blocking = computed(() => checks.value.some((item) => item.level === 'error'))
const jsonPreview = computed(() => JSON.stringify(normalizeConfig(config), null, 2))
const selectedTask = computed(() => state.tasks.find((task) => String(task.id) === String(state.taskId)) || null)
const taskDetailView = computed(() => taskDetail(selectedTask.value))
const taskHistory = computed(() => selectedTask.value?.metrics?.history || [])
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
const freezeLabel = computed(() => {
  if (config.trainFrom === 'all') return '不冻结（全量微调）'
  if (config.trainFrom === 'fc1') return '冻结卷积层，只训全连接'
  if (config.trainFrom === 'fc2') return '只训最后一层（fc2）'
  return '自定义'
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
  if (!state.datasetId) { state.error = '请先在第①步选择一个数据集'; return }
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
    state.taskId = created.id
    state.notice = `已提交训练任务 #${created.id}（数据准备在后台进行），切换到第③步查看进度`
    await loadTasks()
    step.value = 2
  } catch (error) {
    state.error = error?.message || '提交训练任务失败'
  } finally {
    state.submitting = false
  }
}

async function loadLiveLogs() {
  if (!state.taskId) return
  try {
    const data = await trainingLogs(user.getSnapshot(), state.taskId)
    const lines = Array.isArray(data?.lines) ? data.lines : (Array.isArray(data) ? data : [])
    live.logs = lines.slice(-120).join('\n')
  } catch (error) {
    // 日志拉取失败不影响主流程
  }
}

function startLive() {
  if (liveTimer) return
  liveTimer = setInterval(async () => {
    const task = selectedTask.value
    if (!task || !isActiveStatus(task.status)) return
    // 任务状态走 SSE；只有推送没连上时才退回轮询。日志仍要按需拉取（SSE 不推日志）。
    if (shouldPoll(liveStatus.value)) await loadTasks()
    await loadLiveLogs()
    if (task.startedAt) live.elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt)) / 1000))
  }, 3000)
}

function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null }
}

async function loadTasks() {
  try {
    state.tasks = await listTasks(user.getSnapshot(), 20)
    if (!state.taskId) {
      const done = state.tasks.find((task) => task.status === 'SUCCEEDED' && task.metrics)
      state.taskId = done?.id || state.tasks[0]?.id || null
    }
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

function next() {
  state.error = ''
  step.value = Math.min(STEPS.length, step.value + 1)
  if (step.value >= 2 && !state.tasks.length) void loadTasks()
}

function back() {
  state.error = ''
  step.value = Math.max(1, step.value - 1)
}

watch(() => workspace.active?.id, (id) => {
  if (id) void loadDatasets()
}, { immediate: true })

onMounted(async () => {
  startLive()
  await loadModels()
  await loadTasks()
})
onBeforeUnmount(() => { events.close(); stopLive(); releaseImages() })
</script>

<template>
  <div class="stack wide-gap wizard-page">
    <Teleport to="#page-heading-actions">
      <button type="button" class="manual-button" @click="openManual">用户手册</button>
    </Teleport>
    <section class="panel">
      <div class="wizard-head">
        <div>
          <div class="wizard-title-row">
            <div>
              <p class="eyebrow">TRAIN WIZARD</p>
              <h2>训练模型</h2>
            </div>

          </div>

        </div>
        <div class="wizard-steps">
          <button v-for="(label, index) in STEPS" :key="label" type="button" class="wizard-step"
                  :class="{ active: step === index + 1, done: step > index + 1 }" @click="step = index + 1">
            <span>{{ index + 1 }}</span>{{ label }}
          </button>
        </div>
      </div>
      <p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" class="notice" role="status">{{ state.notice }}</p>
    </section>

    <!-- ① 数据集 -->
    <section v-if="step === 1" class="wizard-grid">
      <div class="panel">
        <h3>选择数据</h3>
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
        <div v-if="state.stats" class="split-bar">
          <div v-for="row in splitRows" :key="row.key" class="split-seg" :class="'seg-' + row.key.toLowerCase()"
               :style="{ width: Math.max(2, row.percent) + '%' }">
            {{ row.key }} {{ row.count }}
          </div>
        </div>
        <p class="muted" v-if="state.stats">训练样本 {{ trainSamples }} 条，用于耗时估算。</p>
        <p class="muted" v-else>未选版本时按内置 MNIST 60,000 条估算。</p>

        <h3>样本预览</h3>
        <div class="wizard-samples">
          <figure v-for="item in state.samples" :key="item.id" class="wizard-sample">
            <img v-if="imageUrls[item.id]" :src="imageUrls[item.id]" :alt="'样本 ' + item.label" />
            <span v-else class="sample-placeholder">无图</span>
            <figcaption>{{ item.label }}</figcaption>
          </figure>
          <p v-if="!state.samples.length" class="muted inline-hint">选一个版本后显示缩略图</p>
        </div>
      </div>
    </section>

    <!-- ② 参数 -->
    <section v-if="step === 1" class="wizard-params">
      <div class="panel wizard-form">
        <div class="template-bar">
          <span class="muted">参数模板：</span>
          <button type="button" @click="applyTemplate('quick')">快速上手</button>
          <button type="button" @click="applyTemplate('accurate')">高精度</button>
          <button type="button" @click="applyTemplate('robust')">手机笔迹鲁棒</button>
        </div>
        <div v-for="group in PARAM_SCHEMA" :key="group.id" class="param-group">
          <h3 class="group-head" @click="openGroups[group.id] = !openGroups[group.id]">
            <span>{{ openGroups[group.id] ? '▾' : '▸' }} {{ group.title }}</span>
            <small class="muted">{{ groupSummary(group) }}</small>
          </h3>
          <template v-if="openGroups[group.id]">
          <template v-for="item in group.items" :key="item.key">
            <div v-if="isVisible(item, config)" class="param-line">
              <label :for="'p-' + item.key">
                {{ item.label }} <button type="button" class="help" :title="item.help" @click.stop="openHelp(item)">ⓘ</button>
                <span v-if="item.displayOnly" class="readonly-badge" title="当前训练管线固定，只参与估算">仅估算</span>
              </label>
              <select v-if="item.widget === 'select'" :id="'p-' + item.key" v-model="config[item.key]"
                      @change="item.key === 'arch' && applyPreset(config.arch)">
                <template v-if="item.options?.from === 'archPresets'">
                  <option v-for="preset in ARCH_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
                </template>
                <template v-else-if="item.options?.from === 'datasetVersions'">
                  <option :value="null">不使用版本</option>
                  <option v-for="version in state.versions" :key="version.id" :value="version.id">{{ version.version }}</option>
                </template>
                <template v-else-if="item.options?.from === 'models'">
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

          <div v-if="group.id === 'structure'" class="layer-editor">
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
          </template>
        </div>
      </div>

    </section>

    <!-- ③ 监控 -->
    <section v-if="step === 2" class="panel">
      <div class="section-heading">
        <div><h3>训练监控</h3><p class="muted">任务状态走实时推送（SSE），断线时自动退回轮询；日志按需拉取。表格与曲线是逐轮指标的真实数据。</p></div>
        <label>任务
          <select v-model="state.taskId">
            <option v-for="task in state.tasks" :key="task.id" :value="task.id">#{{ task.id }} · {{ task.status }}</option>
          </select>
        </label>
      </div>
      <template v-if="selectedTask">
        <div class="live-strip">
          <span class="live-dot" :class="selectedTask.status"></span>
          <strong>{{ selectedTask.status }}</strong>
          <span v-if="live.elapsed">已运行 {{ live.elapsed }}s</span>
          <span v-if="taskHistory.length">第 {{ taskHistory.length }} / {{ config.epochs }} 轮</span>
          <span v-if="selectedTask.status === 'QUEUED'" class="muted">排队中，等待 worker 取任务</span>
          <span v-if="selectedTask.status === 'RUNNING' && !taskHistory.length" class="muted">准备数据 / 第一轮计算中</span>
          <span class="muted">{{ liveStateLabel }}</span>
        </div>
        <div v-if="live.logs" class="live-logs">
          <div class="block-head"><h4>实时日志（最近 120 行）</h4></div>
          <pre>{{ live.logs }}</pre>
        </div>
        <TrainingCurve :task-id="state.taskId" :history="taskHistory" :height="320" />
        <StepCurve v-if="selectedTask?.metrics?.stepSeries?.length" :metrics="selectedTask.metrics" :height="220" />
        <p v-if="overfit?.overfit" class="hint-banner">⚠ {{ overfit.message }}</p>
        <div class="wizard-metrics">
          <div v-for="card in taskDetailView.cards.slice(0, 6)" :key="card.key" class="estimate-card">
            <small>{{ card.label }}</small><strong>{{ card.value }}</strong>
          </div>
        </div>
        <div class="table-wrap" v-if="taskDetailView.hasHistory">
          <table>
            <thead><tr><th>轮次</th><th>损失</th><th>MNIST</th><th>画板</th><th>照片</th><th>耗时</th></tr></thead>
            <tbody>
              <tr v-for="row in taskDetailView.rows" :key="row.epoch">
                <td>{{ row.epoch }}</td>
                <td>{{ row.loss ?? '—' }}</td>
                <td>{{ row.mnist === null ? '—' : row.mnist + '%' }}</td>
                <td>{{ row.canvas === null ? '—' : row.canvas + '%' }}</td>
                <td>{{ row.photo === null ? '—' : row.photo + '%' }}</td>
                <td>{{ row.durationMs === null ? '—' : row.durationMs + ' ms' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">该任务没有逐轮指标。</p>
      </template>
      <p v-else class="muted">还没有训练任务。</p>
    </section>

    <!-- ④ 评估 -->
    <section v-if="step === 2" class="panel">
      <div class="section-heading">
        <div><h3>评估</h3><p class="muted">同一个任务的三域准确率、每类准确率与混淆矩阵。</p></div>
        <label>任务
          <select v-model="state.taskId">
            <option v-for="task in state.tasks" :key="task.id" :value="task.id">#{{ task.id }} · {{ task.status }}</option>
          </select>
        </label>
      </div>
      <template v-if="selectedTask">
        <div class="wizard-metrics">
          <div class="estimate-card"><small>MNIST</small><strong>{{ selectedTask.metrics?.after?.raw_mnist_1000 !== undefined ? (selectedTask.metrics.after.raw_mnist_1000 * 100).toFixed(1) + '%' : '—' }}</strong></div>
          <div class="estimate-card"><small>画板模拟</small><strong>{{ selectedTask.metrics?.after?.canvas_simulated_1000 !== undefined ? (selectedTask.metrics.after.canvas_simulated_1000 * 100).toFixed(1) + '%' : '—' }}</strong></div>
          <div class="estimate-card"><small>照片模拟</small><strong>{{ selectedTask.metrics?.after?.photo_simulated_1000 !== undefined ? (selectedTask.metrics.after.photo_simulated_1000 * 100).toFixed(1) + '%' : '—' }}</strong></div>
          <div class="estimate-card"><small>模型版本</small><strong>{{ selectedTask.modelVersion || '—' }}</strong></div>
        </div>
        <TrainingMatrix :metrics="selectedTask.metrics" />
      </template>
      <p v-else class="muted">还没有训练任务。</p>
    </section>

    <div class="wizard-footer panel">
      <button :disabled="step === 1" @click="back">上一步</button>
      <span class="muted">config_hash {{ state.hash }}</span>
      <button v-if="step === 1" class="primary" :disabled="state.submitting || blocking || !state.datasetId" @click="submitTraining">
        {{ state.submitting ? '提交中…' : '开始训练' }}
      </button>
      <button v-if="step === 1" :disabled="blocking" @click="next">查看监控</button>
      <button v-else class="primary" @click="step = 1">回到第一步</button>
    </div>
  </div>
    <div v-if="help.open" class="modal-mask" @click.self="closeHelp">
      <section class="modal-card help-card">
        <header class="modal-head">
          <div>
            <h3>{{ help.item ? help.item.label : '训练模型 · 参数用户手册' }}</h3>
            <p class="muted">{{ help.item ? (help.item.displayOnly ? '仅参与估算，不影响真实训练' : '真实参与训练') : '点每个参数旁的 ⓘ 看单条详细说明' }}</p>
          </div>
          <button class="link" @click="closeHelp">关闭</button>
        </header>

        <div v-if="help.item" class="help-detail">
          <p v-for="line in help.item.detail.split('\n')" :key="line">{{ line }}</p>
          <p class="muted">当前取值：{{ config[help.item.key] }}</p>
        </div>

        <div v-else class="help-groups">
          <article class="flow-article">
            <h4>整体流程（先看这里）</h4>
            <p class="muted">训练不是一步完成的：先在数据集页把数据准备好，再来这里选版本和调参，最后到训练记录与模型管理页看结果。</p>
            <ol class="flow-list">
              <li>
                <strong>准备数据</strong>
                <p>数据集页 → 新建数据集 → 导入数据集（文件夹 / CSV / 文件名 / zip / 带框多位数 / IDX）。导入成功后会自动生成一个版本。</p>
                <p><router-link to="/datasets">去数据集页</router-link></p>
              </li>
              <li>
                <strong>选数据版本</strong>
                <p>本页第 ① 步：选数据集 + 版本。版本是快照，之后补的样本不会自动进来，要重新生成版本。</p>
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
                <p>点「开始训练」立即返回任务号；数据准备（导出/复用）在后台进行，页面不再卡住。</p>
              </li>
              <li>
                <strong>看进度与结果</strong>
                <p>本页下方能看到逐轮准确率与损失；历史任务到「训练记录」页看曲线与三域评估。</p>
                <p><router-link to="/training">去训练记录</router-link></p>
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
              <p>先看「训练记录」里任务详情：准备数据阶段没有逐轮输出，属正常；几十秒到几分钟取决于版本大小与是否命中导出缓存。</p>
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
</template>
