import request from './request.js'

export const workspacePath = (id) => `/workspaces/${encodeURIComponent(id)}`
export const listWorkspaces = (authSession) => request.get('/workspaces', { authSession, silent: true })
export const getWorkspace = (id, authSession) => request.get(workspacePath(id), { authSession, silent: true })
export const createWorkspace = (name, authSession) => request.post('/workspaces', { name }, { authSession, silent: true })
export const getResource = (snapshot, resource) => request.get(`${workspacePath(snapshot.workspaceId)}/${resource}`, { authSession: snapshot.session, silent: true })
export const getPlatform = (authSession, resource) => request.get(`/platform/${resource}`, { authSession, silent: true })
export function recognize(snapshot, image, requestId) {
  const form = new FormData()
  form.append('image', image, 'drawing.png')
  form.append('source', 'WEB')
  // Browser supplies the multipart boundary. No automatic POST retries.
  return request.post(`${workspacePath(snapshot.workspaceId)}/recognitions`, form, {
    authSession: snapshot.session, silent: true, headers: { 'Idempotency-Key': requestId }
  })
}

export function errorMessage(error) {
  const status = error?.status || error?.response?.status
  if (status === 404) return '空间或资源不可访问。成员资格可能已变化，请重新选择空间。'
  if (status === 403) return '没有此操作权限。当前会话仍然有效。'
  if (status === 413) return '图片过大，请清空画板后重试（图片上限 5 MiB）。'
  if (status === 429) return `请求受限（${error.data?.category || '限流'}）。${error.data?.retryAfterSeconds || error.retryAfter ? `请在 ${error.data?.retryAfterSeconds || error.retryAfter} 秒后重试。` : '请稍后重试。'}`
  if (status === 409) return `请求未完成（${error.data?.category || '冲突'}）。不会自动重发；再次识别将创建新请求。`
  if (status === 502 || status === 503) return '识别或基础服务暂不可用，请稍后手动重试。'
  return error?.message || '请求失败，请稍后重试。'
}
