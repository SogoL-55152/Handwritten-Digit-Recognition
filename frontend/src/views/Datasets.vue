<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { createDataset, pageDatasets } from '@/api/dataset'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const loading = ref(false)
const rows = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(10)

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref()
const form = reactive({
  name: '',
  type: 'MNIST',
  sampleCount: 0,
  storagePath: '',
  description: ''
})
const rules = {
  name: [{ required: true, message: '请输入数据集名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择类型', trigger: 'change' }]
}

async function load() {
  loading.value = true
  try {
    const data = await pageDatasets({ page: page.value, size: size.value })
    rows.value = data.records
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function openDialog() {
  Object.assign(form, { name: '', type: 'MNIST', sampleCount: 0, storagePath: '', description: '' })
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
    await createDataset({ ...form })
    ElMessage.success('数据集已创建')
    dialogVisible.value = false
    load()
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">数据集</h2>
        <p class="page-subtitle">登记训练可用数据集（MNIST 已内置）</p>
      </div>
      <el-button v-if="userStore.isAdmin" type="primary" @click="openDialog">
        新建数据集
      </el-button>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="150" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <el-tag effect="plain">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sampleCount" label="样本数" width="120" />
        <el-table-column prop="storagePath" label="存储路径" min-width="180" />
        <el-table-column prop="description" label="说明" min-width="200" />
        <el-table-column label="创建时间" min-width="170">
          <template #default="{ row }">
            {{ row.createdAt ? row.createdAt.replace('T', ' ').slice(0, 19) : '-' }}
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

    <el-dialog v-model="dialogVisible" title="新建数据集" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：自采手写数据 v1" />
        </el-form-item>
        <el-form-item label="类型" prop="type">
          <el-select v-model="form.type" style="width: 100%">
            <el-option label="MNIST" value="MNIST" />
            <el-option label="自采数据 (CUSTOM)" value="CUSTOM" />
          </el-select>
        </el-form-item>
        <el-form-item label="样本数">
          <el-input-number v-model="form.sampleCount" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="存储路径">
          <el-input v-model="form.storagePath" placeholder="如：data/custom-v1" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
