<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { allVersions, buildVersion, claimSamples, createDataset, deleteDataset, deleteVersion, importBatches, importSamples, importSvhn, listDatasets, listVersions, removeVersionSample, rollbackBatch, sampleImage, versionSamples, versionStats, wizardCommit, wizardPreview, wizardZipCommit, wizardZipPreview } from '@/api/datasets.js'
import { buildPayload, labelRows, nextVersion, splitHints, splitRows } from '@/datasets/format.js'
import { batchOf, groupByFolder, importSummary, progressText } from '@/datasets/import.js'

const user = useUserStore()
const workspace = useWorkspaceStore()

const state = reactive({
  loading: false, busy: false, samplesLoading: false, error: '', notice: '',
  datasets: [], selectedId: null,
  versions: [], selectedVersionId: null,
  stats: null, samples: [], total: 0, page: 1, size: 12, split: '', label: '',
  creating: false, createForm: { name: '', description: '' },
  folder: { busy: false, progress: '', result: null },
  svhn: { open: false, busy: false, directory: '', perLabel: 500, result: null },
  wizard: { open: false, busy: false, directory: '', preview: null, result: null, batches: [], zipFile: null },
  sources: [], sourceOptions: [], sourceLimit: 20, sourceMode: 'SELF',
  buildForm: { version: 'v1', splitRule: 'RANDOM', valPercent: 15, testPercent: 15, label: '', kind: '' }
})
const imageUrls = reactive({})
const folderInput = ref(null)

const snapshot = () => ({ workspaceId: Number(workspace.active?.id || 0), session: user.getSnapshot() })
const selectedDataset = computed(() => state.datasets.find((item) => item.id === state.selectedId) || null)
const selectedVersion = computed(() => state.versions.find((item) => item.id === state.selectedVersionId) || null)
const labelList = computed(() => labelRows(state.stats))
const splitList = computed(() => splitRows(state.stats))
const hints = computed(() => splitHints(state.stats))
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
    if (!state.selectedId && state.datasets.length) await selectDataset(state.datasets[0].id)
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

async function importFolder(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length || !state.selectedId) return
  const { groups, ignored, noLabel } = groupByFolder(files)
  const labels = Object.keys(groups).filter((digit) => groups[digit].length).map(Number).sort((a, b) => a - b)
  if (!labels.length) {
    state.error = '没有找到按 0–9 命名的子目录（例如 0/xxx.png）'
    return
  }
  state.busy = true
  state.error = ''
  state.notice = ''
  state.folder = { busy: true, progress: '', result: null }
  const results = []
  try {
    for (let index = 0; index < labels.length; index += 1) {
      const digit = labels[index]
      const batches = batchOf(groups[digit], 20)
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        state.folder.progress = progressText({
          label: digit, labelIndex: index + 1, labelCount: labels.length,
          batchIndex: batchIndex + 1, batchCount: batches.length
        })
        results.push(await importSamples(snapshot(), state.selectedId, digit, batches[batchIndex]))
      }
    }
    const summary = importSummary(results)
    state.folder = { busy: false, progress: '', result: { ...summary, ignored, noLabel, labels: labels.length } }
    state.notice = `目录导入：成功 ${summary.imported} · 重复 ${summary.duplicates} · 失败 ${summary.failed}`
    await loadDatasets()
  } catch (error) {
    state.folder = { busy: false, progress: '', result: null }
    state.error = error?.message || '目录导入失败'
  } finally {
    state.busy = false
  }
}

