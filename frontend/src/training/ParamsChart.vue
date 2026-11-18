<script setup>
/**
 * 参数与结果散点：X=样本数，Y=画板模拟准确率，点大小=轮数，颜色区分微调/从零。
 * 独立组件持有 echarts 实例，避免 v-for 里字符串 ref 拿到数组的问题。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  rows: { type: Array, default: () => [] },
  height: { type: Number, default: 300 }
})

const host = ref(null)
const chart = shallowRef(null)
const failed = ref(false)
let retries = 0

function option() {
  const grouped = { 从零训练: [], 微调: [] }
  for (const row of props.rows) {
    const series = row.initFrom ? grouped['微调'] : grouped['从零训练']
    series.push({
      name: `#${row.id}`,
      value: [row.samples, row.score],
      symbolSize: 10 + (Number(row.epochs) || 1) * 4,
      itemStyle: { color: row.initFrom ? '#7a5ab8' : '#2f6fd0', opacity: 0.75 }
    })
  }
  return {
    tooltip: {
      trigger: 'item',
      formatter: (item) => `${item.name}<br/>样本 ${item.value[0]} · 画板 ${item.value[1]}%`
    },
    legend: { bottom: 0 },
    grid: { left: 56, right: 24, top: 24, bottom: 44 },
    xAxis: { type: 'value', name: '样本数', min: 0 },
    yAxis: { type: 'value', name: '画板准确率 %', min: 0, max: 100 },
    series: [
      { name: '从零训练', type: 'scatter', data: grouped['从零训练'] },
      { name: '微调', type: 'scatter', data: grouped['微调'] }
    ]
  }
}

function render() {
  const element = host.value
  if (!element || failed.value) return
  if (!props.rows.length) {
    chart.value?.clear()
    return
  }
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
    <p v-else-if="!rows.length" class="muted" style="text-align: center; margin: 0">还没有带准确率的历史任务。</p>
  </div>
</template>
