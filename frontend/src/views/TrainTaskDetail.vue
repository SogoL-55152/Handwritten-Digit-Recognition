<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as echarts from 'echarts'
import { getTrainMetrics, getTrainTask } from '@/api/train'

const route = useRoute()
const router = useRouter()

const task = ref(null)
const status = ref('PENDING')
const progress = ref(0)
const epoch = ref(0)
const metrics = ref([])
const error = ref('')
const modelInfo = ref(null)
const chartRef = ref(null)

let chart = null
let timer = null

const statusMap = {
  PENDING: { text: '排队中', type: 'info' },
  RUNNING: { text: '训练中', type: 'warning' },
  SUCCESS: { text: '已完成', type: 'success' },
  FAILED: { text: '失败', type: 'danger' }
}

async function loadTask() {
  task.value = await getTrainTask(route.params.id)
}

function renderChart() {
  if (!chart) return
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['Loss', 'Accuracy'] },
    grid: { left: 56, right: 56, top: 48, bottom: 40 },
    xAxis: {
      type: 'category',
      data: metrics.value.map((item) => `Epoch ${item.epoch}`)
    },
    yAxis: [
      { type: 'value', name: 'Loss', scale: true },
      { type: 'value', name: 'Accuracy', min: 0, max: 1 }
    ],
    series: [
      {
        name: 'Loss',
        type: 'line',
        smooth: true,
        data: metrics.value.map((item) => item.loss)
      },
      {
        name: 'Accuracy',
        type: 'line',
        smooth: true,
        yAxisIndex: 1,
        data: metrics.value.map((item) => item.accuracy)
      }
    ]
  })
}

async function poll() {
  try {
    const data = await getTrainMetrics(route.params.id)
    status.value = data.status || status.value
    progress.value = Number(data.progress || 0)
    epoch.value = Number(data.epoch || 0)
    metrics.value = Array.isArray(data.metrics) ? data.metrics : []
    error.value = data.error || ''
    if (data.model) modelInfo.value = data.model
    renderChart()

    if (['SUCCESS', 'FAILED'].includes(status.value)) {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await loadTask()
    }
  } catch {
    // 错误已由请求拦截器提示，保留当前展示
  }
}

onMounted(async () => {
  chart = echarts.init(chartRef.value)
  await loadTask()
  if (task.value?.status) status.value = task.value.status
  if (typeof task.value?.progress === 'number') progress.value = task.value.progress
  await poll()
  if (!timer && !['SUCCESS', 'FAILED'].includes(status.value)) {
    timer = setInterval(poll, 2000)
  }
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">训练详情 #{{ route.params.id }}</h2>
        <p class="page-subtitle">{{ task?.name || '加载中...' }}</p>
      </div>
      <el-button @click="router.push('/train-tasks')">返回列表</el-button>
    </div>

    <el-card shadow="never">
      <el-descriptions :column="4" border>
        <el-descriptions-item label="状态">
          <el-tag :type="statusMap[status]?.type || 'info'" effect="plain">
            {{ statusMap[status]?.text || status }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="进度">
          <el-progress :percentage="progress" :stroke-width="10" style="width: 180px" />
        </el-descriptions-item>
        <el-descriptions-item label="模型名称">
          {{ task?.modelName || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="当前轮次">
          {{ epoch || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="数据集 ID">{{ task?.datasetId ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="外部任务 ID" :span="2">
          {{ task?.externalTaskId || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="产出模型">
          {{ modelInfo ? `${modelInfo.name}（${((modelInfo.accuracy || 0) * 100).toFixed(2)}%）` : '-' }}
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="error"
        class="error-alert"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <el-alert
        v-else-if="status === 'SUCCESS'"
        class="error-alert"
        title="训练完成，模型已自动登记，可前往模型管理启用"
        type="success"
        :closable="false"
        show-icon
      />
    </el-card>

    <el-card class="chart-card" shadow="never">
      <template #header>
        <div class="card-header">
          <span>训练曲线</span>
          <span class="muted">每 2 秒轮询（SSE 将在 W5 接入）</span>
        </div>
      </template>
      <div ref="chartRef" class="chart" />
      <el-empty v-if="!metrics.length" description="等待训练指标上报..." />
    </el-card>
  </div>
</template>

<style scoped>
.error-alert {
  margin-top: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
