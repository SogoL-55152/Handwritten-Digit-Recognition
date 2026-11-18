<script setup>
import { computed, onMounted, ref } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { listTasks } from '@/api/training.js'
import { taskDetail } from '@/training/detail.js'
import TrainingCurve from '@/training/TrainingCurve.vue'
import TrainingMatrix from '@/training/TrainingMatrix.vue'
import { pickDefaultTask, taskOptions } from '@/training/visual.js'
import { diffRows, fineTunePairs, paramRows, rankedRows, spreadOf } from '@/training/params.js'
import ParamsParallel from '@/training/ParamsParallel.vue'
import ParamsChart from '@/training/ParamsChart.vue'

const user = useUserStore()
const loading = ref(false)
const errorMessage = ref('')
const tasks = ref([])
const selectedId = ref(null)

const options = computed(() => taskOptions(tasks.value))
const rows = computed(() => paramRows(tasks.value))
const ranked = computed(() => rankedRows(rows.value))
const spread = computed(() => spreadOf(rows.value))
const best = computed(() => ranked.value[0] || null)
const pairs = computed(() => fineTunePairs(rows.value))
const compareA = ref(null)
const compareB = ref(null)
const compareRows = computed(() => diffRows(
  ranked.value.find((row) => row.id === compareA.value),
  ranked.value.find((row) => row.id === compareB.value)
))
const compareHistoryA = computed(() => tasks.value.find((task) => String(task.id) === compareA.value)?.metrics?.history || [])
const compareHistoryB = computed(() => tasks.value.find((task) => String(task.id) === compareB.value)?.metrics?.history || [])
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
    if (!compareA.value) compareA.value = ranked.value[0]?.id || null
    if (!compareB.value) compareB.value = ranked.value[1]?.id || null
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

        <section class="panel">
          <div class="block-head">
            <h4>参数与结果</h4>
            <span class="muted">同一批任务里，参数变了多少、结果差多少</span>
          </div>
          <p v-if="!ranked.length" class="muted">还没有带准确率的历史任务，训练完成后这里会给出对照。</p>
          <template v-else>
            <div class="rank-list">
              <div v-for="row in ranked.slice(0, 6)" :key="row.id" class="rank-item" :class="{ best: best && row.id === best.id }">
                <span class="rank-id">#{{ row.id }}</span>
                <span class="bar"><i :style="{ width: Math.max(3, row.score) + '%' }"></i></span>
                <span class="rank-score">{{ row.score }}%</span>
                <small>样本 {{ row.samples }} · {{ row.epochs }} 轮 · lr {{ row.learningRate }}<template v-if="row.initFrom"> · 微调自 {{ row.initFrom }}</template></small>
              </div>
            </div>

            <div class="spread-hint">
              <span v-for="(value, key) in spread" :key="key" class="spread-chip">{{ key }} 有 {{ value }} 种取值</span>
            </div>

            <ParamsChart :rows="ranked" :height="300" />
          </template>
        </section>

        <section class="panel">
          <div class="block-head"><h4>平行坐标</h4><span class="muted">一条线是一次训练，跨 6 个轴看参数组合</span></div>
          <ParamsParallel :rows="ranked" :height="320" />
        </section>

        <section class="panel">
          <div class="block-head"><h4>两次训练对比</h4><span class="muted">并排看曲线与参数差异</span></div>
          <div class="compare-pickers">
            <label>左 <select v-model="compareA"><option v-for="row in ranked" :key="row.id" :value="row.id">#{{ row.id }}（{{ row.score }}%）</option></select></label>
            <label>右 <select v-model="compareB"><option v-for="row in ranked" :key="row.id" :value="row.id">#{{ row.id }}（{{ row.score }}%）</option></select></label>
          </div>
          <div v-if="compareA && compareB" class="compare-grid">
            <div class="compare-col"><h4>任务 #{{ compareA }}</h4><TrainingCurve :task-id="compareA" :history="compareHistoryA" :height="220" /></div>
            <div class="compare-col"><h4>任务 #{{ compareB }}</h4><TrainingCurve :task-id="compareB" :history="compareHistoryB" :height="220" /></div>
          </div>
          <div class="table-wrap" v-if="compareRows.length">
            <table>
              <thead><tr><th>参数</th><th>#{{ compareA }}</th><th>#{{ compareB }}</th></tr></thead>
              <tbody>
                <tr v-for="row in compareRows" :key="row.key" :class="{ diff: !row.same }">
                  <td>{{ row.label }}</td><td>{{ row.left ?? '—' }}</td><td>{{ row.right ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted">至少需要两个带准确率的任务才能对比。</p>
        </section>

        <section class="panel">
          <div class="block-head"><h4>微调效果</h4><span class="muted">微调任务 vs 它的起点模型</span></div>
          <p v-if="!pairs.length" class="muted">还没有微调任务（起点不为空）的记录。</p>
          <div v-else class="rank-list">
            <div v-for="pair in pairs" :key="pair.id" class="rank-item">
              <span class="rank-id">#{{ pair.id }}</span>
              <span class="bar"><i :style="{ width: Math.max(3, pair.score || 0) + '%' }"></i></span>
              <span class="rank-score">{{ pair.score === null ? '—' : pair.score + '%' }}</span>
              <small>
                起点 {{ pair.baseVersion }}{{ pair.baseId ? '（任务 #' + pair.baseId + '）' : '' }}
                · 起点准确率 {{ pair.baseScore === null ? '未知' : pair.baseScore + '%' }}
                <span v-if="pair.delta !== null" class="delta-chip" :class="{ up: pair.delta > 0, down: pair.delta < 0 }">
                  {{ pair.delta > 0 ? '+' : '' }}{{ pair.delta }} 个点
                </span>
              </small>
            </div>
          </div>
        </section>

        <section class="panel visual-matrix">
          <TrainingMatrix :metrics="selected.metrics" />
          <p v-if="!detail.hasHistory" class="muted">该任务没有可展示的类别指标。</p>
        </section>
      </div>
    </section>
  </div>
</template>
