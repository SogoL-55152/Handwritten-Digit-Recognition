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
    redirect: '/home',
    children: [
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/Home.vue'),
        meta: { title: '首页' }
      }
      // 各成员在此追加自己的路由，例如：
      // { path: 'users', name: 'users', component: () => import('@/views/Users.vue'), meta: { title: '用户管理', admin: true } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/home' }
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
    return '/home'
  }
  if (to.meta.admin) {
    const raw = localStorage.getItem('hdr_user')
    try {
      const user = raw ? JSON.parse(raw) : null
      if (user?.role !== 'ADMIN') {
        return '/home'
      }
    } catch {
      return '/home'
    }
  }
  document.title = to.meta.title ? `${to.meta.title} · 手写数字识别系统` : '手写数字识别系统'
  return true
})

export default router
