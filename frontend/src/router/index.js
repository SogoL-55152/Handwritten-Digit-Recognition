import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/',
    component: () => import('@/layout/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '概览' }
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/views/Users.vue'),
        meta: { title: '用户管理', admin: true }
      },
      {
        path: 'datasets',
        name: 'datasets',
        component: () => import('@/views/Datasets.vue'),
        meta: { title: '数据集' }
      },
      {
        path: 'models',
        name: 'models',
        component: () => import('@/views/Models.vue'),
        meta: { title: '模型管理' }
      },
      {
        path: 'train-tasks',
        name: 'train-tasks',
        component: () => import('@/views/TrainTasks.vue'),
        meta: { title: '训练任务' }
      },
      {
        path: 'train-tasks/:id',
        name: 'train-task-detail',
        component: () => import('@/views/TrainTaskDetail.vue'),
        meta: { title: '训练详情' }
      },
      {
        path: 'stats',
        name: 'stats',
        component: () => import('@/views/Stats.vue'),
        meta: { title: '统计分析' }
      }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to) => {
  const token = localStorage.getItem('hdr_token')
  if (to.path !== '/login' && !token) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.path === '/login' && token) {
    return '/dashboard'
  }
  if (to.meta.admin) {
    const raw = localStorage.getItem('hdr_user')
    try {
      const user = raw ? JSON.parse(raw) : null
      if (user?.role !== 'ADMIN') {
        return '/dashboard'
      }
    } catch {
      return '/dashboard'
    }
  }
  document.title = to.meta.title ? `${to.meta.title} · 手写数字识别系统` : '手写数字识别系统'
  return true
})

export default router