async function doImportSvhn() {
  if (!state.selectedId || !state.svhn.directory.trim()) return
  state.svhn.busy = true
  state.error = ''
  state.notice = ''
  state.svhn.result = null
  try {
    const result = await importSvhn(snapshot(), state.selectedId, {
      directory: state.svhn.directory.trim(),
      perLabel: Number(state.svhn.perLabel)
    })
    state.svhn.result = result
    const summary = result.summary || {}
    state.notice = `标注导入：成功 ${summary.imported ?? '—'} · 重复 ${summary.duplicates ?? '—'} · 失败 ${summary.failed ?? '—'}`
    await loadDatasets()
  } catch (error) {
    state.error = error?.message || '导入失败'
  } finally {
    state.svhn.busy = false
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

async function loadBatches() {
  try {
    state.wizard.batches = await importBatches(snapshot())
  } catch (error) {
    state.wizard.batches = []
  }
}

async function openWizard() {
  state.wizard.open = !state.wizard.open
  if (state.wizard.open && !state.wizard.batches.length) await loadBatches()
}

async function previewWizard() {
  if (!state.wizard.directory.trim()) return
  state.wizard.busy = true
  state.error = ''
  state.wizard.result = null
  try {
    state.wizard.preview = await wizardPreview(snapshot(), state.wizard.directory.trim())
  } catch (error) {
    state.error = error?.message || '试运行失败'
  } finally {
    state.wizard.busy = false
  }
}

async function previewZip(event) {
  const file = (event.target.files || [])[0]
  event.target.value = ''
  if (!file) return
  state.wizard.busy = true
  state.error = ''
  state.wizard.result = null
  try {
    state.wizard.preview = await wizardZipPreview(snapshot(), file)
  } catch (error) {
    state.error = error?.message || 'zip 试运行失败'
  } finally {
    state.wizard.busy = false
  }
}

async function commitZip() {
  if (!state.selectedId || !state.wizard.preview?.token) return
  state.wizard.busy = true
  state.error = ''
  try {
    const result = await wizardZipCommit(snapshot(), state.selectedId, state.wizard.preview.token)
    state.wizard.result = result
    state.notice = `智能导入（zip）：成功 ${result.imported} · 重复 ${result.duplicates} · 失败 ${result.failed}`
    state.wizard.preview = null
    await loadDatasets()
    await loadBatches()
  } catch (error) {
    state.error = error?.message || 'zip 导入失败'
  } finally {
    state.wizard.busy = false
  }
}

async function commitWizard() {
  if (!state.selectedId || !state.wizard.preview) return
  state.wizard.busy = true
  state.error = ''
  try {
    const result = await wizardCommit(snapshot(), state.selectedId, state.wizard.directory.trim())
    state.wizard.result = result
    state.notice = `智能导入：成功 ${result.imported} · 重复 ${result.duplicates} · 失败 ${result.failed}`
    state.wizard.preview = null
    await loadDatasets()
    await loadBatches()
  } catch (error) {
    state.error = error?.message || '导入失败'
  } finally {
    state.wizard.busy = false
  }
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

onBeforeUnmount(releaseImages)
</script>

<template>
  <div class="stack wide-gap dataset-page">
    <header class="panel dataset-hero">
      <div>
        <p class="eyebrow">DATA</p>
        <h2>数据集</h2>
        <p class="muted">把采集到的样本整理成可训练、可评测的集合。版本是快照，划分默认按书写者隔离。</p>
      </div>
      <div class="row-actions">
        <button :disabled="state.loading || state.busy" @click="loadDatasets">刷新</button>
        <button :disabled="state.busy || !state.selectedId" title="先选中一个数据集" @click="folderInput?.click()">导入数据集</button>
        <button :disabled="state.busy || !state.selectedId" title="先选中一个数据集" @click="state.svhn.open = !state.svhn.open">导入标注数据集</button>
        <button :disabled="state.busy" @click="openWizard">智能导入</button>
        <input ref="folderInput" type="file" webkitdirectory directory multiple hidden @change="importFolder" />
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

    <section v-if="state.svhn.open" class="panel svhn-panel">
      <div class="block-head"><h4>导入标注数据集</h4><span class="muted">目录里需有 digitStruct.mat（每张图多个数字的框与标签）；每类数量控制规模</span></div>
      <div class="import-row">
        <label class="field field-wide"><span>解压目录</span>
          <input v-model="state.svhn.directory" placeholder="例如 C:\\...\\train\\train（含 digitStruct.mat）" />
        </label>
        <label class="field"><span>每类数量</span>
          <input v-model.number="state.svhn.perLabel" type="number" min="1" max="20000" />
        </label>
        <button class="primary" :disabled="state.svhn.busy || !state.selectedId || !state.svhn.directory.trim()" @click="doImportSvhn">
          {{ state.svhn.busy ? '导入中…' : '开始导入' }}
        </button>
      </div>
      <p v-if="state.svhn.busy" class="hint">正在按框裁字并分批导入，规模大时可能需要几十秒，请不要关闭页面。</p>
      <p v-if="state.svhn.result" class="hint">
        退出码 {{ state.svhn.result.exitCode }} · 耗时 {{ state.svhn.result.seconds }}s
        <template v-if="state.svhn.result.summary"> · 成功 {{ state.svhn.result.summary.imported }} · 重复 {{ state.svhn.result.summary.duplicates }} · 失败 {{ state.svhn.result.summary.failed }}</template>
      </p>
    </section>
    <section v-if="state.wizard.open" class="panel svhn-panel">
      <div class="block-head"><h4>智能导入</h4><span class="muted">自动识别目录结构：按类别文件夹 / CSV 标签 / 文件名带标签；先试运行看统计</span></div>
      <div class="import-row">
        <label class="field field-wide"><span>数据集目录（服务端路径）</span>
          <input v-model="state.wizard.directory" placeholder="例如 D:\datasets\my-digits" />
        </label>
        <button :disabled="state.wizard.busy || !state.wizard.directory.trim()" @click="previewWizard">
          {{ state.wizard.busy ? '处理中…' : '试运行' }}
        </button>
        <label class="field"><span>或上传 zip</span>
          <input type="file" accept=".zip" @change="previewZip" />
        </label>
        <button v-if="!state.wizard.preview?.token" class="primary"
                :disabled="state.wizard.busy || !state.selectedId || !state.wizard.preview" @click="commitWizard">
          {{ state.selectedId ? '确认导入到当前数据集' : '先选中数据集' }}
        </button>
        <button v-else class="primary" :disabled="state.wizard.busy || !state.selectedId" @click="commitZip">
          {{ state.selectedId ? '确认导入（zip）' : '先选中数据集' }}
        </button>
      </div>

      <div v-if="state.wizard.preview" class="wizard-report">
        <p><strong>格式：</strong>{{ state.wizard.preview.format }} — {{ state.wizard.preview.note }}</p>
        <p><strong>可导入：</strong>{{ state.wizard.preview.total }} 张<template v-if="state.wizard.preview.skipped"> ｜ 跳过 {{ state.wizard.preview.skipped }} 张</template></p>
        <div class="label-bars">
          <div v-for="(count, label) in state.wizard.preview.labels" :key="label" class="label-bar">
            <span class="label-name">{{ label }}</span>
            <span class="bar"><i :style="{ width: Math.max(2, (count / state.wizard.preview.total) * 100) + '%' }"></i></span>
            <span class="label-count">{{ count }}</span>
          </div>
        </div>
        <p v-if="state.wizard.preview.samples?.length" class="hint">示例文件：{{ state.wizard.preview.samples.join('、') }}</p>
        <p v-if="state.wizard.preview.selfCheck" class="hint-banner" :class="{ 'self-check-bad': state.wizard.preview.selfCheck.accepted === 0 }">
          抽样自检：{{ state.wizard.preview.selfCheck.note }}
        </p>
        <p v-if="state.wizard.preview.skippedDetail" class="hint">
          跳过原因：<template v-for="(value, key) in state.wizard.preview.skippedDetail" :key="key">{{ key }} {{ value }} ｜ </template>
        </p>
      </div>

      <p v-if="state.wizard.result" class="hint">
        导入完成：成功 {{ state.wizard.result.imported }} · 重复 {{ state.wizard.result.duplicates }} · 失败 {{ state.wizard.result.failed }}
      </p>

      <div v-if="state.wizard.batches.length" class="batch-list">
        <div class="block-head"><h4>导入批次</h4><span class="muted">可回滚（样本未进入版本时）</span></div>
        <div v-for="batch in state.wizard.batches" :key="batch.id" class="batch-row">
          <span>#{{ batch.id }}</span>
          <span>{{ batch.dataset_name || batch.dataset_id }}</span>
          <span>{{ batch.format }}</span>
          <span>成功 {{ batch.imported }} · 跳过 {{ batch.skipped }}</span>
          <span class="muted">{{ batch.source }}</span>
          <button class="link" :disabled="state.busy" @click="rollback(batch)">回滚</button>
        </div>
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
            <div class="row-actions">
              <span class="tag">{{ state.versions.length }} 个版本</span>
              <button :disabled="state.busy" title="把识别页采集、尚无归属的样本归入本数据集" @click="claimRecognition">归入识别采集</button>
              <button class="danger" :disabled="state.busy" @click="removeDataset">删除数据集</button>
            </div>
          </div>

          <div class="version-chips" v-if="state.versions.length">
            <button type="button" class="danger" :disabled="state.busy || !state.selectedVersionId"
                    title="删除当前选中的版本" @click="removeVersion">删除当前版本</button>
            <button v-for="version in state.versions" :key="version.id" type="button"
                    :class="{ active: version.id === state.selectedVersionId }" @click="selectVersion(version.id)">
              <strong>{{ version.version }}</strong><span>{{ version.sampleCount }} 条</span>
            </button>
          </div>

          <div class="build-panel">
            <div class="build-grid">
              <label class="field"><span>版本号</span><input v-model="state.buildForm.version" maxlength="16" /></label>
              <label class="field"><span>验证集 %</span><input v-model.number="state.buildForm.valPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>测试集 %</span><input v-model.number="state.buildForm.testPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>只看标签</span><input v-model="state.buildForm.label" type="number" min="0" max="9" placeholder="全部" /></label>
              <button class="primary build-action" :disabled="state.busy" @click="build">{{ state.busy ? '生成中…' : '生成版本' }}</button>
            </div>
            <p class="hint">版本只包含导入到本数据集（或归入本数据集）的样本；其他数据集的样本不会混进来。版本一旦生成即为快照。</p>
            <div class="source-picker">
              <div class="block-head"><h4>样本来源</h4><span class="muted">只加入你选中的内容；选「指定版本」时至少要勾一个版本</span></div>
              <div class="source-mode">
                <label><input type="radio" value="SELF" v-model="state.sourceMode" /> 本数据集的样本（导入/归入到这里的）</label>
                <label><input type="radio" value="VERSIONS" v-model="state.sourceMode" /> 指定版本合并</label>
              </div>
              <template v-if="state.sourceMode === 'VERSIONS'">
              <div v-for="option in state.sourceOptions" :key="option.id" class="source-row">
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
              <p v-if="!state.sourceOptions.length" class="muted">还没有其他可用版本。</p>
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
            <div class="block-head"><h4>标签分布</h4><span class="muted">共 {{ state.stats.version.sampleCount }} 条</span></div>
            <div class="label-bars">
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
</template>
