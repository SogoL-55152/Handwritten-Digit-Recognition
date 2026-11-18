<script setup>
import { computed, onMounted, ref } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { listTasks } from '@/api/training.js'
import { taskDetail } from '@/training/detail.js'
import TrainingCurve from '@/training/TrainingCurve.vue'
import TrainingMatrix from '@/training/TrainingMatrix.vue'
import { pickDefaultTask, taskOptions } from '@/training/visual.js'

const user = useUserStore()
const loading = ref(false)
const errorMessage = ref('')
const tasks = ref([])
const selectedId = ref(null)

const options = computed(() => taskOptions(tasks.value))
const selected = computed(() => tasks.value.find((task) => String(task.id) === String(selectedId.value)) || null)
const detail = computed(() => taskDetail(selected.value))
const history = computed(() => (selected.value?.metrics?.history) || [])
const summary = computed(() => {
  const metrics = selected.value?.metrics || {}
  const after = metrics.after || {}
  const percent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—')
  return [
    { label: 'MNIST', value: percent(after.raw_mnist_1000) },
    { label: '画板模拟', value: percent(after.canvas_simulated_1000) },
    { label: '照片模拟', value: percent(after.photo_simulated_1000) },
    { label: '轮数', value: history.value.length || '—' },
    { label: '真实样本', value: detail.value.composition.extraSamples ? `+${detail.value.composition.extraSamples}` : '0' }
  ]
})

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const session = user.getSnapshot()
    const list = await listTasks(session, 30)
    tasks.value = Array.isArray(list) ? list : []
    if (!options.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = pickDefaultTask(options.value)
    }
  } catch (error) {
    errorMessage.value = error?.message || '训练任务加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="stack wide-gap">
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">VISUAL</p>
          <h2>训练可视化</h2>
          <p class="muted">选中一次训练，查看逐轮指标、每轮耗时、每类准确率与混淆矩阵。</p>
        </div>
        <div class="row-actions"><button :disabled="loading" @click="load">刷新任务</button></div>
      </div>
      <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
      <p v-if="loading" class="muted">正在加载训练任务…</p>
      <p v-else-if="!options.length" class="muted">还没有训练任务。先到「训练任务」页发起一次训练。</p>
    </section>

    <section v-if="options.length" class="visual-layout">
      <aside class="panel visual-list">
        <h3>训练任务</h3>
        <ul>
          <li v-for="item in options" :key="item.id">
            <button type="button" class="visual-item" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
              <span class="visual-title">#{{ item.id }}<i>{{ item.status }}</i></span>
              <span class="visual-model">{{ item.modelVersion || '未产出模型' }}</span>
              <span class="visual-metrics">
                <i v-if="item.mnist !== null">MNIST {{ (item.mnist * 100).toFixed(1) }}%</i>
                <i v-if="item.canvas !== null">画板 {{ (item.canvas * 100).toFixed(1) }}%</i>
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <div class="stack" v-if="selected">
        <section class="panel">
          <div class="visual-head">
            <div><h3>任务 #{{ selected.id }}</h3><p class="muted">{{ selected.status }} · {{ selected.modelVersion || '未产出模型' }}</p></div>
            <div class="visual-summary">
              <div v-for="item in summary" :key="item.label" class="visual-stat"><small>{{ item.label }}</small><strong>{{ item.value }}</strong></div>
            </div>
          </div>
          <TrainingCurve :task-id="selected.id" :history="history" :height="360" />
        </section>

        <section class="panel">
          <TrainingDetail v-if="false" />
          <div class="block-head"><h4>每轮耗时</h4><span class="muted">最长 {{ detail.maxDuration }} ms</span></div>
          <div class="duration-bars" v-if="detail.hasHistory">
            <div v-for="(row, index) in detail.rows" :key="row.epoch" class="duration-bar">
              <span class="duration-label">第 {{ row.epoch }} 轮</span>
              <span class="bar"><i :style="{ width: Math.max(3, (detail.durations[index] / detail.maxDuration) * 100) + '%' }"></i></span>
              <span class="duration-value">{{ row.durationMs === null ? '—' : row.durationMs + ' ms' }}</span>
            </div>
          </div>
          <p v-else class="muted">该任务没有逐轮指标。</p>
        </section>

        <section class="panel visual-matrix">
          <TrainingMatrix :metrics="selected.metrics" />
          <p v-if="!detail.hasHistory" class="muted">该任务没有可展示的类别指标。</p>
        </section>
      </div>
    </section>
  </div>
</template>
