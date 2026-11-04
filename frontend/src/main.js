import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useUserStore } from './stores/user.js'
import { configureRequest } from './api/request.js'
import { loginLocation } from './router/auth-guard.js'
import { appConfig } from './app-config.js'
import './styles/index.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
const user = useUserStore(pinia)
configureRequest({
  getSession: user.getSnapshot,
  onUnauthorized: (snapshot) => {
    if (!user.invalidate(snapshot)) return
    const current = router.currentRoute.value
    if (current.meta.requiresAuth) void router.replace(loginLocation(current.fullPath, 'expired', (target) => router.resolve(target), appConfig))
  }
})
app.use(router)
app.mount('#app')
