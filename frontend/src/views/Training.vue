<script setup>
import { onUnmounted, reactive, ref } from 'vue'
import * as api from '@/api/training.js'
import { listModels } from '@/api/models.js'
import { useUserStore } from '@/stores/user.js'
import { validateTraining, validateDataset, toCreatePayload } from '@/training/validation.js'
import { createTrainingBoard, summarizeTask } from '@/training/board.js'

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

const board = createTrainingBoard({
  api,
  getSession: () => user.getSnapshot(),
  onTasks: (next) => { tasks.value = next },
  onError: (message) => { errorMessage.value = message }
})

async function loadAll() {
  loading.value = true
  errorMessage.value = ''
  try {
    datasets.value = await board.load()
    try {
      models.value = await listModels(user.getSnapshot())
      const active = models.value.find((item) => item.status === 'ACTIVE')
      if (form.initFrom === null && active) form.initFrom = active.version
    } catch (failure) {
      models.value = []
    }
    if (datasets.value.length && !datasets.value.some((item) => Number(item.id) === form.datasetId)) {
      form.datasetId = Number(datasets.value[0].id)
    }
    await board.refresh()
    if (board.polling()) return
    board.start()
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
    notice.value = `已提交训练任务 #${created.id}，worker 取到后会转为“训练中”。`
  } catch (failure) {
    errorMessage.value = failure?.message || '提交训练任务失败'
  } finally {
    submitting.value = false
  }
}

const refresh = () => loadAll()
loadAll()
onUnmounted(() => board.dispose())
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
        <label>样本数<input v-model.number="form.samples" name="samples" type="number" min="1000" max="60000" step="1000" /><small v-if="errors.samples" class="field-error">{{ errors.samples }}</small><small v-else class="muted">1 万样本 3 轮约 2 分钟；1000 条约 15 秒（样本太少效果很差）</small></label>
        <label>batchSize<select v-model.number="form.batchSize" name="batchSize"><option :value="32">32</option><option :value="64">64</option><option :value="128">128</option></select><small v-if="errors.batchSize" class="field-error">{{ errors.batchSize }}</small></label>
        <label>learningRate<input v-model.number="form.learningRate" name="learningRate" type="number" step="any" min="0" max="0.1" /><small v-if="errors.learningRate" class="field-error">{{ errors.learningRate }}</small></label>
        <label>seed<input v-model.number="form.seed" name="seed" type="number" step="1" min="0" max="4294967295" /><small v-if="errors.seed" class="field-error">{{ errors.seed }}</small></label>
        <label>照片增广比例<input v-model.number="form.photoRatio" name="photoRatio" type="number" step="0.1" min="0" max="1" /><small v-if="errors.photoRatio" class="field-error">{{ errors.photoRatio }}</small><small v-else class="muted">0–1，越大越偏向相册照片风格</small></label>
        <label>从哪个模型微调
          <select v-model="form.initFrom" name="initFrom">
            <option :value="null">从零训练</option>
            <option v-for="model in models" :key="model.version" :value="model.version">
              {{ model.version }}{{ model.status === 'ACTIVE' ? '（当前生效）' : '' }}
            </option>
          </select>
          <small v-if="errors.initFrom" class="field-error">{{ errors.initFrom }}</small>
          <small v-else class="muted">从已有权重继续训练，通常比从零训练更稳；版本须已在服务端注册</small>
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
      <p class="muted">有排队中/训练中的任务时每 4 秒自动刷新；全部结束会停止轮询。</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>任务</th><th>状态</th><th>参数</th><th>产物</th><th>指标</th></tr></thead>
          <tbody>
            <tr v-for="task in tasks" :key="task.id">
              <td>#{{ task.id }}<small class="cell-detail">{{ summarizeTask(task).attemptLabel }} · {{ summarizeTask(task).durationLabel }}</small></td>
              <td>
                {{ summarizeTask(task).statusLabel }}
                <small v-if="summarizeTask(task).errorLabel" class="cell-detail">{{ summarizeTask(task).errorLabel }}</small>
              </td>
              <td>{{ summarizeTask(task).paramsLabel }}<small class="cell-detail">微调自 {{ task.initFrom || '从零训练' }}</small></td>
              <td>
                {{ summarizeTask(task).versionLabel }}
                <small class="cell-detail">{{ summarizeTask(task).digestLabel }}</small>
              </td>
              <td>{{ summarizeTask(task).metricsLabel }}</td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="5">还没有训练任务</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
