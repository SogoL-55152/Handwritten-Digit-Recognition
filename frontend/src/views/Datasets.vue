<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { allVersions, buildVersion, cancelImportJob, claimSamples, createDataset, createImportJob, deleteDataset, deleteVersion, importBatches, importJob, importSamples, inspectDataset, listDatasets, listVersions, removeVersionSample, rollbackBatch, sampleImage, uploadFolder, versionSamples, versionStats, wizardPreview, wizardZipPreview } from '@/api/datasets.js'
import { buildPayload, labelRows, nextVersion, splitHints, splitRows, splitSourceOptions } from '@/datasets/format.js'
import { batchOf, groupByFolder, importSummary, progressText } from '@/datasets/import.js'
import { jobPercent, isTerminalJob, jobStatusText } from '@/datasets/job.js'

const user = useUserStore()
const workspace = useWorkspaceStore()

const state = reactive({
  loading: false, busy: false, samplesLoading: false, error: '', notice: '',
  datasets: [], selectedId: null,
  versions: [], selectedVersionId: null,
  stats: null, samples: [], total: 0, page: 1, size: 12, split: '', label: '',
  creating: false, createForm: { name: '', description: '' },
  folder: { busy: false, progress: '', result: null },
  wizard: { open: false, busy: false, directory: '', preview: null, result: null, batches: [], zipFile: null, progress: 0, csvMapping: { fileColumn: '', labelColumn: '' }, job: null },
  importSource: 'folder', localPreview: null, picked: null, upload: { busy: false, error: '', token: '', preview: null, detection: '' },
  sources: [], sourceOptions: [], sourceLimit: 20, sourceMode: 'SELF', sourceQuery: '',
  labelOpen: false, manualOpen: false,
  buildForm: { version: 'v1', splitRule: 'RANDOM', valPercent: 15, testPercent: 15, label: '', kind: '', preserveSplitFrom: 0 }
})
const imageUrls = reactive({})

const snapshot = () => ({ workspaceId: Number(workspace.active?.id || 0), session: user.getSnapshot() })

/** 文件夹选择用的隐藏 input（点击主按钮时触发）。 */
const folderInput = ref(null)

/** 三种来源各自适配哪些数据集形态（弹窗里直接显示，避免选错入口）。 */
const SOURCE_NOTES = {
  server: {
    suits: ['按 0–9 分文件夹', 'CSV（name,label）', '文件名带标签', '带框多位数（digitStruct.mat）', 'IDX（MNIST / EMNIST）'],
    limits: '数据在服务器磁盘上；不受 5MB/张、200 张/批限制，几万张也能导；IDX 与带框多位数只有这个入口支持。'
  },
  zip: {
    suits: ['按 0–9 分文件夹', 'CSV（name,label）', '文件名带标签', '带框多位数（digitStruct.mat）', 'IDX（MNIST / EMNIST）'],
    limits: '数据在别的机器上，需要打包上传；zip ≤500MB，解压后按目录结构自动识别；文件多时上传较慢。'
  },
  folder: {
    suits: ['按 0–9 分文件夹（只支持这一种）'],
    limits: '浏览器直接读取本机文件夹；单张 ≤5MB、单批 20 张、一次最多 200 张；不支持 CSV / 文件名标签 / 带框多位数 / IDX。'
  }
}
const selectedDataset = computed(() => state.datasets.find((item) => item.id === state.selectedId) || null)
const selectedVersion = computed(() => state.versions.find((item) => item.id === state.selectedVersionId) || null)

/** 导入只允许写自己的数据集：未选 / 公共数据集都要禁用并说明原因。 */
/** 样本来源搜索：按「数据集名 / 版本名」过滤，避免列表太长。 */
const filteredSourceOptions = computed(() => {
  const query = state.sourceQuery.trim().toLowerCase()
  if (!query) return state.sourceOptions
  return state.sourceOptions.filter((option) =>
    `${option.dataset_name || ''} ${option.version || ''}`.toLowerCase().includes(query))
})

const importBlocked = computed(() => {
  if (!state.selectedId) return '先在左侧选择一个数据集'
  if (selectedDataset.value?.scope === 'PUBLIC') return '公共数据集只读，不能导入样本'
  return ''
})
const labelList = computed(() => labelRows(state.stats))
const splitList = computed(() => splitRows(state.stats))
const hints = computed(() => splitHints(state.stats))
/** 可沿用划分的版本（同一个数据集里已就绪的版本，排除正在新建的名字） */
const splitSources = computed(() => splitSourceOptions(state.versions, state.buildForm.version))
const pages = computed(() => Math.max(1, Math.ceil(state.total / state.size)))
const splitClass = (key) => `split-${String(key).toLowerCase()}`

function releaseImages() {
  Object.values(imageUrls).forEach((url) => URL.revokeObjectURL(url))
  Object.keys(imageUrls).forEach((key) => delete imageUrls[key])
}

async function loadImages(items) {
  const snap = snapshot()
  for (const item of items) {
    try {
      const blob = await sampleImage(snap, state.selectedVersionId, item.id)
      imageUrls[item.id] = URL.createObjectURL(blob)
    } catch (error) {
      /* 单张失败不影响其它缩略图 */
    }
  }
}

async function loadDatasets() {
  if (!workspace.active?.id) return  // 空间还没核验完，等 watch 触发
  state.loading = true
  state.error = ''
  try {
    state.datasets = await listDatasets(snapshot())
    if (!state.selectedId && state.datasets.length) {
    const own = state.datasets.find((item) => item.scope !== 'PUBLIC') || state.datasets[0]
    await selectDataset(own.id)
  }
  } catch (error) {
    state.error = error?.message || '数据集加载失败'
  } finally {
    state.loading = false
  }
}

