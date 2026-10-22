<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { createTrainTask, pageTrainTasks } from '@/api/train'
import { pageDatasets } from '@/api/dataset'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()

const loading = ref(false)
const rows = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(10)
const datasets = ref([])

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref()
const form = reactive({
  name: '',
  datasetId: null,
  modelName: 'cnn-v1',
  epochs: 3,
  batchSize: 128,
  learningRate: 0.001
})
const rules = {
  name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  datasetId: [{ required: true, message: '请选择数据集', trigger: 'change' }],
  modelName: [{ required: true, message: '请输入模型名称', trigger: 'blur' }]
}

const statusMap = {
  PENDING: { text: '排队中', type: 'info' },
  RUNNING: { text: '训练中', type: 'warning' },
  SUCCESS: { text: '已完成', type: 'success' },
  FAILED: { text: '失败', type: 'danger' }
}

async function load() {
  loading.value = true
  try {
    const data = await pageTrainTasks({ page: page.value, size: size.value })
    rows.value = data.records
    total.value = data.total
  } finally {
    loading.value = false
  }
}

async function loadDatasets() {
  const data = await pageDatasets({ page: 1, size: 100 })
  datasets.value = data.records
}

async function openDialog() {
  Object.assign(form, {
    name: '',
    datasetId: datasets.value[0]?.id ?? null,
    modelName: 'cnn-v1',
    epochs: 3,
    batchSize: 128,
    learningRate: 0.001
  })
  dialogVisible.value = true
}

async function submit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true
  try {
    const task = await createTrainTask({
      name: form.name,
      datasetId: form.datasetId,
      modelName: form.modelName,
      params: {
        epochs: form.epochs,
        batchSize: form.batchSize,
        learningRate: form.learningRate
      }
    })
    ElMessage.success('训练任务已创建')
    dialogVisible.value = false
    router.push(`/train-tasks/${task.id}`)
  } finally {
    submitting.value = false
  }
}

function formatTime(value) {
  return value ? value.replace('T', ' ').slice(0, 19) : '-'
}

onMounted(async () => {
  await Promise.all([load(), loadDatasets()])
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">训练任务</h2>
        <p class="page-subtitle">选择数据集与超参数，异步训练并实时查看曲线</p>
      </div>
      <el-button v-if="userStore.isAdmin" type="primary" @click="openDialog">
        新建训练任务
      </el-button>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="任务名称" min-width="150" />
        <el-table-column prop="modelName" label="模型名称" min-width="130" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status]?.type || 'info'" effect="plain">
              {{ statusMap[row.status]?.text || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进度" min-width="160">
          <template #default="{ row }">
            <el-progress :percentage="row.progress || 0" :stroke-width="8" />
          </template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(`/train-tasks/${row.id}`)">
              查看
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="size"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="load"
        />
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" title="新建训练任务" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="任务名称" prop="name">
          <el-input v-model="form.name" placeholder="如：cnn-实验一" />
        </el-form-item>
        <el-form-item label="数据集" prop="datasetId">
          <el-select v-model="form.datasetId" style="width: 100%" placeholder="请选择">
            <el-option
              v-for="item in datasets"
              :key="item.id"
              :label="`${item.name}（${item.sampleCount} 样本）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="模型名称" prop="modelName">
          <el-input v-model="form.modelName" />
        </el-form-item>
        <el-form-item label="训练轮数">
          <el-input-number v-model="form.epochs" :min="1" :max="50" style="width: 100%" />
        </el-form-item>
        <el-form-item label="批大小">
          <el-input-number v-model="form.batchSize" :min="1" :max="2048" style="width: 100%" />
        </el-form-item>
        <el-form-item label="学习率">
          <el-input-number
            v-model="form.learningRate"
            :min="0.00001"
            :max="1"
            :step="0.0005"
            :precision="5"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">创建并开始训练</el-button>
      </template>
    </el-dialog>
  </div>
</template>
