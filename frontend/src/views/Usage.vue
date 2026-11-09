<script setup>
import QuotaTable from '@/components/QuotaTable.vue'
import { getResource } from '@/api/workspaces.js'
import { useWorkspaceResource } from '@/workspace/use-resource.js'
const resource = useWorkspaceResource(async (snapshot) => {
  const data = await getResource(snapshot, 'usage')
  if (data?.workspaceId !== snapshot.workspaceId || data.scope !== 'SELF' || !data.limits ||
    !['totalRequests', 'successfulRequests', 'failedRequests'].every((key) => Number.isInteger(data[key]) && data[key] >= 0)) throw new Error('用量接口返回了无效信息')
  return data
})
const state = resource.state
</script>

<template>
  <div class="stack wide-gap">
    <div class="section-heading"><p class="muted">仅本人在当前空间的持久化识别记录计数，不是全团队统计，也不是日配额余额。</p><button :disabled="state.loading" @click="resource.load()">刷新用量</button></div>
    <p v-if="state.loading" class="notice" role="status">正在读取真实记录计数…</p><p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
    <template v-if="state.data"><section class="panel"><h2>我的识别记录</h2><div class="table-wrap"><table><thead><tr><th>统计范围</th><th>总记录数</th><th>成功</th><th>失败</th></tr></thead><tbody><tr><td>SELF · 当前空间</td><td>{{ state.data.totalRequests }}</td><td>{{ state.data.successfulRequests }}</td><td>{{ state.data.failedRequests }}</td></tr></tbody></table></div><p class="muted">进行中的记录可能计入总数，成功与失败之和不保证等于总数。刷新读取最新状态。</p></section><section class="panel"><QuotaTable :limits="state.data.limits" /></section></template>
  </div>
</template>