async function selectDataset(id) {
  state.selectedId = id
  state.selectedVersionId = null
  state.stats = null
  state.samples = []
  state.total = 0
  releaseImages()
  try {
    state.versions = await listVersions(snapshot(), id)
    await loadSourceOptions()
    state.buildForm.version = nextVersion(state.versions)
    if (state.versions.length) await selectVersion(state.versions[0].id)
  } catch (error) {
    state.error = error?.message || '版本加载失败'
  }
}

async function selectVersion(id) {
  state.selectedVersionId = id
  state.page = 1
  releaseImages()
  await loadVersionData()
}

async function loadVersionData() {
  if (!state.selectedVersionId) return
  state.samplesLoading = true
  try {
    state.stats = await versionStats(snapshot(), state.selectedVersionId)
    const data = await versionSamples(snapshot(), state.selectedVersionId, {
      page: state.page, size: state.size, split: state.split, label: state.label
    })
    state.samples = data.items || []
    state.total = data.total || 0
    await loadImages(state.samples)
  } catch (error) {
    state.error = error?.message || '版本数据加载失败'
  } finally {
    state.samplesLoading = false
  }
}

async function create() {
  if (state.busy) return
  state.busy = true
  state.error = ''
  state.notice = ''
  try {
    const created = await createDataset(snapshot(), {
      name: String(state.createForm.name || '').trim(),
      description: String(state.createForm.description || '').trim()
    })
    state.notice = `已创建数据集「${created.name}」`
    state.createForm = { name: '', description: '' }
    state.creating = false
    await loadDatasets()
    await selectDataset(created.id)
  } catch (error) {
    state.error = error?.message || '创建数据集失败'
  } finally {
    state.busy = false
  }
}

async function loadSourceOptions() {
  try {
    state.sourceOptions = await allVersions(snapshot())
  } catch (error) {
    state.sourceOptions = []
  }
}

function toggleSource(versionId) {
  const index = state.sources.findIndex((item) => item.versionId === versionId)
  if (index >= 0) state.sources.splice(index, 1)
  else state.sources.push({ versionId, limit: state.sourceLimit, labels: [] })
}

function pickFolder(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length) return
  const { groups, ignored, noLabel } = groupByFolder(files)
  const labels = Object.keys(groups).filter((digit) => groups[digit].length).map(Number).sort((a, b) => a - b)
  if (!labels.length) {
    state.error = '没有找到按 0–9 命名的子目录（例如 0/xxx.png）'
    return
  }
  state.error = ''
  state.picked = { files, groups, labels, ignored, noLabel }
  state.localPreview = {
    format: 'folder',
    total: labels.reduce((sum, digit) => sum + groups[digit].length, 0),
    labels: Object.fromEntries(labels.map((digit) => [String(digit), groups[digit].length])),
    skipped: ignored + noLabel,
    skippedDetail: { '非图片': ignored, '目录名不是 0–9': noLabel },
    note: '本机文件夹：按 0–9 子目录上传（单批 20 张）'
  }
}

async function uploadPickedFolder() {
  const picked = state.picked
  if (!picked || !state.selectedId) return
  state.busy = true
  state.error = ''
  state.folder = { busy: true, progress: '', result: null }
  const results = []
  try {
    for (let index = 0; index < picked.labels.length; index += 1) {
      const digit = picked.labels[index]
      const batches = batchOf(picked.groups[digit], 20)
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        state.folder.progress = progressText({
          label: digit, labelIndex: index + 1, labelCount: picked.labels.length,
          batchIndex: batchIndex + 1, batchCount: batches.length
        })
        results.push(await importSamples(snapshot(), state.selectedId, digit, batches[batchIndex]))
      }
    }
    const summary = importSummary(results)
    state.folder = { busy: false, progress: '', result: { ...summary, ignored: picked.ignored, noLabel: picked.noLabel, labels: picked.labels.length } }
    state.notice = `目录导入：成功 ${summary.imported} · 重复 ${summary.duplicates} · 失败 ${summary.failed}`
    await loadDatasets()
  } catch (error) {
    state.folder = { busy: false, progress: '', result: null }
    state.error = error?.message || '目录导入失败'
  } finally {
    state.busy = false
  }
}

async function inspectSamples() {
  if (!state.selectedId) return
  state.busy = true
  state.error = ''
  try {
    const result = await inspectDataset(snapshot(), state.selectedId, 50)
    state.notice = `巡检完成：本轮检查 ${result.checked} 张，发现多位数 ${result.multi} 张；剩余未巡检 ${result.remaining} 张`
    await loadVersionData()
  } catch (error) {
    state.error = error?.message || '巡检失败'
  } finally {
    state.busy = false
  }
}

/** 导入成功后自动生成一个版本；失败不影响导入结果，只提示。 */
async function autoBuildVersion() {
  if (!state.selectedId) return
  const previous = state.error
  state.error = ''
  try {
    // 先刷新版本列表：保证新版本号 = 现有最新版本 + 1，且合并的是当前数据集的全部样本
    state.versions = await listVersions(snapshot(), state.selectedId)
    state.buildForm.version = nextVersion(state.versions)
    const payload = buildPayload({ ...state.buildForm })
    let version
    try {
      version = await buildVersion(snapshot(), state.selectedId, payload)
    } catch (error) {
      const message = String(error?.message || '')
      if (message.includes('书写者')) {
        // 只有一位书写者时按人划分会失败，自动回退到随机划分再试一次
        version = await buildVersion(snapshot(), state.selectedId, { ...payload, splitRule: 'RANDOM' })
      } else if (message.includes('已存在')) {
        state.buildForm.version = nextVersion([...state.versions, { version: payload.version }])
        version = await buildVersion(snapshot(), state.selectedId, { ...payload, version: state.buildForm.version })
      } else {
        throw error
      }
    }
    state.notice = `已合并生成新版本 ${version.version}：共 ${version.sampleCount} 条样本（含本次导入与历史样本）`
    await selectDataset(state.selectedId)
    await selectVersion(version.id)
  } catch (error) {
    state.error = (previous ? previous + '；' : '') + `导入成功，但自动生成版本失败：${error?.message || '未知错误'}，请手动点「生成版本」`
  }
}

