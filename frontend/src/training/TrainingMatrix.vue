<script setup>
import { computed, ref, watch } from 'vue'
import { DIGITS, cellIntensity, detailedView, domainOptions, formatScore } from '@/training/matrix.js'

const props = defineProps({ metrics: { type: Object, default: null } })

const options = computed(() => domainOptions(props.metrics))
const selected = ref('')

// 域名切换：新任务默认画板域，旧任务（只有 detailed_canvas）也只有一个选项
watch(options, (list) => {
  if (!list.length) { selected.value = ''; return }
  if (list.some((item) => item.key === selected.value)) return
  const preferred = list.find((item) => item.key === 'canvas_simulated')
  selected.value = preferred ? preferred.key : list[0].key
}, { immediate: true })

const view = computed(() => detailedView(props.metrics, selected.value || undefined))

const rows = computed(() => {
  if (!view.value) return []
  const { matrix, max } = view.value
  return DIGITS.map((truth) => ({
    truth,
    cells: DIGITS.map((guess) => ({
      key: `${truth}-${guess}`,
      count: matrix[truth][guess],
      intensity: cellIntensity(matrix[truth][guess], max)
    }))
  }))
})

const shownErrors = computed(() => (view.value ? view.value.errors.slice(0, 8) : []))

function shade(intensity) {
  if (!intensity) return 'transparent'
  return `rgba(47, 111, 208, ${(0.08 + intensity * 0.85).toFixed(2)})`
}
function select(domain) {
  selected.value = domain
}
</script>

<template>
  <div v-if="view" class="matrix-block">
    <div v-if="options.length > 1" class="domain-tabs">
      <button v-for="item in options" :key="item.key" type="button"
              class="domain-tab" :class="{ active: item.key === (selected || 'canvas_simulated') }"
              @click="select(item.key)">{{ item.label }}</button>
      <span class="muted">三个域各算一遍指标；模拟集与训练同源，数字偏乐观</span>
    </div>

    <div class="block-head">
      <h4>每类准确率</h4>
      <span class="muted">最弱：<template v-for="(item, index) in view.worst" :key="item.label">{{ index ? ' · ' : '' }}{{ item.label }}（{{ item.percent }}%）</template></span>
    </div>
    <div class="class-bars">
      <div v-for="item in view.perClass" :key="item.label" class="class-bar">
        <span class="class-name">{{ item.label }}</span>
        <span class="bar"><i :style="{ width: (item.percent || 0) + '%' }"></i></span>
        <span class="class-value">{{ item.percent === null ? '—' : item.percent + '%' }}</span>
      </div>
    </div>

    <template v-if="view.macro || view.weighted">
      <div class="block-head">
        <h4>查准 / 查全 / F1</h4>
        <span class="muted">
          宏平均 P {{ formatScore(view.macro && view.macro.precision) }} ·
          R {{ formatScore(view.macro && view.macro.recall) }} ·
          F1 {{ formatScore(view.macro && view.macro.f1) }}
          <template v-if="view.weighted">（按样本加权 F1 {{ formatScore(view.weighted.f1) }}）</template>
        </span>
      </div>
      <div class="prf-table">
        <div class="prf-row prf-head">
          <span>数字</span><span>样本</span><span>准确率</span><span>查准 P</span><span>查全 R</span><span>F1</span>
        </div>
        <div v-for="item in view.perClass" :key="'p' + item.label" class="prf-row">
          <span class="class-name">{{ item.label }}</span>
          <span class="muted">{{ item.total }}</span>
          <span>{{ item.percent === null ? '—' : item.percent + '%' }}</span>
          <span>{{ formatScore(item.precision) }}</span>
          <span>{{ formatScore(item.recall) }}</span>
          <span>{{ formatScore(item.f1) }}</span>
        </div>
      </div>
      <p class="hint">查准 = 判成该数字里有多少是对的；查全 = 该数字有多少被找出来；分母为 0 时显示“—”。</p>
    </template>

    <div class="block-head"><h4>混淆矩阵</h4><span class="muted">行 = 真实，列 = 预测</span></div>
    <div class="matrix">
      <span class="matrix-corner">真＼判</span>
      <span v-for="guess in DIGITS" :key="'h' + guess" class="matrix-head">{{ guess }}</span>
      <template v-for="row in rows" :key="'r' + row.truth">
        <span class="matrix-head">{{ row.truth }}</span>
        <span v-for="cell in row.cells" :key="cell.key" class="matrix-cell"
              :style="{ background: shade(cell.intensity) }"
              :title="`真实 ${row.truth} → 判成 ${cell.key.split('-')[1]}：${cell.count} 条`">
          {{ cell.count || '' }}
        </span>
      </template>
    </div>
    <p class="hint">对角线越亮越好；偏离对角线的格子就是“把这俩数字搞混了”的具体数量。</p>

    <template v-if="view.errorCount">
      <div class="block-head">
        <h4>错误样本回溯</h4>
        <span class="muted">共 {{ view.errorCount }} 条判错，下面按“模型最自信”排序前 {{ shownErrors.length }} 条</span>
      </div>
      <ul class="error-list">
        <li v-for="item in shownErrors" :key="`${item.index}-${item.truth}-${item.predicted}`">
          <span class="error-index">#{{ item.index }}</span>
          <span>真实 <b>{{ item.truth }}</b> → 判成 <b>{{ item.predicted }}</b></span>
          <span class="muted">置信度 {{ formatScore(item.confidence) }}</span>
        </li>
      </ul>
      <p class="hint">
        置信度最高的错误优先看：模型很确定却判错，通常是标签噪声或分布偏移。
        <template v-if="view.errorSheet">同目录的 <code>{{ view.errorSheet }}</code> 是这些样本的联络表图。</template>
      </p>
    </template>
  </div>
</template>
