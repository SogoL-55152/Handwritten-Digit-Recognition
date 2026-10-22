<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getOverview } from '@/api/stats'

const router = useRouter()
const loading = ref(false)
const overview = ref({})

const accuracyText = computed(() =>
  `${((Number(overview.value.accuracy) || 0) * 100).toFixed(2)}%`
)

const cards = computed(() => [
  { label: '注册用户', value: overview.value.userCount ?? 0, suffix: '人' },
  { label: '模型总数', value: overview.value.modelCount ?? 0, suffix: '个' },
  { label: '识别调用量', value: overview.value.callCount ?? 0, suffix: '次' },
  { label: '模型平均准确率', value: accuracyText.value, suffix: '' }
])

const steps = [
  { title: '准备数据集', desc: '默认已内置 MNIST，可在“数据集”页面登记自采数据。', action: '/datasets' },
  { title: '发起训练', desc: '选择数据集与超参数，训练进度与曲线实时展示。', action: '/train-tasks' },
  { title: '启用模型', desc: '训练完成后在模型管理中一键切换活跃模型。', action: '/models' },
  { title: '小程序识别', desc: '用户书写数字，经网关转发至活跃模型完成识别。', action: '/stats' }
]

onMounted(async () => {
  loading.value = true
  try {
    overview.value = await getOverview()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">系统概览</h2>
        <p class="page-subtitle">掌握模型、调用与训练的整体状态</p>
      </div>
      <el-tag v-if="overview.activeModel" type="success" effect="plain">
        活跃模型：{{ overview.activeModel }}
      </el-tag>
      <el-tag v-else type="info" effect="plain">尚未启用模型</el-tag>
    </div>

    <div class="stat-grid">
      <el-card v-for="card in cards" :key="card.label" class="stat-card" shadow="never">
        <div class="stat-label">{{ card.label }}</div>
        <div class="stat-value">{{ card.value }}<span class="unit">{{ card.suffix }}</span></div>
      </el-card>
    </div>

    <el-card class="chart-card" shadow="never">
      <template #header>
        <span>上手流程</span>
      </template>
      <el-row :gutter="16">
        <el-col v-for="(step, index) in steps" :key="step.title" :xs="24" :sm="12" :md="6">
          <div class="step" @click="router.push(step.action)">
            <div class="step-index">0{{ index + 1 }}</div>
            <div class="step-title">{{ step.title }}</div>
            <div class="step-desc">{{ step.desc }}</div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<style scoped>
.unit {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 400;
  color: #8a94a6;
}

.step {
  height: 100%;
  padding: 18px;
  border: 1px solid #eef1f6;
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.2s;
}

.step:hover {
  border-color: #c7d7ff;
  transform: translateY(-2px);
}

.step-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--hdr-primary);
}

.step-title {
  margin: 10px 0 6px;
  font-weight: 600;
}

.step-desc {
  font-size: 13px;
  line-height: 1.6;
  color: #7b8496;
}
</style>
