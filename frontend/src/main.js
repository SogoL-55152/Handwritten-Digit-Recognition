import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'

import App from './App.vue'
import router from './router'
import { useUserStore } from './stores/user.js'
import { configureRequest } from './api/request.js'
import { loginLocation } from './router/auth-guard.js'
import './styles/index.css'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
const userStore = useUserStore(pinia)
configureRequest({
  getSession: userStore.getSnapshot,
  onUnauthorized: (snapshot) => {
    if (!userStore.invalidate(snapshot)) return
    const current = router.currentRoute.value
    if (current.path !== '/login') {
      void router.replace(loginLocation(current.fullPath, 'expired', (target) => router.resolve(target)))
    }
  },
  onError: (message) => ElMessage.error(message)
})
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
