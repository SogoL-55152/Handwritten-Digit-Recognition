<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { getCallTrend, getModelUsage, getOverview } from '@/api/stats'

const loading = ref(false)
const overview = ref({})
const trendRef = ref(null)
const usageRef = ref(null)

let trendChart = null
let usageChart = null

function renderTrend(data) {
  if (!trendChart) return
  trendChart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 24, top: 32, bottom: 36 },
    xAxis: {
      type: 'category',
      data: data.map((item) => item.date)
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '调用量',
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.15 },
        data: data.map((item) => Number(item.count))
      }
    ]
  })
}

function renderUsage(data) {
  if (!usageChart) return
  usageChart.setOption({
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [
      {
        name: '模型使用分布',
        type: 'pie',
        radius: ['42%', '68%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { formatter: '{b}\n{c} 次' },
        data: data.map((item) => ({ name: item.name, value: Number(item.value) }))
      }
    ]
  })
}

function resize() {
  trendChart?.resize()
  usageChart?.resize()
}

onMounted(async () => {
  loading.value = true
  try {
    const [summary, trend, usage] = await Promise.all([
      getOverview(),
      getCallTrend(),
      getModelUsage()
    ])
    overview.value = summary
    trendChart = echarts.init(trendRef.value)
    usageChart = echarts.init(usageRef.value)
    renderTrend(trend)
    renderUsage(usage)
    window.addEventListener('resize', resize)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  trendChart?.dispose()
  usageChart?.dispose()
  trendChart = null
  usageChart = null
})
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">统计分析</h2>
        <p class="page-subtitle">识别调用量、准确率与模型使用分布</p>
      </div>
    </div>

    <div class="stat-grid">
      <el-card class="stat-card" shadow="never">
        <div class="stat-label">识别调用量</div>
        <div class="stat-value">{{ overview.callCount ?? 0 }}</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-label">模型平均准确率</div>
        <div class="stat-value">{{ ((Number(overview.accuracy) || 0) * 100).toFixed(2) }}%</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-label">模型数</div>
        <div class="stat-value">{{ overview.modelCount ?? 0 }}</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-label">活跃模型</div>
        <div class="stat-value active-model">{{ overview.activeModel || '未启用' }}</div>
      </el-card>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :lg="14">
        <el-card class="chart-card" shadow="never">
          <template #header>近 7 天调用趋势</template>
          <div ref="trendRef" class="chart" />
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="10">
        <el-card class="chart-card" shadow="never">
          <template #header>模型使用分布</template>
          <div ref="usageRef" class="chart" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.active-model {
  font-size: 20px;
}
</style>
