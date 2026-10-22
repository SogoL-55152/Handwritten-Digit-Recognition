<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { activateModel, deleteModel, pageModels } from '@/api/model'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const loading = ref(false)
const rows = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(10)

async function load() {
  loading.value = true
  try {
    const data = await pageModels({ page: page.value, size: size.value })
    rows.value = data.records
    total.value = data.total
  } finally {
    loading.value = false
  }
}

async function activate(row) {
  try {
    await ElMessageBox.confirm(`确定将「${row.name}」设为活跃模型吗？`, '切换模型', {
      type: 'warning'
    })
  } catch {
    return
  }
  await activateModel(row.id)
  ElMessage.success('已切换活跃模型')
  load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除模型「${row.name}」吗？该操作不可恢复。`, '删除模型', {
      type: 'warning'
    })
  } catch {
    return
  }
  await deleteModel(row.id)
  ElMessage.success('模型已删除')
  load()
}

function accuracyText(value) {
  if (value === null || value === undefined) return '-'
  return `${(Number(value) * 100).toFixed(2)}%`
}

function formatTime(value) {
  return value ? value.replace('T', ' ').slice(0, 19) : '-'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">模型管理</h2>
        <p class="page-subtitle">同一时刻仅一个模型处于活跃状态，可随时切换</p>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="模型名称" min-width="150" />
        <el-table-column prop="version" label="版本" min-width="150" />
        <el-table-column label="准确率" width="110">
          <template #default="{ row }">{{ accuracyText(row.accuracy) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.active === 1 ? 'success' : 'info'" effect="plain">
              {{ row.active === 1 ? '活跃' : '未启用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="180" />
        <el-table-column label="创建时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column v-if="userStore.isAdmin" label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="row.active === 1"
              @click="activate(row)"
            >
              设为活跃
            </el-button>
            <el-button
              link
              type="danger"
              :disabled="row.active === 1"
              @click="remove(row)"
            >
              删除
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
  </div>
</template>
