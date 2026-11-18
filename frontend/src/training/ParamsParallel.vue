<script setup>
/** 平行坐标：每条折线是一次训练，纵轴依次是样本数、轮数、batch、学习率、照片增广、准确率。 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { ParallelChart } from 'echarts/charts'
import { ParallelComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([ParallelChart, ParallelComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  rows: { type: Array, default: () => [] },
  height: { type: Number, default: 320 }
})

const host = ref(null)
const chart = shallowRef(null)
const failed = ref(false)
let retries = 0

const AXES = [
  { dim: 0, name: '样本数', min: 0 },
  { dim: 1, name: '轮数', min: 0 },
  { dim: 2, name: 'batch', min: 0 },
  { dim: 3, name: '学习率', min: 0 },
  { dim: 4, name: '照片增广', min: 0, max: 1 },
  { dim: 5, name: '准确率 %', min: 0, max: 100 }
]

function option() {
  const data = props.rows.map((row) => ({
    name: `#${row.id}`,
    value: [row.samples ?? 0, row.epochs ?? 0, row.batchSize ?? 0, row.learningRate ?? 0,
      row.photoRatio ?? 0, row.score ?? 0]
  }))
  return {
    tooltip: {
      formatter: (item) => {
        const v = item.value
        return `${item.name}<br/>样本 ${v[0]} · ${v[1]} 轮 · batch ${v[2]}<br/>lr ${v[3]} · 增广 ${v[4]} · 准确率 ${v[5]}%`
      }
    },
    parallel: {
      left: 40, right: 60, top: 36, bottom: 24,
      parallelAxisDefault: { type: 'value', nameLocation: 'start', nameGap: 12, nameTextStyle: { fontSize: 11 } }
    },
    parallelAxis: AXES.map((axis) => ({
      dim: axis.dim, name: axis.name, min: axis.min, max: axis.max,
      axisLine: { lineStyle: { color: '#c9d6e5' } }, splitLine: { show: false }
    })),
    series: [{
      type: 'parallel',
      lineStyle: { width: 2, opacity: 0.55 },
      emphasis: { lineStyle: { width: 4, opacity: 1 } },
      data
    }]
  }
}

function render() {
  const element = host.value
  if (!element || failed.value) return
  if (!props.rows.length) { chart.value?.clear(); return }
  if (!chart.value) {
    if (!element.clientWidth) {
      if (retries++ < 10) setTimeout(render, 60)
      else failed.value = true
      return
    }
    retries = 0
    const instance = echarts.init(element)
    if (!instance) { failed.value = true; return }
    chart.value = instance
  }
  chart.value.setOption(option(), true)
  chart.value.resize()
}

const resize = () => chart.value?.resize()
onMounted(() => {
  render()
  window.addEventListener('resize', resize)
})
watch(() => [props.rows], () => render())
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart.value?.dispose()
  chart.value = null
})
</script>

<template>
  <div>
    <div ref="host" class="chart" :style="{ height: height + 'px' }"></div>
    <p v-if="failed" class="muted" style="text-align: center">图表无法初始化（容器尺寸为 0），请刷新重试。</p>
    <p v-else-if="!rows.length" class="muted" style="text-align: center; margin: 0">还没有可比较的训练任务。</p>
  </div>
</template>