async function claimRecognition() {
  if (!state.selectedId) return
  state.busy = true
  state.error = ''
  try {
    const result = await claimSamples(snapshot(), state.selectedId)
    state.notice = `已把 ${result.claimed} 条识别采集样本归入本数据集`
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '归入失败'
  } finally {
    state.busy = false
  }
}

async function removeDataset() {
  const dataset = selectedDataset.value
  if (!dataset) return
  if (!window.confirm(`确定删除数据集「${dataset.name}」？版本与样本归属会一起删除，采集池里的图片不受影响。`)) return
  state.busy = true
  state.error = ''
  try {
    await deleteDataset(snapshot(), dataset.id)
    state.notice = `已删除数据集「${dataset.name}」`
    state.selectedId = null
    state.versions = []
    state.stats = null
    state.samples = []
    releaseImages()
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '删除失败'
  } finally {
    state.busy = false
  }
}

async function removeSample(item) {
  if (!state.selectedId || !state.selectedVersionId) return
  state.busy = true
  state.error = ''
  try {
    await removeVersionSample(snapshot(), state.selectedId, state.selectedVersionId, item.sampleId)
    state.notice = '样本已删除'
    await loadVersionData()
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '删除样本失败'
  } finally {
    state.busy = false
  }
}

async function removeVersion() {
  const version = selectedVersion.value
  if (!version || !state.selectedId) return
  state.busy = true
  state.error = ''
  try {
    await deleteVersion(snapshot(), state.selectedId, version.id)
    state.notice = `已删除版本 ${version.version}`
    state.selectedVersionId = null
    state.stats = null
    state.samples = []
    await selectDataset(state.selectedId)
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '删除版本失败'
  } finally {
    state.busy = false
  }
}

async function loadBatches() {
  try {
    state.wizard.batches = await importBatches(snapshot())
  } catch (error) {
    state.wizard.batches = []
  }
}

async function openWizard() {
  state.wizard.open = true
  state.importSource = 'server'
  state.wizard.preview = null
  state.wizard.result = null
  state.localPreview = null
  state.picked = null
  state.error = ''
  if (!state.wizard.batches.length) await loadBatches()
}

function closeWizard() {
  stopJobPolling()
  state.wizard.job = null
  state.wizard.open = false
  state.wizard.preview = null
  state.localPreview = null
  state.picked = null
}

function chooseSource(source) {
  state.importSource = source
  state.wizard.preview = null
  state.localPreview = null
  state.picked = null
}

/** 本地粗判文件夹类型，上传前先告诉用户识别到了什么。 */
function detectLocal(files) {
  const names = files.map((file) => (file.webkitRelativePath || file.name).replace(/\\/g, '/'))
  const hasDirs = names.some((name) => /(^|\/)[0-9]\/[^/]+$/.test(name))
  const hasCsv = names.some((name) => /\.csv$/i.test(name))
  const hasMat = names.some((name) => /digitstruct\.mat$/i.test(name))
  const hasIdx = names.some((name) => /-images-idx3-ubyte(\.gz)?$/i.test(name))
    && names.some((name) => /-labels-idx1-ubyte(\.gz)?$/i.test(name))
  if (hasDirs) return '按 0–9 分文件夹'
  if (hasMat) return '带框多位数（digitStruct.mat）'
  if (hasIdx) return 'IDX（MNIST / EMNIST）'
  if (hasCsv) return 'CSV 标签'
  if (names.some((name) => /(^|[^0-9])[0-9]([^0-9]|$)/.test(name.split('/').pop()))) return '文件名带标签'
  return '未识别到标签来源'
}

async function uploadSelectedFolder(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length) return
  if (!state.selectedId) { state.error = '请先在左侧选择一个数据集'; return }
  const paths = files.map((file) => file.webkitRelativePath || file.name)
  state.upload = { busy: true, error: '', token: '', preview: null, detection: detectLocal(files) }
  state.error = ''
  try {
    const result = await uploadFolder(snapshot(), files, paths)
    state.upload = {
      busy: false, error: '', token: result.token, preview: result.preview,
      detection: state.upload.detection
    }
    state.wizard.preview = result.preview
  } catch (error) {
    state.upload = { busy: false, error: error?.message || '上传识别失败', token: '', preview: null, detection: '' }
  }
}

/** 浏览器上传的文件夹同样走异步任务（任务结束后自动清理临时目录）。 */
const confirmUpload = () => {
  if (!state.upload.token || !state.selectedId) return
  return startJob({ token: state.upload.token, sourceKind: 'UPLOAD' })
}

async function previewWizard() {
  if (!state.wizard.directory.trim()) return
  state.wizard.busy = true
  state.error = ''
  state.wizard.result = null
  try {
    state.wizard.preview = await wizardPreview(snapshot(), state.wizard.directory.trim(), state.wizard.csvMapping)
    syncCsvMapping()
  } catch (error) {
    state.error = error?.message || '试运行失败'
  } finally {
    state.wizard.busy = false
  }
}

/** 预览回来后，把后端解析出的列名回填到下拉，用户可改完再试运行。 */
function syncCsvMapping() {
  const csv = state.wizard.preview?.csv
  if (!csv) return
  state.wizard.csvMapping = {
    fileColumn: csv.fileColumn || state.wizard.csvMapping.fileColumn || '',
    labelColumn: csv.labelColumn || state.wizard.csvMapping.labelColumn || ''
  }
}

function resetCsvMapping() {
  state.wizard.csvMapping = { fileColumn: '', labelColumn: '' }
}

