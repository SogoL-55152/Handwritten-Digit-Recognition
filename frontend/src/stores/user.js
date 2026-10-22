import { defineStore } from 'pinia'
import { getMe, login as loginApi } from '@/api/auth'

function readUser() {
  try {
    return JSON.parse(localStorage.getItem('hdr_user') || 'null')
  } catch {
    return null
  }
}

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('hdr_token') || '',
    user: readUser()
  }),
  getters: {
    isAdmin: (state) => state.user?.role === 'ADMIN',
    displayName: (state) => state.user?.nickname || state.user?.username || '未登录'
  },
  actions: {
    async login(form) {
      const data = await loginApi(form)
      this.token = data.token
      this.user = data.user
      localStorage.setItem('hdr_token', data.token)
      localStorage.setItem('hdr_user', JSON.stringify(data.user))
    },
    async refresh() {
      if (!this.token) return
      try {
        this.user = await getMe()
        localStorage.setItem('hdr_user', JSON.stringify(this.user))
      } catch {
        // token 失效由请求拦截器处理
      }
    },
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem('hdr_token')
      localStorage.removeItem('hdr_user')
    }
  }
})
