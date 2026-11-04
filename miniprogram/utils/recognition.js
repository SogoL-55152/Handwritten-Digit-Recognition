const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function nativeUuid(result) {
  const value = result && result.randomValues
  const view = ArrayBuffer.isView(value)
  // The intrinsic getter checks the real buffer brand across realms, unlike instanceof/toString.
  const length = view ? value.byteLength : Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(value)
  if (length !== 16) throw new Error('Invalid random bytes')
  const bytes = new Uint8Array(new Uint8Array(view ? value.buffer : value, view ? value.byteOffset : 0, length))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// One explicit user action: native crypto first, at most one caller-owned server fallback.
function createRequestId(options = {}) {
  let phase = 'native', timer, fallbackTask, finish
  const current = () => !options.isCurrent || options.isCurrent()
  const promise = new Promise((resolve, reject) => {
    finish = (error, id, generator) => {
      if (phase === 'done') return
      phase = 'done'
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(id)
      if (!error && current() && options.onGenerator) {
        try { options.onGenerator(generator) } catch (_) { /* Diagnostics must not change the result. */ }
      }
    }
    const active = (expected) => {
      if (phase !== expected) return false
      if (current()) return true
      finish(Object.assign(new Error('请求已过期，请重新操作'), { stale: true }))
      return false
    }
    const fallback = (reason) => {
      if (!active('native')) return
      phase = 'server' // Close the native path before calling user code or awaiting the server.
      clearTimeout(timer)
      if (typeof options.fallback !== 'function') {
        const messages = {
          unavailable: '暂时无法生成请求标识，请重试', failed: '请求标识生成失败，请重试',
          threw: '请求标识生成暂不可用，请重试', malformed: '请求标识生成结果无效，请重试',
          timeout: '请求标识生成超时，请重试'
        }
        finish(Object.assign(new Error(messages[reason]), { generator: 'native', reason }))
        return
      }
      const failed = (error) => {
        if (active('server')) finish(error || new Error('请求标识生成失败，请重试'))
      }
      try {
        fallbackTask = options.fallback()
        Promise.resolve(fallbackTask).then((result) => {
          if (!active('server')) return
          const id = result && result.requestId
          if (typeof id !== 'string' || id.length !== 36 || !UUID_V4.test(id)) {
            finish(new Error('服务返回的请求标识无效，请重试'))
          } else finish(null, id.toLowerCase(), 'server')
        }, failed)
      } catch (error) { failed(error) }
    }
    const success = (result) => {
      if (!active('native')) return
      let id
      try { id = nativeUuid(result) } catch (_) { fallback('malformed'); return }
      finish(null, id, 'native')
    }
    if (!active('native')) return
    timer = setTimeout(() => fallback('timeout'), 3000)
    if (timer && timer.unref) timer.unref()
    try {
      if (typeof wx === 'undefined' || typeof wx.getRandomValues !== 'function') {
        fallback('unavailable')
        return
      }
      const task = wx.getRandomValues({ length: 16, success, fail: () => fallback('failed') })
      if (task && typeof task.then === 'function') Promise.resolve(task).then(success, () => fallback('failed'))
    } catch (_) { fallback('threw') }
  })
  promise.abort = () => {
    if (phase === 'done') return
    finish(Object.assign(new Error('请求已取消'), { aborted: true }))
    try { if (fallbackTask && fallbackTask.abort) fallbackTask.abort() } catch (_) { /* Already cancelled. */ }
  }
  return promise
}

function validWorkspace(value) {
  return !!(value && typeof value.id === 'string' && value.id &&
    typeof value.name === 'string' && ['OWNER', 'ADMIN', 'MEMBER'].includes(value.role) &&
    value.status === 'ACTIVE')
}

function validateResult(result, requestId) {
  if (!result || result.requestId !== requestId || typeof result.recognitionId !== 'string' || !result.recognitionId ||
      !Number.isInteger(result.digit) || result.digit < 0 || result.digit > 9 ||
      !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
      typeof result.modelId !== 'string' || !result.modelId || result.modelVersion !== 'w1-full-3epoch' ||
      result.preprocessVersion !== 'canvas-mnist-v1' || result.source !== 'MINIPROGRAM' ||
      !Number.isFinite(result.processingMs) || result.processingMs < 0 ||
      typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))) {
    throw new Error('识别响应与请求或基线合同不一致，请重新操作')
  }
  return { ...result, confidencePercent: (result.confidence * 100).toFixed(2) }
}

module.exports = { createRequestId, validWorkspace, validateResult }
