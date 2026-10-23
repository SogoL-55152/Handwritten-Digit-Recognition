<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

// 各成员按模块向菜单追加条目，例如 { path: '/users', label: '用户管理' }
const menuItems = computed(() => [{ path: '/home', label: '首页' }])

const activeMenu = computed(() => route.path)
const pageTitle = computed(() => route.meta.title || '')

async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定退出登录吗？', '提示', { type: 'warning' })
  } catch {
    return
  }
  userStore.logout()
  router.push('/login')
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="220px" class="sidebar">
      <div class="brand">
        <span class="brand-dot" />
        <span>手写数字识别</span>
      </div>
      <el-menu :default-active="activeMenu" router class="menu">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          {{ item.label }}
        </el-menu-item>
      </el-menu>
      <div class="sidebar-foot">v0.1 · W1 骨架</div>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-title">{{ pageTitle }}</div>
        <el-dropdown>
          <span class="user-trigger">{{ userStore.displayName }} ▾</span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>
                {{ userStore.user?.role === 'ADMIN' ? '管理员' : '普通用户' }}
              </el-dropdown-item>
              <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>

      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  border-right: 1px solid #e6eaf2;
  background: #ffffff;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 22px;
  font-size: 16px;
  font-weight: 600;
  color: #1f2d3d;
}

.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--hdr-primary);
  box-shadow: 0 0 0 4px rgba(59, 110, 246, 0.15);
}

.menu {
  flex: 1;
  border-right: none;
  padding: 8px;
}

.menu :deep(.el-menu-item) {
  height: 44px;
  margin-bottom: 4px;
  border-radius: 8px;
  color: #4a5568;
}

.menu :deep(.el-menu-item.is-active) {
  background: #eef3ff;
  color: var(--hdr-primary);
  font-weight: 600;
}

.sidebar-foot {
  padding: 16px 22px;
  font-size: 12px;
  color: #a0a8b8;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
  background: #ffffff;
  border-bottom: 1px solid #e6eaf2;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
}

.user-trigger {
  cursor: pointer;
  color: #4a5568;
  outline: none;
}

.main {
  padding: 0;
  background: var(--hdr-bg);
  overflow-y: auto;
}
</style>
