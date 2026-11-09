<script setup>
import { onUnmounted, reactive } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { createScopedResource } from '@/workspace/resource.js'
import { getPlatform } from '@/api/workspaces.js'
import QuotaTable from '@/components/QuotaTable.vue'
const user = useUserStore()
const scope = { getSnapshot: user.getSnapshot, isCurrent: (snapshot) => user.isCurrent(snapshot) && user.isSuperAdmin, subscribe: user.subscribe }
const resource = createScopedResource({ scope, reactive, fetch: async (snapshot) => {
  const [health, quotas] = await Promise.all([getPlatform(snapshot, 'health-summary'), getPlatform(snapshot, 'quotas')])
  if (!Array.isArray(health?.services) || !quotas || typeof quotas.dailyQuotaEnforced !== 'boolean') throw new Error('平台接口返回了无效信息')
  return { health, quotas }
} })
const state = resource.state
void resource.load()
onUnmounted(resource.dispose)
</script>

<template>
  <div class="stack wide-gap">
    <div class="section-heading"><p class="muted">SUPER_ADMIN 专用只读页面。运营权限不绕过工作空间成员校验。</p><button :disabled="state.loading" @click="resource.load()">刷新状态</button></div>
    <p v-if="state.loading" class="notice" role="status">正在探测服务与加载有效配置…</p><p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
    <template v-if="state.data"><section class="panel"><h2>服务健康</h2><p class="muted">检查时间 {{ state.data.health.checkedAt }}</p><div class="table-wrap"><table><thead><tr><th>服务</th><th>状态</th><th>说明</th></tr></thead><tbody><tr v-for="service in state.data.health.services" :key="service.name"><td>{{ service.name }}</td><td>{{ service.status }}</td><td>{{ service.detail }}</td></tr><tr v-if="!state.data.health.services.length"><td colspan="3">服务列表为空；不能据此判断服务健康。</td></tr></tbody></table></div></section><section class="panel"><QuotaTable :limits="state.data.quotas" /><p class="muted">来源：{{ state.data.quotas.source }} · {{ state.data.quotas.restartRequired ? '配置修改需重启生效' : '重启要求以服务器配置为准' }}。此页不提供配额编辑。</p></section></template>
  </div>
</template>
