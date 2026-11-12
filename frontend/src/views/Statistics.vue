<script setup>
import { onBeforeUnmount, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { platformStatistics, recentPlatform, recentSpace, spaceStatistics } from '@/api/statistics.js'
import { useUserStore } from '@/stores/user.js'
import { dailySeries, detailRows, modelRows, recentRows, summaryCards, trainingCard } from '@/statistics/format.js'
import { recognitionDetail, recognitionImage } from '@/api/recognitions.js'
import { dailyOption, modelShareOption } from '@/statistics/chart.js'

echarts.use([LineChart, BarChart, PieChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

const user = useUserStore()
const days = ref(7)
const scope = ref('space')
const loading = ref(false)
const errorMessage = ref('')
const stats = ref(null)
const recent = ref([])

const detail = reactive({ open: false, id: '', loading: false, error: '', rows: [], imageUrl: '', imageError: '', requestId: '' })

function releaseImage() {
  if (detail.imageUrl) URL.revokeObjectURL(detail.imageUrl)
  detail.imageUrl = ''
}

async function openDetail(row) {
  releaseImage()
  Object.assign(detail, { open: true, id: row.id, loading: true, error: '', rows: [], imageError: '', requestId: '' })
  try {
    const snapshot = { workspaceId: Number(user.defaultWorkspaceId || 1), session: user.getSnapshot() }
    const data = await recognitionDetail(snapshot, row.id)
    detail.rows = detailRows(data)
    detail.requestId = data.requestId || ''
    try {
      const blob = await recognitionImage(snapshot, row.id)
      detail.imageUrl = URL.createObjectURL(blob)
    } catch (imageError) {
      detail.imageError = imageError?.message || '该记录没有保存图片'
    }
  } catch (error) {
    detail.error = error?.message || '详情加载失败'
  } finally {
    detail.loading = false
  }
}

function closeDetail() {
  releaseImage()
  detail.open = false
}

onUnmounted(releaseImage)
const dailyEl = ref(null)
const modelsEl = ref(null)
const dailyChart = shallowRef(null)
const modelsChart = shallowRef(null)
let disposed = false

const isOperator = () => Boolean(user.isSuperAdmin)

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const session = user.getSnapshot()
    const workspaceId = Number(user.defaultWorkspaceId || 1)
    const [summary, latest] = await Promise.all([
      scope.value === 'platform'
        ? platformStatistics(session, days.value)
        : spaceStatistics(workspaceId, session, days.value),
      scope.value === 'platform'
        ? recentPlatform(session, 8)
        : recentSpace(workspaceId, session, 8)
    ])
    stats.value = summary
    recent.value = recentRows(latest)
    render()
  } catch (failure) {
    errorMessage.value = failure?.message || '加载统计失败'
    stats.value = null
    recent.value = []
  } finally {
    loading.value = false
  }
}

function render() {
  if (disposed || !stats.value) return
  const series = dailySeries(stats.value)
  const rows = modelRows(stats.value)
  if (dailyEl.value) {
    dailyChart.value ??= echarts.init(dailyEl.value)
    dailyChart.value.setOption(dailyOption(series, scope.value === 'platform' ? '平台每日识别量' : '本空间每日识别量'), true)
  }
  if (modelsEl.value) {
    modelsChart.value ??= echarts.init(modelsEl.value)
    modelsChart.value.setOption(modelShareOption(rows), true)
  }
}

function resize() {
  dailyChart.value?.resize()
  modelsChart.value?.resize()
}

watch([days, scope], load)
onMounted(() => {
  load()
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('resize', resize)
  dailyChart.value?.dispose()
  modelsChart.value?.dispose()
})
</script>

<template>
  <div class="stack wide-gap">
    <section class="panel">
      <p class="eyebrow">W5 · 统计</p>
      <h2>识别统计</h2>
      <p class="notice">
        统计只反映系统实际记录到的数据。生产请求没有人工标注，因此这里不给"准确率"——准确率请看离线评测报告。
      </p>
      <div class="field-row">
        <label>范围
          <select v-model="scope" name="scope">
            <option value="space">本空间</option>
            <option v-if="isOperator()" value="platform">全平台</option>
          </select>
        </label>
        <label>窗口
          <select v-model.number="days" name="days">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
          </select>
        </label>
        <button type="button" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
      <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
      <div v-if="stats" class="stat-cards">
        <div v-for="card in summaryCards(stats)" :key="card.key" class="stat-card">
          <small>{{ card.label }}</small>
          <strong>{{ card.value }}</strong>
          <span class="muted">{{ card.hint }}</span>
        </div>
        <div v-if="trainingCard(stats)" class="stat-card">
          <small>{{ trainingCard(stats).label }}</small>
          <strong>{{ trainingCard(stats).value }}</strong>
          <span class="muted">{{ trainingCard(stats).hint }}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div ref="dailyEl" class="chart" style="height: 300px"></div>
    </section>

    <section class="panel">
      <h2>{{ scope === 'platform' ? '平台最近识别' : '我的最近识别' }}</h2>
      <p class="muted">最近 {{ recent.length }} 条记录，按时间倒序；拒识与失败也列出来，方便对照统计口径。</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th><th>结果</th><th>置信度</th><th>耗时</th><th>模型</th><th>来源</th><th>操作</th>
              <th v-if="scope === 'platform'">空间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in recent" :key="row.id">
              <td>{{ row.time }}</td>
              <td :class="{ 'recent-failed': !row.success }">{{ row.outcome }}</td>
              <td>{{ row.confidence }}</td>
              <td>{{ row.latency }}</td>
              <td>{{ row.model }}</td>
              <td>{{ row.source }}</td>
              <td><button type="button" class="link" :disabled="scope === 'platform'" @click="openDetail(row)">查看</button></td>
              <td v-if="scope === 'platform'">{{ row.workspace }}</td>
            </tr>
            <tr v-if="!recent.length"><td :colspan="scope === 'platform' ? 8 : 7">还没有识别记录</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="stats" class="panel">
      <h2>模型使用分布</h2>
      <div class="split">
        <div ref="modelsEl" class="chart" style="height: 260px"></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>模型版本</th><th>请求</th><th>返回结果</th><th>占比</th></tr></thead>
            <tbody>
              <tr v-for="row in modelRows(stats)" :key="row.version">
                <td>{{ row.version }}</td>
                <td>{{ row.total }}</td>
                <td>{{ row.accepted }}</td>
                <td>{{ row.share }}</td>
              </tr>
              <tr v-if="!modelRows(stats).length"><td colspan="4">窗口内没有识别记录</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <div v-if="detail.open" class="detail-overlay" role="dialog" aria-modal="true" aria-label="识别详情" @click.self="closeDetail">
      <div class="detail-card">
        <div class="detail-head">
          <h3>识别记录 #{{ detail.id }}</h3>
          <button type="button" @click="closeDetail">关闭</button>
        </div>
        <p v-if="detail.loading" class="muted">加载中…</p>
        <p v-else-if="detail.error" class="notice error" role="alert">{{ detail.error }}</p>
        <template v-else>
          <div class="detail-image">
            <img v-if="detail.imageUrl" :src="detail.imageUrl" alt="识别原图" />
            <p v-else class="muted">{{ detail.imageError || '该记录没有保存图片' }}</p>
          </div>
          <dl class="details detail-fields">
            <template v-for="item in detail.rows" :key="item.key">
              <dt>{{ item.key }}</dt><dd>{{ item.value }}</dd>
            </template>
          </dl>
        </template>
      </div>
    </div>
  </div>
</template>