async function previewZip(event) {
  const file = (event.target.files || [])[0]
  event.target.value = ''
  if (!file) return
  if (!/\.zip$/i.test(file.name)) {
    state.error = '请选择 .zip 压缩包'
    return
  }
  if (file.size > 500 * 1024 * 1024) {
    state.error = `zip 有 ${(file.size / 1024 / 1024).toFixed(0)}MB，超过 500MB 上限，请拆分后再导入`
    return
  }
  state.wizard.busy = true
  state.wizard.progress = 0
  state.error = ''
  state.wizard.result = null
  try {
    state.wizard.preview = await wizardZipPreview(snapshot(), file, (value) => { state.wizard.progress = value })
  } catch (error) {
    state.error = error?.message === 'Network Error'
      ? `zip 上传中断（文件 ${(file.size / 1024 / 1024).toFixed(0)}MB），请确认后端在运行且网络稳定`
      : (error?.message || 'zip 试运行失败')
  } finally {
    state.wizard.busy = false
    state.wizard.progress = 0
  }
}

// ---------- 异步导入任务：创建 → 轮询进度 → 可取消 ----------
let jobTimer = null

function stopJobPolling() {
  if (jobTimer) { clearInterval(jobTimer); jobTimer = null }
}

async function startJob(body) {
  stopJobPolling()
  state.wizard.busy = true
  state.error = ''
  state.wizard.result = null
  try {
    state.wizard.job = await createImportJob(snapshot(), state.selectedId, body)
    jobTimer = setInterval(pollJob, 1000)
  } catch (error) {
    state.wizard.busy = false
    state.error = error?.message || '创建导入任务失败'
  }
}

async function pollJob() {
  const current = state.wizard.job
  if (!current) { stopJobPolling(); return }
  try {
    const job = await importJob(snapshot(), current.id)
    state.wizard.job = job
    if (isTerminalJob(job.status)) {
      stopJobPolling()
      await settleJob(job)
    }
  } catch (error) {
    stopJobPolling()
    state.wizard.busy = false
    state.error = error?.message || '查询导入进度失败'
  }
}

async function settleJob(job) {
  state.wizard.busy = false
  if (job.status === 'FAILED') {
    state.error = job.errorMessage || '导入失败'
    return
  }
  state.wizard.result = { imported: job.imported, duplicates: job.duplicates, failed: job.failed }
  state.notice = jobStatusText(job)
  if (job.sourceKind === 'UPLOAD') {
    state.upload = { busy: false, error: '', token: '', preview: null, detection: '' }
  }
  state.wizard.preview = null
  await loadDatasets()
  await loadBatches()
  // 与原来的"上传文件夹后自动建版本"保持一致，目录/zip 仍由用户手动建版本
  if (job.sourceKind === 'UPLOAD' && job.status === 'SUCCEEDED') await autoBuildVersion()
}

async function cancelJob() {
  if (!state.wizard.job) return
  try {
    state.wizard.job = await cancelImportJob(snapshot(), state.wizard.job.id)
  } catch (error) {
    state.error = error?.message || '取消失败'
  }
}

const commitZip = () => {
  if (!state.selectedId || !state.wizard.preview?.token) return
  return startJob({ token: state.wizard.preview.token, sourceKind: 'ZIP' })
}

const commitWizard = () => {
  if (!state.selectedId || !state.wizard.preview) return
  return startJob({
    directory: state.wizard.directory.trim(),
    sourceKind: 'DIRECTORY',
    fileColumn: state.wizard.csvMapping.fileColumn || null,
    labelColumn: state.wizard.csvMapping.labelColumn || null
  })
}

async function rollback(batch) {
  state.busy = true
  state.error = ''
  try {
    const result = await rollbackBatch(snapshot(), batch.id)
    state.notice = `已回滚批次 #${batch.id}，删除 ${result.deleted} 条样本`
    await loadBatches()
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '回滚失败'
  } finally {
    state.busy = false
  }
}

async function build() {
  if (state.busy || !state.selectedId) return
  state.busy = true
  state.error = ''
  state.notice = ''
  try {
    if (state.sourceMode === 'VERSIONS' && !state.sources.length) {
      state.error = '请至少勾选一个样本来源，或切回「本数据集的样本」'
      return
    }
    const payload = buildPayload(state.buildForm)
    if (state.sourceMode === 'VERSIONS') {
      payload.sources = state.sources.map((item) => ({ versionId: item.versionId, limit: item.limit }))
    }
    const version = await buildVersion(snapshot(), state.selectedId, payload)
    state.notice = `已生成版本 ${version.version}：${version.sampleCount} 条样本`
    await selectDataset(state.selectedId)
    await selectVersion(version.id)
  } catch (error) {
    state.error = error?.message || '生成版本失败'
  } finally {
    state.busy = false
  }
}

function gotoPage(page) {
  const target = Math.min(pages.value, Math.max(1, page))
  if (target === state.page) return
  state.page = target
  void loadVersionData()
}

function applyFilters() {
  state.page = 1
  void loadVersionData()
}

// 刷新后 workspace 是异步核验的：等它拿到 active 再请求，避免 workspaceId=0
watch(() => workspace.active?.id, (id) => {
  if (id) void loadDatasets()
}, { immediate: true })

onBeforeUnmount(() => { releaseImages(); stopJobPolling() })
</script>

