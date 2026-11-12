<script setup>
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { appConfig } from '@/app-config.js'
import { navigationLinks } from '@/router/routes.js'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const workspace = useWorkspaceStore()
const pilot = appConfig.pilot
const links = computed(() => navigationLinks({ pilot, superAdmin: user.isSuperAdmin }))
const needsWorkspace = computed(() => !pilot || route.path === '/recognize')
watch(() => user.isAuthenticated, (authenticated) => {
  if (authenticated && !workspace.active && !workspace.loading) void workspace.load()
}, { immediate: true })
function logout() {
  void user.logout()
  void router.replace('/login')
}
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar">
      <router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link>
      <p class="nav-label">{{ pilot ? '基础体验版' : '工作台' }}</p>
      <nav :aria-label="pilot ? '体验版导航' : '工作台导航'"><router-link v-for="[path, label] in links" :key="path" :to="path">{{ label }}</router-link></nav>
      <div v-if="pilot" class="sidebar-foot"><strong>写一个数字，查看结果</strong><p>遇到问题请联系维护者</p><router-link to="/">公开门户</router-link></div>
      <div v-else class="sidebar-foot"><router-link to="/">公开门户</router-link></div>
    </aside>
    <div class="app-body">
      <header class="app-header">
        <p v-if="pilot" class="muted">个人画板 · 默认空间自动核验</p>
        <label v-else class="space-select">当前空间
          <select aria-label="当前空间" :value="workspace.active?.id || ''" :disabled="workspace.loading || workspace.creating" @change="workspace.select($event.target.value)">
            <option value="" disabled>{{ workspace.loading || workspace.selecting ? '核验空间中…' : '请选择空间' }}</option>
            <option v-for="item in workspace.items" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <div class="account"><span>{{ user.displayName }}<small v-if="!pilot">{{ user.isSuperAdmin ? 'SUPER_ADMIN · 平台运营' : 'USER · 普通账号' }}</small></span><button @click="logout">退出登录</button></div>
      </header>
      <main class="main-content">
        <div class="page-heading"><div><p class="eyebrow">{{ pilot ? 'DIGIT STUDIO / 基础体验版' : `DIGIT STUDIO / ${workspace.active?.role || '未选择空间'}` }}</p><h1>{{ route.meta.title }}</h1></div><span v-if="workspace.active && !pilot" class="tag">{{ workspace.active.name }}</span></div>
        <p v-if="needsWorkspace && (workspace.loading || workspace.selecting)" class="notice" role="status">正在向服务器核验空间成员资格…</p>
        <div v-if="needsWorkspace && workspace.error" class="notice error" role="alert">{{ workspace.error }} <button :disabled="workspace.loading" @click="workspace.load()">重新加载空间</button></div>
        <p v-if="needsWorkspace && !workspace.active && !workspace.loading && !workspace.selecting && route.path !== '/home' && route.path !== '/platform'" class="notice"><template v-if="pilot">默认空间尚未核验通过，暂不可识别。请重新加载或<router-link to="/help">联系维护者</router-link>。</template><template v-else>请选择有效空间后使用此功能。<router-link to="/home">管理我的空间</router-link></template></p>
        <router-view />
      </main>
    </div>
  </div>
</template>
