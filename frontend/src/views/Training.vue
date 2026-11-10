<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import * as api from '@/api/training.js'
import { listModels } from '@/api/models.js'
import { useUserStore } from '@/stores/user.js'
import { validateTraining, validateDataset, toCreatePayload } from '@/training/validation.js'
import { createTrainingBoard, isActiveTask, summarizeTask } from '@/training/board.js'
import { createTrainingEvents } from '@/training/events.js'
import TrainingCurve from '@/training/TrainingCurve.vue'

const user = useUserStore()
const form = reactive({
  datasetId: 1, epochs: 3, samples: 10000, batchSize: 64,
  learningRate: 0.001, seed: 42, photoRatio: 0.5, useEmnist: false, initFrom: null
})
const datasets = ref([])
const models = ref([])
const tasks = ref([])
const errors = ref({})
const loading = ref(false)
const submitting = ref(false)
const notice = ref('')
const errorMessage = ref('')
const liveStatus = ref('connecting')
const selectedId = ref(null)

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
    datasets.value = await board.load()
    if (datasets.value.length && !datasets.value.some((item) => Number(item.id) === form.datasetId)) {
      form.datasetId = Number(datasets.value[0].id)
    }
    try {
      models.value = await listModels(user.getSnapshot())
      const active = models.value.find((item) => item.status === 'ACTIVE')
      if (form.initFrom === null && active) form.initFrom = active.version
    } catch (failure) {
      models.value = []
    }
    await board.refresh()
    if (!board.polling()) board.start()
  } catch (failure) {
    errorMessage.value = failure?.message || '加载训练任务失败'
  } finally {
    loading.value = false
  }
}

async function submit() {
  notice.value = ''
  errorMessage.value = ''
  errors.value = { ...validateDataset(form.datasetId), ...validateTraining(form) }
  if (Object.keys(errors.value).length) return
  submitting.value = true
  try {
    const created = await board.create(form.datasetId, toCreatePayload(form))
    await board.refresh()
    notice.value = `已提交训练任务 #${created.id}，worker 取到后会转为“训练中”。`
  } catch (failure) {
    errorMessage.value = failure?.message || '提交训练任务失败'
  } finally {
    submitting.value = false
  }
}

const liveLabel = computed(() => ({
  live: '实时推送已连接', connecting: '实时推送连接中', reconnecting: '推送断开，正在重连',
  unavailable: '实时推送不可用，使用 4 秒轮询', closed: '推送已关闭'
}[liveStatus.value] || liveStatus.value))

const historyOf = (task) => task?.metrics?.history
const refresh = () => loadAll()
const selectTask = (id) => { selectedId.value = selectedId.value === id ? null : id }
loadAll()
onUnmounted(() => {
  board.dispose()
  events.close()
})
</script>

<template>
  <div class="stack wide-gap">
    <section class="panel">
      <p class="eyebrow">W4 · 训练任务</p>
      <h2>发起一次训练</h2>
      <p class="notice">训练是异步任务：提交后由 Celery worker 执行，产物自动登记为未生效模型，需要时再到「模型管理」激活。</p>
      <form class="training-form" novalidate @submit.prevent="submit">
        <label>数据集
          <select v-model.number="form.datasetId" name="datasetId">
            <option v-for="item in datasets" :key="item.id" :value="Number(item.id)">
              {{ item.name }}（{{ item.trainSamples }} 训练样本）
            </option>
            <option v-if="!datasets.length" :value="0">暂无可用数据集</option>
          </select>
          <small v-if="errors.datasetId" class="field-error">{{ errors.datasetId }}</small>
          <small v-else class="muted">仅元数据，本页不上传数据</small>
        </label>
        <label>epoch<input v-model.number="form.epochs" name="epochs" type="number" min="1" max="5" step="1" /><small v-if="errors.epochs" class="field-error">{{ errors.epochs }}</small></label>
        <label>样本数<input v-model.number="form.samples" name="samples" type="number" min="1000" max="60000" step="1000" /><small v-if="errors.samples" class="field-error">{{ errors.samples }}</small><small v-else class="muted">1 万样本 3 轮约 1 分钟</small></label>
        <label>batchSize<select v-model.number="form.batchSize" name="batchSize"><option :value="32">32</option><option :value="64">64</option><option :value="128">128</option></select><small v-if="errors.batchSize" class="field-error">{{ errors.batchSize }}</small></label>
        <label>learningRate<input v-model.number="form.learningRate" name="learningRate" type="number" step="any" min="0" max="0.1" /><small v-if="errors.learningRate" class="field-error">{{ errors.learningRate }}</small></label>
        <label>seed<input v-model.number="form.seed" name="seed" type="number" step="1" min="0" max="4294967295" /><small v-if="errors.seed" class="field-error">{{ errors.seed }}</small></label>
        <label>照片增广比例<input v-model.number="form.photoRatio" name="photoRatio" type="number" step="0.1" min="0" max="1" /><small v-if="errors.photoRatio" class="field-error">{{ errors.photoRatio }}</small></label>
        <label>从哪个模型微调
          <select v-model="form.initFrom" name="initFrom">
            <option :value="null">从零训练</option>
            <option v-for="model in models" :key="model.version" :value="model.version">
              {{ model.version }}{{ model.status === 'ACTIVE' ? '（当前生效）' : '' }}
            </option>
          </select>
          <small v-if="errors.initFrom" class="field-error">{{ errors.initFrom }}</small>
          <small v-else class="muted">从已有权重继续训练，通常比从零训练更稳</small>
        </label>
        <label class="checkbox-row"><input v-model="form.useEmnist" name="useEmnist" type="checkbox" /> 混入 EMNIST 书写者数据</label>
        <div class="full-row">
          <button class="primary" type="submit" :disabled="submitting || !datasets.length">
            {{ submitting ? '提交中…' : '发起训练' }}
          </button>
          <button type="button" :disabled="loading" @click="refresh">刷新列表</button>
        </div>
      </form>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
    </section>

    <section class="panel">
      <h2>训练任务</h2>
      <p class="muted">{{ liveLabel }} · 有排队中/训练中的任务时每 4 秒轮询兜底；全部结束会停止。</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>任务</th><th>状态</th><th>参数</th><th>产物</th><th>指标</th><th></th></tr></thead>
          <tbody>
            <template v-for="task in tasks" :key="task.id">
              <tr :class="{ selected: task.id === selectedId }">
                <td>#{{ task.id }}<small class="cell-detail">{{ summarizeTask(task).attemptLabel }} · {{ summarizeTask(task).durationLabel }}</small></td>
                <td>
                  {{ summarizeTask(task).statusLabel }}
                  <small v-if="summarizeTask(task).errorLabel" class="cell-detail">{{ summarizeTask(task).errorLabel }}</small>
                </td>
                <td>{{ summarizeTask(task).paramsLabel }}<small class="cell-detail">微调自 {{ task.initFrom || '从零训练' }}</small></td>
                <td>{{ summarizeTask(task).versionLabel }}<small class="cell-detail">{{ summarizeTask(task).digestLabel }}</small></td>
                <td>{{ summarizeTask(task).metricsLabel }}</td>
                <td>
                  <button type="button" class="link" @click="selectTask(task.id)">
                    {{ task.id === selectedId ? '收起' : '曲线' }}
                  </button>
                </td>
              </tr>
              <tr v-if="task.id === selectedId" class="curve-row">
                <td colspan="6">
                  <TrainingCurve :task-id="task.id" :history="historyOf(task)" />
                </td>
              </tr>
            </template>
            <tr v-if="!tasks.length"><td colspan="6">还没有训练任务</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
