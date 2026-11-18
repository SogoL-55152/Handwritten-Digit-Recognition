<script setup>
/** 网络结构示意图：纯 SVG 方块，输出形状与参数量随参数实时变化。 */
import { computed } from 'vue'
import { inferShapes, layerLabel } from '@/wizard/estimate.js'

const props = defineProps({
  layers: { type: Array, default: () => [] }
})

const shapes = computed(() => inferShapes(props.layers))
const blocks = computed(() => shapes.value.rows.filter((row) => row.type !== 'flatten'))
</script>

<template>
  <div class="net-diagram">
    <div class="net-canvas">
      <div class="net-input">
        <span class="net-box input">In</span>
        <small>28×28×1</small>
      </div>
      <div v-for="row in blocks" :key="row.index" class="net-block" :class="'net-' + row.type">
        <span class="net-box">{{ row.label.split('.')[1] || layerLabel(row.layer) }}</span>
        <small>{{ row.shape.h }}×{{ row.shape.w }}×{{ row.shape.c }}</small>
        <small v-if="row.params" class="net-params">{{ row.params.toLocaleString() }}</small>
      </div>
    </div>
    <div class="net-summary">
      <span>参数量 <strong>{{ shapes.totalParams.toLocaleString() }}</strong></span>
      <span>输出 <strong>{{ shapes.output.c }}</strong> 维</span>
      <span v-if="shapes.errors.length" class="net-error">✗ {{ shapes.errors[0] }}</span>
    </div>
  </div>
</template>
