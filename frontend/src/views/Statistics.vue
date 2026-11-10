<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { platformStatistics, spaceStatistics } from '@/api/statistics.js'
import { useUserStore } from '@/stores/user.js'
import { dailySeries, modelRows, summaryCards, trainingCard } from '@/statistics/format.js'
import { dailyOption, modelShareOption } from '@/statistics/chart.js'

echarts.use([LineChart, BarChart, PieChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

const user = useUserStore()
const days = ref(7)
const scope = ref('space')
const loading = ref(false)
const errorMessage = ref('')
const stats = ref(null)
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
    stats.value = scope.value === 'platform'
      ? await platformStatistics(session, days.value)
      : await spaceStatistics(workspaceId, session, days.value)
    render()
  } catch (failure) {
    errorMessage.value = failure?.message || '加载统计失败'
    stats.value = null
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
  </div>
</template>
