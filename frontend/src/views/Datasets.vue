<script setup>
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { buildVersion, createDataset, listDatasets, listVersions, sampleImage, versionSamples, versionStats } from '@/api/datasets.js'
import { buildPayload, labelRows, nextVersion, splitHints, splitRows } from '@/datasets/format.js'

const user = useUserStore()
const workspace = useWorkspaceStore()

const state = reactive({
  loading: false, busy: false, samplesLoading: false, error: '', notice: '',
  datasets: [], selectedId: null,
  versions: [], selectedVersionId: null,
  stats: null, samples: [], total: 0, page: 1, size: 12, split: '', label: '',
  creating: false, createForm: { name: '', description: '' },
  buildForm: { version: 'v1', splitRule: 'WRITER', valPercent: 15, testPercent: 15, label: '', kind: '' }
})
const imageUrls = reactive({})

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

async function build() {
  if (state.busy || !state.selectedId) return
  state.busy = true
  state.error = ''
  state.notice = ''
  try {
    const version = await buildVersion(snapshot(), state.selectedId, buildPayload(state.buildForm))
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

onMounted(loadDatasets)
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
            <span class="tag">{{ state.versions.length }} 个版本</span>
          </div>

          <div class="version-chips" v-if="state.versions.length">
            <button v-for="version in state.versions" :key="version.id" type="button"
                    :class="{ active: version.id === state.selectedVersionId }" @click="selectVersion(version.id)">
              <strong>{{ version.version }}</strong><span>{{ version.sampleCount }} 条</span>
            </button>
          </div>

          <div class="build-panel">
            <div class="build-grid">
              <label class="field"><span>版本号</span><input v-model="state.buildForm.version" maxlength="16" /></label>
              <label class="field"><span>划分方式</span>
                <select v-model="state.buildForm.splitRule">
                  <option value="WRITER">按书写者（推荐）</option>
                  <option value="RANDOM">按样本随机</option>
                </select>
              </label>
              <label class="field"><span>验证集 %</span><input v-model.number="state.buildForm.valPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>测试集 %</span><input v-model.number="state.buildForm.testPercent" type="number" min="0" max="50" /></label>
              <label class="field"><span>只看标签</span><input v-model="state.buildForm.label" type="number" min="0" max="9" placeholder="全部" /></label>
              <button class="primary build-action" :disabled="state.busy" @click="build">{{ state.busy ? '生成中…' : '生成版本' }}</button>
            </div>
            <p class="hint">按书写者划分时，同一个人的样本只会落在一个划分里，评测结果更可信。版本一旦生成即为快照。</p>
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
          <p class="muted">设置划分方式后点「生成版本」，样本才会进入数据集。</p>
        </section>
      </div>
    </section>
  </div>
</template>
