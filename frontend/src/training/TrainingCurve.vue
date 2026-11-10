<script setup>
/**
 * 单个任务的逐轮曲线。放在展开行里，随行挂载/卸载，实例生命周期跟着组件走。
 * 注意：不能用 v-for 里的字符串 ref 去 init ECharts（那样拿到的是数组），
 * 所以这里用独立组件，模板里的 ref 只有一个宿主元素。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { trainingCurveOption } from '@/statistics/chart.js'

echarts.use([LineChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  taskId: { type: [String, Number], default: '' },
  history: { type: Array, default: () => [] }
})

const host = ref(null)
const chart = shallowRef(null)
const failed = ref(false)
let retries = 0

function render() {
  const element = host.value
  if (!element || failed.value) return
  if (!Array.isArray(props.history) || props.history.length === 0) {
    chart.value?.clear()
    return
  }
  if (!chart.value) {
    // 展开行刚插入时可能还没完成布局，宽度为 0 时 ECharts 会画出空白，这里重试几次。
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
  chart.value.setOption(trainingCurveOption(props.history, `任务 #${props.taskId} 逐轮指标`), true)
  chart.value.resize()
}

const resize = () => chart.value?.resize()

onMounted(() => {
  render()
  window.addEventListener('resize', resize)
})
watch(() => [props.history, props.taskId], () => render())
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart.value?.dispose()
  chart.value = null
})
</script>

<template>
  <div>
    <div ref="host" class="chart" style="height: 320px"></div>
    <p v-if="failed" class="muted" style="text-align: center">图表无法初始化（容器尺寸为 0），请刷新重试。</p>
    <p v-else-if="!history || !history.length" class="muted" style="text-align: center; margin: 0">
      该任务还没有逐轮指标。
    </p>
  </div>
</template>
