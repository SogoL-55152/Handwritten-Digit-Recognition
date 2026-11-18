<script setup>
/** step 级曲线：loss（左轴）+ 学习率（右轴），数据来自 metrics.stepSeries。 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { stepSeriesOf } from '@/training/steps.js'

echarts.use([LineChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  metrics: { type: Object, default: null },
  height: { type: Number, default: 240 }
})

const host = ref(null)
const chart = shallowRef(null)
const failed = ref(false)
let retries = 0

function option() {
  const points = stepSeriesOf(props.metrics)
  const losses = points.map((point) => point.loss)
  const lrs = points.map((point) => point.lr)
  const lrMax = Math.max(1e-9, ...lrs.filter((value) => typeof value === 'number'))
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 52, right: 58, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: points.map((point) => point.step), name: 'step' },
    yAxis: [
      { type: 'value', name: '损失', position: 'left' },
      { type: 'value', name: '学习率', position: 'right', min: 0, max: lrMax }
    ],
    series: [
      { name: 'step 损失', type: 'line', smooth: true, showSymbol: false,
        data: losses.map((value) => (typeof value === 'number' ? value : null)) },
      { name: '学习率', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 1,
        data: lrs.map((value) => (typeof value === 'number' ? value : null)) }
    ]
  }
}

function render() {
  const element = host.value
  if (!element || failed.value) return
  const points = stepSeriesOf(props.metrics)
  if (!points.length) { chart.value?.clear(); return }
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
watch(() => [props.metrics], () => render())
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
  </div>
</template>
