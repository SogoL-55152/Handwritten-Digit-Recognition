import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user.js'
import { createAuthGuard } from './auth-guard.js'
import { createRoutes } from './routes.js'
import { appConfig } from '../app-config.js'

const router = createRouter({ history: createWebHistory(), routes: createRoutes(appConfig) })
router.beforeEach((to) => createAuthGuard({ session: useUserStore(), resolve: (target) => router.resolve(target), pilot: appConfig.pilot })(to))
router.afterEach((to, _from, failure) => {
  if (!failure) document.title = `${to.meta.title || '手写数字识别'} · Digit Studio`
})
export default router
