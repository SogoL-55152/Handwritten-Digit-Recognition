<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import * as api from '@/api/training.js'
import { useUserStore } from '@/stores/user.js'
import { createTrainingBoard, summarizeTask, isActiveTask } from '@/training/board.js'
import { createTrainingEvents } from '@/training/events.js'
import TrainingCurve from '@/training/TrainingCurve.vue'
import TrainingDetail from '@/training/TrainingDetail.vue'
import TrainingMatrix from '@/training/TrainingMatrix.vue'
import StepCurve from '@/training/StepCurve.vue'
import WizardPanel from '@/training/WizardPanel.vue'
import { trainingLogs } from '@/api/training.js'

const user = useUserStore()
const tab = ref(user.isSuperAdmin ? 'new' : 'records')
const tasks = ref([])
const loading = ref(false)
const errorMessage = ref('')
const liveStatus = ref('connecting')
const selectedId = ref(null)
const logTask = ref(null)
const logs = ref([])
const logsError = ref('')
const logQuery = ref('')
const logLevel = ref('all')
let logTimer = null

const board = createTrainingBoard({
  api,
  getSession: () => user.getSnapshot(),
  onTasks: (next) => { tasks.value = next },
  onError: (message) => { errorMessage.value = message }
})

const events = createTrainingEvents({
  api,
  getSession: () => user.getSnapshot(),
  onTask: (task) => mergeTask(task),
  onStatus: (status) => { liveStatus.value = status }
})

/** SSE 推来的任务按 id 覆盖；新任务插到最前面。 */
function mergeTask(incoming) {
  if (!incoming || !incoming.id) return
  const index = tasks.value.findIndex((item) => item.id === incoming.id)
  if (index >= 0) tasks.value.splice(index, 1, incoming)
  else tasks.value.unshift(incoming)
  tasks.value = [...tasks.value].sort((a, b) => Number(b.id) - Number(a.id))
}

const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedId.value) || null)
const selectedHistory = computed(() => selectedTask.value?.metrics?.history || [])

watch(tasks, () => {
  if (selectedId.value !== null && !tasks.value.some((task) => task.id === selectedId.value)) selectedId.value = null
})

async function loadAll() {
  loading.value = true
  errorMessage.value = ''
  try {
    await board.refresh()
    if (!board.polling()) board.start()
  } catch (failure) {
    errorMessage.value = failure?.message || '加载训练任务失败'
  } finally {
    loading.value = false
  }
}

/** 向导提交成功：切到训练记录并选中新任务。 */
function onSubmitted(taskId) {
  tab.value = 'records'
  selectedId.value = taskId || selectedId.value
  void loadAll()
}

const liveLabel = computed(() => ({
  live: '实时推送已连接', connecting: '实时推送连接中', reconnecting: '推送断开，正在重连',
  unavailable: '实时推送不可用，使用 4 秒轮询', closed: '推送已关闭'
}[liveStatus.value] || liveStatus.value))

const filteredLogs = computed(() => {
  const query = logQuery.value.trim().toLowerCase()
  return logs.value
    .filter((line) => {
      if (logLevel.value === 'all') return true
      if (logLevel.value === 'warn') return /warn|警告/i.test(line)
      if (logLevel.value === 'error') return /error|traceback|失败/i.test(line)
      return !/warn|error|traceback/i.test(line)
    })
    .filter((line) => !query || line.toLowerCase().includes(query))
})

const historyOf = (task) => task?.metrics?.history
const refresh = () => loadAll()
const selectTask = (id) => { selectedId.value = selectedId.value === id ? null : id }
/** 准备数据阶段的进度提示（有百分比且尚未产出第一轮指标）。 */
const prepareLabel = (task) => {
  if (!isActiveTask(task) || task.prepareProgress == null) return ''
  if ((task.metrics?.history?.length || 0) > 0) return ''
  return `准备数据 ${task.prepareProgress}%`
}

function stopLogPolling() {
  if (logTimer) { clearInterval(logTimer); logTimer = null }
}

async function fetchLogs(taskId) {
  try {
    const data = await trainingLogs(user.getSnapshot(), taskId)
    logs.value = Array.isArray(data?.lines) ? data.lines : []
  } catch (error) {
    logsError.value = error?.message || '日志加载失败'
  }
}

