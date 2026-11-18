<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { listDatasets, listVersions, sampleImage, versionSamples, versionStats } from '@/api/datasets.js'
import { createTask, listTasks } from '@/api/training.js'
import { listModels } from '@/api/models.js'
import { taskDetail } from '@/training/detail.js'
import TrainingCurve from '@/training/TrainingCurve.vue'
import TrainingMatrix from '@/training/TrainingMatrix.vue'
import StepCurve from '@/training/StepCurve.vue'
import NetDiagram from '@/wizard/NetDiagram.vue'
import { ARCH_PRESETS, configHash, estimateMemory, estimateTiming, formatDuration, inferShapes, normalizeConfig, validateConfig } from '@/wizard/estimate.js'
import { PARAM_SCHEMA, defaultConfig, isVisible } from '@/wizard/schema.js'

const user = useUserStore()
const workspace = useWorkspaceStore()

const STEPS = ['数据集', '参数', '监控', '评估']
const step = ref(1)
const config = reactive({ ...defaultConfig(), layers: JSON.parse(JSON.stringify(ARCH_PRESETS[1].layers)) })
const state = reactive({
  datasets: [], versions: [], stats: null, samples: [], total: 0,
  tasks: [], taskId: null, hash: '', loading: false, error: '', notice: '',
  datasetId: null, models: [], submitting: false
})
const imageUrls = reactive({})
const errors = ref([])

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
const blocking = computed(() => checks.value.some((item) => item.level === 'error'))
const jsonPreview = computed(() => JSON.stringify(normalizeConfig(config), null, 2))
const selectedTask = computed(() => state.tasks.find((task) => String(task.id) === String(state.taskId)) || null)
const taskDetailView = computed(() => taskDetail(selectedTask.value))
const taskHistory = computed(() => selectedTask.value?.metrics?.history || [])
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
      patience: Number(config.patience) || 3
    }
    const created = await createTask(state.datasetId, payload, user.getSnapshot())
    state.taskId = created.id
    state.notice = `已提交训练任务 #${created.id}，切换到第③步查看进度`
    await loadTasks()
    step.value = 3
  } catch (error) {
    state.error = error?.message || '提交训练任务失败'
  } finally {
    state.submitting = false
  }
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
  if (step.value === 2 && blocking.value) {
    state.error = '参数存在错误，请先修正后再继续'
    return
  }
  state.error = ''
  step.value = Math.min(STEPS.length, step.value + 1)
  if (step.value >= 3 && !state.tasks.length) void loadTasks()
}

function back() {
  state.error = ''
  step.value = Math.max(1, step.value - 1)
}

onMounted(async () => {
  await loadDatasets()
  await loadModels()
  await loadTasks()
})
onBeforeUnmount(releaseImages)
</script>

<template>
  <div class="stack wide-gap wizard-page">
    <section class="panel">
      <div class="wizard-head">
        <div>
          <p class="eyebrow">TRAIN WIZARD</p>
          <h2>参数可视化（新）</h2>
          <p class="muted">四步向导：选数据 → 调参数（实时估算参数量/显存/耗时）→ 看训练 → 看评估。</p>
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
          <p v-if="!state.samples.length" class="muted">选一个版本后显示样本缩略图。</p>
        </div>
      </div>
      <aside class="panel">
        <h3>这一步在做什么</h3>
        <p class="muted">数据集版本是训练的快照，划分（训练/验证/测试）在建版本时已经定好。这里只选，不改。</p>
        <p class="muted">右侧继续后进入参数配置，所有改动都在浏览器里即时估算，不发请求。</p>
      </aside>
    </section>

    <!-- ② 参数 -->
    <section v-if="step === 2" class="wizard-params">
      <div class="panel wizard-form">
        <div v-for="group in PARAM_SCHEMA" :key="group.id" class="param-group">
          <h3>{{ group.title }}</h3>
          <template v-for="item in group.items" :key="item.key">
            <div v-if="isVisible(item, config)" class="param-line">
              <label :for="'p-' + item.key">{{ item.label }} <span class="help" :title="item.help">ⓘ</span></label>
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
              <input v-else-if="item.widget === 'switch'" :id="'p-' + item.key" type="checkbox" class="switch-input" v-model="config[item.key]" />
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
        </div>
      </div>

      <aside class="stack">
        <section class="panel">
          <h3>结构图</h3>
          <NetDiagram :layers="layers" />
        </section>
        <section class="panel">
          <h3>实时估算</h3>
          <div class="estimate-cards">
            <div class="estimate-card"><small>参数量</small><strong>{{ shapes.totalParams.toLocaleString() }}</strong></div>
            <div class="estimate-card"><small>显存</small><strong>{{ memory.toFixed(2) }} GB</strong></div>
            <div class="estimate-card"><small>单 epoch</small><strong>{{ formatDuration(timing.epochSeconds) }}</strong></div>
            <div class="estimate-card"><small>总耗时</small><strong>{{ formatDuration(timing.totalSeconds) }}</strong></div>
          </div>
          <p class="muted">单步约 {{ timing.stepMs.toFixed(1) }} ms · {{ timing.steps }} 步/轮 · 训练样本 {{ trainSamples }}</p>
        </section>
        <section class="panel">
          <h3>校验</h3>
          <ul class="check-list">
            <li v-for="(check, index) in checks" :key="index" :class="'check-' + check.level">
              <span>{{ check.level === 'ok' ? '✓' : check.level === 'warn' ? '⚠' : '✗' }}</span>{{ check.text }}
            </li>
          </ul>
        </section>
        <section class="panel">
          <h3>配置摘要</h3>
          <pre class="json-preview">{{ jsonPreview }}</pre>
          <p class="muted">config_hash: {{ state.hash }}</p>
        </section>
      </aside>
    </section>

    <!-- ③ 监控 -->
    <section v-if="step === 3" class="panel">
      <div class="section-heading">
        <div><h3>训练监控</h3><p class="muted">复用真实训练任务的逐轮指标；这是历史任务回放，不是实时推送。</p></div>
        <label>任务
          <select v-model="state.taskId">
            <option v-for="task in state.tasks" :key="task.id" :value="task.id">#{{ task.id }} · {{ task.status }}</option>
          </select>
        </label>
      </div>
      <template v-if="selectedTask">
        <TrainingCurve :task-id="state.taskId" :history="taskHistory" :height="320" />
        <StepCurve v-if="selectedTask?.metrics?.stepSeries?.length" :metrics="selectedTask.metrics" :height="220" />
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
    <section v-if="step === 4" class="panel">
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
      <button v-if="step === 2" class="primary" :disabled="state.submitting || blocking || !state.datasetId" @click="submitTraining">
        {{ state.submitting ? '提交中…' : '开始训练' }}
      </button>
      <button v-if="step < STEPS.length" :disabled="step === 2 && blocking" @click="next">下一步</button>
      <button v-else class="primary" @click="step = 1">回到第一步</button>
    </div>
  </div>
</template>