<template>
  <div class="stack wide-gap dataset-page">
        <Teleport to="#page-heading-actions">
      <button type="button" class="manual-button" @click="state.manualOpen = true">用户手册</button>
    </Teleport>
    <header class="panel dataset-hero">
      <div>
        <p class="eyebrow">DATA</p>
        <h2>数据集</h2>
        <p class="muted">把采集到的样本整理成可训练、可评测的集合。版本是快照，划分默认按书写者隔离。</p>
      </div>
      <div class="row-actions">
        <button :disabled="state.loading || state.busy" @click="loadDatasets">刷新</button>
        <button :disabled="state.busy || !state.selectedId" title="先选中一个数据集" @click="openWizard">导入数据集</button>
        <button class="primary" :disabled="state.busy" @click="state.creating = !state.creating">{{ state.creating ? '取消' : '新建数据集' }}</button>
      </div>
    </header>

    <section v-if="state.creating" class="panel create-panel">
      <div class="field-row">
        <label class="field"><span>名称</span><input v-model="state.createForm.name" maxlength="64" placeholder="例如 自采-11月" /></label>
        <label class="field field-wide"><span>描述（可选）</span><input v-model="state.createForm.description" maxlength="255" placeholder="这批样本来自哪里、准备做什么" /></label>
      </div>
      <div class="row-actions">
        <button :disabled="state.busy" @click="state.creating = false">取消</button>
        <button class="primary" :disabled="state.busy || !state.createForm.name.trim()" @click="create">创建数据集</button>
      </div>
    </section>

    <div v-if="state.wizard.open" class="modal-mask" @click.self="closeWizard">
      <section class="modal-card import-modal">
        <header class="modal-head">
          <div>
            <h3>导入数据集</h3>
            <p class="muted">直接选文件夹即可：自动识别 0–9 子目录 / CSV / 文件名 / 带框多位数 / IDX</p>
          </div>
          <button class="link" @click="closeWizard">关闭</button>
        </header>

        <div class="import-box folder-first">
          <button type="button" class="primary" @click="folderInput?.click()">
            {{ state.upload.busy ? '上传识别中…' : '选择文件夹' }}
          </button>
          <span class="muted">选择后自动识别类型、试运行，不会立刻写库</span>
          <input ref="folderInput" type="file" webkitdirectory directory multiple hidden @change="uploadSelectedFolder" />
        </div>

        <p v-if="state.upload.detection && state.upload.busy" class="hint">本地判断：{{ state.upload.detection }}，正在上传…</p>
        <p v-if="state.upload.error" class="notice error">{{ state.upload.error }}</p>

        <details class="other-sources">
          <summary>其他导入方式（zip / 服务器目录）</summary>
          <div class="import-box">
            <label class="field"><span>上传 zip（≤500MB）</span>
              <input type="file" accept=".zip" @change="previewZip" />
            </label>
            <p v-if="state.wizard.progress" class="hint">上传中 {{ state.wizard.progress }}%…</p>
            <button v-if="!state.wizard.preview?.token" class="primary"
                    :disabled="state.wizard.busy || !state.selectedId || !state.wizard.preview" @click="commitWizard">
              {{ state.selectedId ? '确认导入（服务器目录）' : '先选中数据集' }}
            </button>
            <button v-else class="primary" :disabled="state.wizard.busy || !state.selectedId" @click="commitZip">确认导入（zip）</button>
          </div>
          <div class="import-box">
            <label class="field field-wide"><span>服务器目录（仅同机可用）</span>
              <input v-model="state.wizard.directory" placeholder="例如 D:\\datasets\\my-digits" />
            </label>
            <button :disabled="state.wizard.busy || !state.wizard.directory.trim()" @click="previewWizard">试运行</button>
          </div>
        </details>

        <div v-if="state.wizard.preview || state.upload.preview" class="wizard-report">
          <template v-for="preview in [state.upload.preview || state.wizard.preview]" :key="preview.format">
            <p><strong>格式：</strong>{{ preview.format }} — {{ preview.note }}</p>
            <p><strong>可导入：</strong>{{ preview.total }} 张<template v-if="preview.skipped"> ｜ 跳过 {{ preview.skipped }} 张</template></p>
            <div class="label-bars">
              <div v-for="(count, label) in preview.labels" :key="label" class="label-bar">
                <span class="label-name">{{ label }}</span>
                <span class="bar"><i :style="{ width: Math.max(2, (count / Math.max(1, preview.total)) * 100) + '%' }"></i></span>
                <span class="label-count">{{ count }}</span>
              </div>
            </div>
            <p v-if="preview.samples?.length" class="hint">示例：{{ preview.samples.join('、') }}</p>
            <p v-if="preview.selfCheck" class="hint-banner"
               :class="{ 'self-check-bad': preview.selfCheck.accepted === 0 || preview.selfCheck.multiCount > 0 }">
              {{ preview.selfCheck.multiCount > 0 ? '⚠ ' : '' }}抽样自检：{{ preview.selfCheck.note }}
            </p>
            <p v-if="preview.skippedDetail" class="hint">
              跳过原因：<template v-for="(value, key) in preview.skippedDetail" :key="key">{{ key }} {{ value }} ｜ </template>
            </p>

            <div v-if="preview.csv" class="csv-mapping">
              <p class="hint">
                CSV：{{ preview.csv.fileName }}（{{ preview.csv.rows }} 行）
                <template v-if="!preview.csv.matched"> ｜ <b>表头没匹配上，请手动选择下面两列</b></template>
                <template v-else-if="preview.csv.unmatched"> ｜ {{ preview.csv.unmatched }} 行标签不是 0–9，会被跳过</template>
              </p>
              <div class="csv-fields">
                <label>文件列
                  <select v-model="state.wizard.csvMapping.fileColumn">
                    <option value="">自动识别</option>
                    <option v-for="column in preview.csv.columns" :key="'f' + column" :value="column">{{ column }}</option>
                  </select>
                </label>
                <label>标签列
                  <select v-model="state.wizard.csvMapping.labelColumn">
                    <option value="">自动识别</option>
                    <option v-for="column in preview.csv.columns" :key="'l' + column" :value="column">{{ column }}</option>
                  </select>
                </label>
                <button :disabled="state.wizard.busy" @click="previewWizard">用这个映射重新试运行</button>
                <button :disabled="state.wizard.busy" @click="resetCsvMapping">恢复自动识别</button>
              </div>
            </div>

            <div v-if="preview.cutSamples?.length" class="cut-samples">
              <p class="hint-banner self-check-bad">
                ⚠ 下面这几张图里有两个以上数字，导入后会按单字存、标签必然错；先裁成单字再导入。
              </p>
              <div v-for="sample in preview.cutSamples" :key="sample.sample" class="cut-row">
                <img v-if="sample.thumbnail" :src="sample.thumbnail" :alt="sample.sample" class="cut-thumb" />
                <div class="cut-body">
                  <p class="cut-name">{{ sample.sample }}<template v-if="sample.text"> → 判读为 {{ sample.text }}</template></p>
                  <div class="cut-bar">
                    <span v-for="(digit, index) in sample.digits" :key="index" class="cut-seg"
                          :style="{ left: (digit.from * 100) + '%', width: Math.max(2, (digit.to - digit.from) * 100) + '%' }"
                          :title="`第 ${index + 1} 段：${digit.digit}（置信度 ${(digit.confidence * 100).toFixed(1)}%）`">
                      {{ digit.digit }}
                    </span>
                  </div>
                  <p class="hint">
                    按检测到的相对宽度示意（不是原图叠加框）：{{ sample.digits.map((d) => d.digit).join(' / ') }}
                  </p>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div v-if="state.wizard.job" class="import-job">
          <p class="import-job-status" :class="{ 'import-job-bad': state.wizard.job.status === 'FAILED' }">
            {{ jobStatusText(state.wizard.job) }}
          </p>
          <div v-if="jobPercent(state.wizard.job) !== null" class="import-job-bar"
               role="progressbar" :aria-valuenow="jobPercent(state.wizard.job)" aria-valuemin="0" aria-valuemax="100">
            <i :style="{ width: jobPercent(state.wizard.job) + '%' }"></i>
          </div>
          <div class="import-job-actions">
            <span class="muted">任务 #{{ state.wizard.job.id }} · {{ state.wizard.job.sourceKind }}</span>
            <button v-if="canCancelJob(state.wizard.job)" @click="cancelJob">取消导入</button>
          </div>
        </div>

        <p v-if="state.wizard.result" class="hint">
          导入完成：成功 {{ state.wizard.result.imported }} · 重复 {{ state.wizard.result.duplicates }} · 失败 {{ state.wizard.result.failed }}
        </p>
        <p v-if="state.folder.busy" class="hint">正在上传：{{ state.folder.progress || '准备中…' }}</p>
        <p v-if="importBlocked" class="notice modal-error" role="status">{{ importBlocked }}</p>
        <p v-if="state.error" class="notice error modal-error" role="alert">{{ state.error }}</p>

        <footer class="modal-foot">
          <button @click="closeWizard">取消</button>
          <button v-if="state.upload.token" class="primary" :disabled="state.wizard.busy || Boolean(importBlocked)" @click="confirmUpload">
            {{ importBlocked || '确认导入' }}
          </button>
          <button v-else-if="state.wizard.preview?.token" class="primary" :disabled="state.wizard.busy || Boolean(importBlocked)" @click="commitZip">确认导入（zip）</button>
          <button v-else class="primary" :disabled="state.wizard.busy || Boolean(importBlocked) || !state.wizard.preview" @click="commitWizard">
            {{ importBlocked || '确认导入' }}
          </button>
        </footer>
      </section>
    </div>

    <section v-if="state.wizard.batches.length && state.wizard.open" class="panel batch-panel">
      <div class="block-head"><h4>导入批次</h4><span class="muted">可回滚（样本未进入版本时）</span></div>
      <div v-for="batch in state.wizard.batches" :key="batch.id" class="batch-row">
        <span>#{{ batch.id }}</span>
        <span>{{ batch.dataset_name || batch.dataset_id }}</span>
        <span>{{ batch.format }}</span>
        <span>成功 {{ batch.imported }} · 跳过 {{ batch.skipped }}</span>
        <span class="muted">{{ batch.source }}</span>
        <button class="link" :disabled="state.busy" @click="rollback(batch)">回滚</button>
      </div>
    </section>
    <p v-if="state.folder.busy" class="notice" role="status">正在导入：{{ state.folder.progress || '准备中…' }}</p>
    <p v-if="state.folder.result" class="notice" role="status">
      {{ state.folder.result.hint }}（成功 {{ state.folder.result.imported }} · 重复 {{ state.folder.result.duplicates }}
      · 失败 {{ state.folder.result.failed }}<template v-if="state.folder.result.ignored"> · 跳过非图片 {{ state.folder.result.ignored }}</template><template v-if="state.folder.result.noLabel"> · 无标签目录 {{ state.folder.result.noLabel }}</template>）
    </p>
    <p v-if="!workspace.active?.id" class="notice" role="status">正在核验空间…</p>
    <p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" class="notice" role="status">{{ state.notice }}</p>

    <section class="dataset-layout">
      <aside class="panel dataset-list">
        <div class="list-head"><h3>我的数据集</h3><span class="count-pill">{{ state.datasets.length }}</span></div>
        <p v-if="state.loading" class="muted">正在加载…</p>
        <div v-else-if="!state.datasets.length" class="empty-hint">
          <strong>还没有数据集</strong>
          <p class="muted">新建一个，然后用采集到的样本生成第一个版本。</p>
        </div>
        <ul v-else>
          <li v-for="item in state.datasets" :key="item.id">
            <button type="button" class="dataset-item" :class="{ active: item.id === state.selectedId }" @click="selectDataset(item.id)">
              <span class="dataset-name">{{ item.name }}</span>
              <span class="dataset-desc">{{ item.description || '无描述' }}</span>
              <span class="dataset-meta"><i>训练 {{ item.trainSamples }}</i><i>测试 {{ item.testSamples }}</i></span>
            </button>
          </li>
        </ul>
      </aside>

      <div class="stack">
        <section v-if="selectedDataset" class="panel">
          <div class="dataset-head">
            <div>
              <h3>{{ selectedDataset.name }}</h3>
              <p class="muted">{{ selectedDataset.description || '无描述' }} · 范围 {{ selectedDataset.scope }}</p>
            </div>
            <div class="row-actions dataset-actions">
              <span class="tag">{{ state.versions.length }} 个版本</span>
              <button :disabled="state.busy" title="跑一次多位数检测，把疑似多数字的样本标出来" @click="inspectSamples">巡检多位数</button>
              <button v-if="user.isSuperAdmin" :disabled="state.busy" title="把识别页采集、尚无归属的样本归入本数据集" @click="claimRecognition">归入识别采集</button>
              <button class="danger" :disabled="state.busy" @click="removeDataset">删除数据集</button>
            </div>
          </div>

          <div class="version-chips" v-if="state.versions.length">
            <button type="button" class="danger" :disabled="state.busy || !state.selectedVersionId"
                    title="删除当前选中的版本" @click="removeVersion">删除当前版本</button>
            <button v-for="version in state.versions" :key="version.id" type="button"
                    :class="{ active: version.id === state.selectedVersionId }" @click="selectVersion(version.id)">
              <strong>{{ version.version }}</strong><span>{{ version.sampleCount }} 条</span>
              <em v-if="version.splitSourceId" class="cell-detail" :title="`划分沿用自版本 #${version.splitSourceId}`">
                沿用#{{ version.splitSourceId }}
              </em>
            </button>
          </div>

          <div class="build-panel">
            <div class="build-grid">
              <label class="field"><span>版本号</span><input v-model="state.buildForm.version" maxlength="16" /></label>
              <label class="field"><span>验证集 %</span><input v-model.number="state.buildForm.valPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>测试集 %</span><input v-model.number="state.buildForm.testPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>只看标签</span><input v-model="state.buildForm.label" type="number" min="0" max="9" placeholder="全部" /></label>
              <label class="field"><span>划分来源</span>
                <select v-model.number="state.buildForm.preserveSplitFrom">
                  <option :value="0">重新划分（默认）</option>
                  <option v-for="item in splitSources" :key="item.id" :value="item.id">{{ item.label }}</option>
                </select>
              </label>
              <button class="primary build-action" :disabled="state.busy" @click="build">{{ state.busy ? '生成中…' : '生成版本' }}</button>
            </div>
            <p class="hint">版本只包含导入到本数据集（或归入本数据集）的样本；其他数据集的样本不会混进来。版本一旦生成即为快照。</p>
            <p v-if="state.buildForm.preserveSplitFrom" class="hint-banner">
              沿用版本 #{{ state.buildForm.preserveSplitFrom }} 的划分：该版本里已有的样本保持原来的训练/验证/测试归属，
              只有这次新增的样本按上面的百分比重新分配。适合"补数据后重建"——测试集不会被洗掉，指标可跨版本比较。
            </p>
            <div class="source-picker">
              <div class="block-head"><h4>样本来源</h4><span class="muted">只加入你选中的内容；选「指定版本」时至少要勾一个版本</span></div>
              <div class="source-mode">
                <label><input type="radio" value="SELF" v-model="state.sourceMode" /> 本数据集的样本（导入/归入到这里的）</label>
                <label><input type="radio" value="VERSIONS" v-model="state.sourceMode" /> 指定版本合并</label>
              </div>
              <template v-if="state.sourceMode === 'VERSIONS'">
              <input v-model="state.sourceQuery" class="source-search" placeholder="搜索数据集或版本…" />
              <div class="source-list">
              <div v-for="option in filteredSourceOptions" :key="option.id" class="source-row">
                <input class="source-check" type="checkbox"
                       :checked="state.sources.some((item) => item.versionId === option.id)"
                       @change="toggleSource(option.id)" />
                <label class="source-label" @click="toggleSource(option.id)">
                  {{ option.dataset_name }} · {{ option.version }}（{{ option.sample_count }} 条）
                </label>
                <input v-if="state.sources.some((item) => item.versionId === option.id)" class="source-limit"
                       type="number" min="1" :value="state.sources.find((item) => item.versionId === option.id)?.limit"
                       @change="state.sources.find((item) => item.versionId === option.id).limit = Number($event.target.value)" />
                <span v-else class="source-limit muted">全部</span>
              </div>
              </div>
              <p v-if="!state.sourceOptions.length" class="muted">还没有其他可用版本。</p>
              <p v-else-if="!filteredSourceOptions.length" class="muted">没有匹配「{{ state.sourceQuery }}」的版本。</p>
              <p v-else-if="!state.sources.length" class="hint">至少勾选一个版本，否则无法生成版本。</p>
              </template>
            </div>
          </div>
        </section>

        <section v-if="selectedVersion && state.stats" class="panel">
          <div class="split-cards">
            <div v-for="row in splitList" :key="row.key" class="stat-card" :class="splitClass(row.key)">
              <small>{{ row.label }}</small><strong>{{ row.count }}</strong>
            </div>
            <div class="stat-card split-writer"><small>书写者</small><strong>{{ state.stats.version.writerCount }}</strong></div>
          </div>

          <p v-for="hint in hints" :key="hint" class="hint-banner">⚠ {{ hint }}</p>

          <div class="chart-block">
            <div class="block-head block-toggle" @click="state.labelOpen = !state.labelOpen">
              <h4>{{ state.labelOpen ? '▾' : '▸' }} 标签分布</h4>
              <span class="muted">共 {{ state.stats.version.sampleCount }} 条 · {{ state.labelOpen ? '点击收起' : '点击展开' }}</span>
            </div>
            <div v-show="state.labelOpen" class="label-bars">
              <div v-for="row in labelList" :key="row.label" class="label-bar">
                <span class="label-name">{{ row.label }}</span>
                <span class="bar"><i :style="{ width: Math.max(2, row.percent) + '%' }"></i></span>
                <span class="label-count">{{ row.count }} · {{ row.percent }}%</span>
              </div>
              <p v-if="!labelList.length" class="muted">该版本没有样本。</p>
            </div>
          </div>

          <div class="chart-block">
            <div class="block-head">
              <h4>样本</h4>
              <div class="sample-filters">
                <select v-model="state.split" @change="applyFilters" aria-label="按划分筛选">
                  <option value="">全部划分</option>
                  <option value="TRAIN">训练集</option>
                  <option value="VAL">验证集</option>
                  <option value="TEST">测试集</option>
                </select>
                <input v-model="state.label" type="number" min="0" max="9" placeholder="标签" aria-label="按标签筛选" @change="applyFilters" />
              </div>
              <span class="muted">共 {{ state.total }} 条 · {{ state.page }}/{{ pages }} 页</span>
            </div>

            <p v-if="state.samplesLoading" class="muted">正在加载样本…</p>
            <div v-else class="sample-grid">
              <figure v-for="item in state.samples" :key="item.id" class="sample-card">
                <div class="thumb">
                  <img v-if="imageUrls[item.id]" :src="imageUrls[item.id]" :alt="'样本 ' + item.label" />
                  <span v-else class="sample-placeholder">无图</span>
                  <span class="split-badge" :class="splitClass(item.split)">{{ item.split }}</span>
                  <span v-if="item.multiDigit" class="multi-badge" title="巡检怀疑这张图里有多个数字，建议删除">多位数?</span>
                  <button class="sample-delete" type="button" :disabled="state.busy"
                          title="从版本中删除该样本" @click.stop="removeSample(item)">×</button>
                </div>
                <figcaption>
                  <strong>{{ item.label }}</strong>
                  <small>{{ item.kind }}</small>
                </figcaption>
              </figure>
              <p v-if="!state.samples.length" class="muted">该筛选条件下没有样本。</p>
            </div>

            <div class="pager" v-if="state.total > state.size">
              <button :disabled="state.page <= 1" @click="gotoPage(state.page - 1)">上一页</button>
              <button :disabled="state.page >= pages" @click="gotoPage(state.page + 1)">下一页</button>
            </div>
          </div>
        </section>

        <section v-else-if="selectedDataset" class="panel empty-hint">
          <strong>这个数据集还没有版本</strong>
          <p class="muted">设置验证集/测试集比例后点「生成版本」，样本才会进入数据集。</p>
        </section>
      </div>
    </section>
  </div>

    <div v-if="state.manualOpen" class="modal-mask" @click.self="state.manualOpen = false">
      <section class="modal-card help-card">
        <header class="modal-head">
          <div>
            <h3>数据集 · 用户手册</h3>
            <p class="muted">从导入到训练的完整流程；先看流程，再看每个格式的规则。</p>
          </div>
          <button class="link" @click="state.manualOpen = false">关闭</button>
        </header>
        <div class="help-groups">
          <article class="flow-article">
            <h4>整体流程</h4>
            <ol class="flow-list">
              <li><strong>新建数据集</strong><p>点右上角「新建数据集」，起一个名字；导入的样本会归属到它。</p></li>
              <li><strong>导入样本</strong><p>选中数据集后点「导入数据集」，选择来源与格式，先「试运行」看统计，再确认导入。</p></li>
              <li><strong>自动建版本</strong><p>导入成功后会自动生成一个版本（快照）；也可以手动调整划分比例再建。</p></li>
              <li><strong>巡检多位数</strong><p>点「巡检多位数」把疑似多数字的样本标出来，在样本网格里删除。</p></li>
              <li><strong>去训练</strong><p>到「训练模型」页选择这个版本，设置参数后开始训练。</p></li>
            </ol>
          </article>

          <article>
            <h4>支持的导入格式</h4>
            <div class="help-row"><div class="help-row-head"><strong>按 0–9 分文件夹</strong></div><p>目录下每个子目录名是 0–9，图片放里面。</p></div>
            <div class="help-row"><div class="help-row-head"><strong>CSV 标签</strong></div><p>平铺图片 + <code>labels.csv</code>，两列为文件名与标签（0–9）。</p></div>
            <div class="help-row"><div class="help-row-head"><strong>文件名带标签</strong></div><p>取文件名里第一个孤立数字，如 <code>3_001.png</code>；<code>IMG_0001</code> 这类会被跳过。</p></div>
            <div class="help-row"><div class="help-row-head"><strong>带框多位数</strong></div><p>SVHN 风格的 <code>digitStruct.mat</code>，按框自动裁成单字。</p></div>
            <div class="help-row"><div class="help-row-head"><strong>IDX（MNIST / EMNIST）</strong></div><p>目录里有 <code>*-images-idx3-ubyte</code> 与 <code>*-labels-idx1-ubyte</code>（.gz 也支持）。</p></div>
            <div class="help-row"><div class="help-row-head"><strong>本机文件夹</strong></div><p>浏览器上传，只支持 0–9 子目录；单张 ≤5MB、单批 20 张、单次 ≤200 张。</p></div>
          </article>

          <article>
            <h4>版本与划分</h4>
            <div class="help-row"><p>版本是样本快照：生成后新导入的样本不会自动进来，要重新生成版本。</p></div>
            <div class="help-row"><p>划分默认按书写者隔离（避免同一人跨集合）；不足 3 位书写者时改用随机划分。</p></div>
            <div class="help-row"><p>样本很少时（≤3 条）全部划到训练集，否则训练集会为空、任务必然失败。</p></div>
          </article>

          <article>
            <h4>删除与回滚</h4>
            <div class="help-row"><p>导入后未进入版本的批次可以回滚（批次列表里的「回滚」）。</p></div>
            <div class="help-row"><p>版本一旦被训练任务使用就不能删（会提示 VERSION_IN_USE）。</p></div>
            <div class="help-row"><p>删除数据集会一并删除它导入的样本；从识别页归入的样本只解除归属，不删原图。</p></div>
          </article>
        </div>
        <footer class="modal-foot"><button @click="state.manualOpen = false">知道了</button></footer>
      </section>
    </div>
</template>