async function openLogs(task) {
  logTask.value = logTask.value === task.id ? null : task.id
  logs.value = []
  logsError.value = ''
  stopLogPolling()
  if (!logTask.value) return
  await fetchLogs(task.id)
  // 训练中的任务才自动刷新；结束后停止，避免无意义轮询
  if (isActiveTask(task)) {
    logTimer = setInterval(async () => {
      const current = tasks.value.find((item) => item.id === task.id)
      if (current && isActiveTask(current)) await fetchLogs(task.id)
      else stopLogPolling()
    }, 3000)
  }
}

loadAll()
onUnmounted(() => {
  stopLogPolling()
  board.dispose()
  events.close()
})
</script>

<template>
  <div class="stack wide-gap">
    <section class="panel">
      <div class="section-heading">
        <div><p class="eyebrow">训练</p><h2>训练中心</h2></div>
        <div class="row-actions" role="tablist" aria-label="训练页面">
          <button type="button" role="tab" :aria-selected="tab === 'records'" :class="{ primary: tab === 'records' }" @click="tab = 'records'">训练记录</button>
          <button v-if="user.isSuperAdmin" type="button" role="tab" :aria-selected="tab === 'new'" :class="{ primary: tab === 'new' }" @click="tab = 'new'">发起训练</button>
        </div>
      </div>
    </section>

    <WizardPanel v-if="tab === 'new' && user.isSuperAdmin" @submitted="onSubmitted" @view-records="tab = 'records'" />

    <template v-if="tab === 'records'">
      <section class="panel">
        <h2>训练任务</h2>
        <p class="muted">{{ liveLabel }} · 有排队中/训练中的任务时每 4 秒轮询兜底；全部结束会停止。</p>
        <div class="row-actions">
          <button :disabled="loading" @click="refresh">刷新列表</button>
        </div>
        <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>任务</th><th>状态</th><th>参数</th><th>产物</th><th>指标</th><th></th></tr></thead>
            <tbody>
              <template v-for="task in tasks" :key="task.id">
                <tr :class="{ selected: task.id === selectedId }">
                  <td>#{{ task.id }}<small class="cell-detail">{{ summarizeTask(task).attemptLabel }} · {{ summarizeTask(task).durationLabel }}</small></td>
                  <td>
                    {{ summarizeTask(task).statusLabel }}
                    <small v-if="prepareLabel(task)" class="cell-detail">{{ prepareLabel(task) }}</small>
                    <small v-if="summarizeTask(task).errorLabel" class="cell-detail">{{ summarizeTask(task).errorLabel }}</small>
                  </td>
                  <td>{{ summarizeTask(task).paramsLabel }}<small class="cell-detail">微调自 {{ task.initFrom || '从零训练' }}</small></td>
                  <td>{{ summarizeTask(task).versionLabel }}<small class="cell-detail">{{ summarizeTask(task).digestLabel }}</small></td>
                  <td>{{ summarizeTask(task).metricsLabel }}</td>
                  <td class="row-actions">
                    <button type="button" class="link" @click="selectTask(task.id)">
                      {{ task.id === selectedId ? '收起' : '曲线' }}
                    </button>
                    <button type="button" class="link" @click="openLogs(task)">
                      {{ logTask === task.id ? '收起日志' : '日志' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="task.id === selectedId" class="curve-row">
                  <td colspan="6">
                    <TrainingCurve :task-id="task.id" :history="historyOf(task)" />
                    <StepCurve v-if="task.metrics?.stepSeries?.length" :metrics="task.metrics" />
                    <TrainingDetail :task="task" />
                    <TrainingMatrix v-if="task.metrics" :metrics="task.metrics" />
                  </td>
                </tr>
                <tr v-if="logTask === task.id" class="curve-row">
                  <td colspan="6">
                    <div class="log-toolbar">
                      <select v-model="logLevel">
                        <option value="all">全部级别</option>
                        <option value="info">INFO</option>
                        <option value="warn">WARN</option>
                        <option value="error">ERROR</option>
                      </select>
                      <input v-model="logQuery" placeholder="搜索关键字" />
                      <span class="muted">{{ filteredLogs.length }}/{{ logs.length }} 行</span>
                    </div>
                    <pre class="log-stream">{{ filteredLogs.length ? filteredLogs.join('\n') : (logsError || '暂无日志') }}</pre>
                  </td>
                </tr>
              </template>
              <tr v-if="!tasks.length"><td colspan="6">还没有训练任务</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
