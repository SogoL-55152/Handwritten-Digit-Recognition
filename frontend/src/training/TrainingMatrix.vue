<script setup>
import { computed } from 'vue'
import { DIGITS, cellIntensity, detailedView } from '@/training/matrix.js'

const props = defineProps({ metrics: { type: Object, default: null } })
const view = computed(() => detailedView(props.metrics))
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
function shade(intensity) {
  if (!intensity) return 'transparent'
  return `rgba(47, 111, 208, ${(0.08 + intensity * 0.85).toFixed(2)})`
}
</script>

<template>
  <div v-if="view" class="matrix-block">
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
  </div>
</template>
