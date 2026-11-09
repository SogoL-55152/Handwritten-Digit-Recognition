import { computed, reactive, toRefs } from 'vue'
import { defineStore } from 'pinia'
import * as auth from '../api/auth.js'
import { createSession } from '../auth/session.js'

export const useUserStore = defineStore('user-v2', () => {
  const session = createSession({ storage: localStorage, ...auth, reactive })
  return {
    ...toRefs(session.state),
    isAuthenticated: computed(() => session.isAuthenticated),
    isSuperAdmin: computed(() => session.isSuperAdmin),
    displayName: computed(() => session.state.user?.nickname || session.state.user?.username || '未登录'),
    login: session.login, register: session.register, changePassword: session.changePassword, refresh: session.refresh, logout: session.logout,
    getSnapshot: session.getSnapshot, isCurrent: session.isCurrent, invalidate: session.invalidate, subscribe: session.subscribe
  }
})
