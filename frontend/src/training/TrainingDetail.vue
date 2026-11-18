<script setup>
import { computed } from 'vue'
import { taskDetail } from '@/training/detail.js'

const props = defineProps({ task: { type: Object, default: null } })
const detail = computed(() => taskDetail(props.task))
</script>

<template>
  <div v-if="task" class="training-detail">
    <div class="param-cards">
      <div v-for="card in detail.cards" :key="card.key" class="param-card">
        <small>{{ card.label }}</small><strong>{{ card.value }}</strong>
      </div>
    </div>

    <p class="muted">
      训练集：内置样本 {{ detail.composition.rendered ?? '—' }} 条
      <template v-if="detail.composition.extraSamples"> ＋ 数据集版本 {{ detail.composition.extraSamples }} 条</template>
      <template v-if="detail.composition.unusable"> （跳过不可用 {{ detail.composition.unusable }} 条）</template>
    </p>

    <template v-if="detail.hasHistory">
      <div class="duration-block">
        <div class="block-head"><h4>每轮耗时</h4><span class="muted">最长 {{ detail.maxDuration }} ms</span></div>
        <div class="duration-bars">
          <div v-for="(row, index) in detail.rows" :key="row.epoch" class="duration-bar">
            <span class="duration-label">第 {{ row.epoch }} 轮</span>
            <span class="bar"><i :style="{ width: Math.max(3, (detail.durations[index] / detail.maxDuration) * 100) + '%' }"></i></span>
            <span class="duration-value">{{ row.durationMs === null ? '—' : row.durationMs + ' ms' }}</span>
          </div>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr><th>轮次</th><th>损失</th><th>MNIST</th><th>画板模拟</th><th>照片模拟</th><th>耗时</th></tr></thead>
          <tbody>
            <tr v-for="row in detail.rows" :key="row.epoch">
              <td>{{ row.epoch }}</td>
              <td>{{ row.loss === null ? '—' : row.loss }}</td>
              <td>{{ row.mnist === null ? '—' : row.mnist + '%' }}</td>
              <td>{{ row.canvas === null ? '—' : row.canvas + '%' }}</td>
              <td>{{ row.photo === null ? '—' : row.photo + '%' }}</td>
              <td>{{ row.durationMs === null ? '—' : row.durationMs + ' ms' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="muted">还没有逐轮指标（任务尚未开始或已失败）。</p>
  </div>
</template>
