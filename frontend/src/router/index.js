import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user.js'
import { createAuthGuard } from './auth-guard.js'

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
    meta: { requiresAuth: true, admin: true },
    children: [
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/Home.vue'),
        meta: { title: '首页', admin: true }
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

router.beforeEach((to) => createAuthGuard({
  session: useUserStore(),
  resolve: (target) => router.resolve(target)
})(to))

router.afterEach((to, _from, failure) => {
  if (failure) return
  document.title = to.meta.title ? `${to.meta.title} · 手写数字识别系统` : '手写数字识别系统'
})

export default router
