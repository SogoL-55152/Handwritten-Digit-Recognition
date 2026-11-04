<script setup>
import { reactive, ref, watch } from 'vue'
import { validateTraining } from '@/training/validation.js'
const form = reactive({ modelName: '', architecture: 'DigitCNN', epoch: 3, batchSize: 64, learningRate: 0.001, seed: 42 })
const errors = ref({})
const checked = ref(false)
watch(form, () => { checked.value = false; errors.value = {} })
function validate() { errors.value = validateTraining(form); checked.value = true }
</script>

<template>
  <section class="panel training-panel">
    <p class="eyebrow">参数原型 · 不执行训练</p><h2>准备你的实验参数</h2>
    <p class="notice">W2 只在浏览器校验参数，不调用训练接口、不创建任务、不生成曲线。训练数据选项集成与在线训练分别在 W3 / W4 推进。</p>
    <form class="training-form" novalidate @submit.prevent="validate">
      <label>模型名称<input v-model="form.modelName" name="modelName" maxlength="64" placeholder="例如：我的 CNN 实验" /><small v-if="errors.modelName" class="field-error">{{ errors.modelName }}</small></label>
      <label>网络结构<input v-model="form.architecture" readonly /><small class="muted">固定 DigitCNN</small></label>
      <label>epoch<input v-model.number="form.epoch" name="epoch" type="number" min="1" max="5" step="1" /><small v-if="errors.epoch" class="field-error">{{ errors.epoch }}</small></label>
      <label>batchSize<select v-model.number="form.batchSize" name="batchSize"><option :value="32">32</option><option :value="64">64</option><option :value="128">128</option></select><small v-if="errors.batchSize" class="field-error">{{ errors.batchSize }}</small></label>
      <label>learningRate<input v-model.number="form.learningRate" name="learningRate" type="number" step="any" min="0" max="0.1" /><small v-if="errors.learningRate" class="field-error">{{ errors.learningRate }}</small></label>
      <label>seed<input v-model.number="form.seed" name="seed" type="number" step="1" min="0" max="4294967295" /><small v-if="errors.seed" class="field-error">{{ errors.seed }}</small></label>
      <div class="full-row"><button class="primary" type="submit">校验参数</button></div>
    </form>
    <p v-if="checked" role="status" class="notice" :class="{ error: Object.keys(errors).length }">{{ Object.keys(errors).length ? '参数尚未通过校验，请修改标记项。' : '参数校验通过。仅本地原型，没有提交训练任务。' }}</p>
  </section>
</template>
