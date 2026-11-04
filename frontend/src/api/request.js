import axios from 'axios'
import { isUnauthorized } from '../auth/session.js'

// Hooks are injected at app startup. HTTP code never imports the store or router.
export function createRequest({ hooks = {}, adapter } = {}) {
  const client = axios.create({
    baseURL: '/api/v2',
    timeout: 20000,
    ...(adapter ? { adapter } : {})
  })

  client.interceptors.request.use((config) => {
    if (!config.skipAuth) {
      config.authSession = config.authSession || hooks.getSession?.()
      if (config.authSession?.token) {
        config.headers.Authorization = `Bearer ${config.authSession.token}`
      }
    }
    return config
  })

  function reject(error, config) {
    // Validation owns its failure state; other requests invalidate only their own session.
    if (isUnauthorized(error) && !config?.skipAuth && !config?.sessionValidation) {
      hooks.onUnauthorized?.(config?.authSession)
    }
    if (!config?.silent) hooks.onError?.(error.message || '网络异常，请稍后重试')
    return Promise.reject(error)
  }

  client.interceptors.response.use(
    (response) => {
      const body = response.data
      if (body && body.code === 0) return body.data
      const error = new Error(body?.message || '服务器返回了无效响应，请稍后重试')
      error.code = body?.code
      error.status = response.status
      error.data = body?.data
      error.retryAfter = response.headers?.['retry-after']
      return reject(error, response.config)
    },
    (error) => {
      error.status = error.response?.status
      error.code = error.response?.data?.code
      error.data = error.response?.data?.data
      error.retryAfter = error.response?.headers?.['retry-after']
      error.message = error.response?.data?.message || error.message || '网络异常，请稍后重试'
      return reject(error, error.config)
    }
  )

  return client
}

const hooks = {}
export function configureRequest(options) {
  Object.assign(hooks, options)
}

export default createRequest({ hooks })
