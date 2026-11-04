const { getRuntime } = require('../config/runtime')
const { clearSession, snapshot, isSessionCurrent } = require('./session')
const TIMEOUT_MS = 15000 // Longer than Java's 2s connect + 10s read budgets.

function apiError(response) {
  let body = response.data
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch (_) { body = null }
  }
  const status = response.statusCode
  if (status >= 200 && status < 300 && body && body.code === 0) return { value: body.data }
  const code = status >= 400 ? status : (body && body.code) || status || 0
  const fallback = {
    401: '登录已失效，请重新登录', 403: '没有此操作权限', 404: '空间或资源不可访问',
    409: '请求冲突，请勿重复提交', 413: '图片过大（单图最多 5 MiB）',
    429: '请求过于频繁，请稍后重试', 502: '识别服务响应异常', 503: '识别服务暂不可用'
  }
  const details = body && body.data
  const headers = response.header || {}
  const retryAfter = details && details.retryAfterSeconds || headers['Retry-After'] || headers['retry-after']
  let message = body && typeof body.message === 'string' ? body.message : fallback[code] || '服务响应格式错误'
  if (retryAfter && code === 429) message += `（${retryAfter} 秒后重试）`
  return { error: Object.assign(new Error(message), {
    code, status, category: details && details.category, retryAfterSeconds: retryAfter,
    requestId: details && details.requestId
  }) }
}

// No global toast: the owning page must apply its session/space/revision guard first.
// abort() always settles, even if a platform task does not send its fail callback.
function transport(kind, options) {
  const app = getApp()
  const saved = options.snapshot || snapshot(app)
  const runtime = getRuntime(app)
  const current = () => isSessionCurrent(saved, app) && (!options.isCurrent || options.isCurrent())
  let task, settled = false, timer, rejectPromise
  const stale = () => Object.assign(new Error('请求已过期'), { stale: true })
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    if (!runtime.networkAllowed) {
      // Also clear any cached origin-bound candidate, without making a network request.
      snapshot(app)
      finish(Object.assign(new Error(runtime.error), { configuration: true }))
      return
    }
    if (!current()) { finish(stale()); return }
    const timeout = options.timeout || TIMEOUT_MS
    timer = setTimeout(() => {
      finish(current() ? Object.assign(new Error('请求超时，未自动重试；可明确发起新的识别'), { timeout: true }) : stale())
      if (task && task.abort) task.abort()
    }, timeout)
    if (timer && timer.unref) timer.unref()
    const header = {
      ...(options.auth === false || !saved.token ? {} : { Authorization: `Bearer ${saved.token}` }),
      ...options.header
    }
    const params = {
      url: runtime.apiBaseUrl + options.url,
      header, timeout,
      success(response) {
        if (settled) return
        if (!current()) { finish(stale()); return }
        const parsed = apiError(response)
        if (parsed.error && parsed.error.code === 401 && options.auth !== false && saved.token) {
          // A late 401 from a previous account/space/drawing cannot revoke a newer operation.
          if (clearSession(app, saved)) wx.reLaunch({ url: '/pages/login/login' })
        }
        finish(parsed.error, parsed.value)
      },
      fail(error) {
        if (!current()) { finish(stale()); return }
        const timedOut = /timeout/i.test(error && error.errMsg || '')
        finish(Object.assign(new Error(timedOut ? '请求超时，未自动重试' : '网络异常，请检查服务地址'), { timeout: timedOut }))
      }
    }
    if (kind === 'uploadFile') {
      Object.assign(params, { filePath: options.filePath, name: 'image', formData: options.formData })
    } else {
      Object.assign(params, { method: options.method || 'GET', data: options.data })
      params.header = { 'Content-Type': 'application/json', ...header }
    }
    try { task = wx[kind](params) } catch (error) { finish(error) }
  })
  promise.abort = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    rejectPromise(Object.assign(new Error('请求已取消'), { aborted: true }))
    if (task && task.abort) task.abort()
  }
  return promise
}

function request(options) { return transport('request', options) }
function upload(options) { return transport('uploadFile', options) }

module.exports = { request, upload, TIMEOUT_MS }
