import { computed, reactive, toRefs } from 'vue'
import { defineStore } from 'pinia'
import { getMe, login as loginApi } from '../api/auth.js'
import { createSession } from '../auth/session.js'

export const useUserStore = defineStore('user', () => {
  const session = createSession({ storage: localStorage, login: loginApi, getMe, reactive })
  return {
    ...toRefs(session.state),
    isAdmin: computed(() => session.isAdmin),
    displayName: computed(() => session.state.user?.nickname || session.state.user?.username || '未登录'),
    login: session.login,
    refresh: session.refresh,
    logout: session.logout,
    getSnapshot: session.getSnapshot,
    invalidate: session.invalidate
  }
})
