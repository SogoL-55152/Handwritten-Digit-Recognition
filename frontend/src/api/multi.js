import request from './request.js'

/** 多位数识别：会写入识别历史，带幂等键；重复提交返回同一条结果。 */
export function submitMulti(snapshot, form, requestId, options = {}) {
  return request.post(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/recognitions/multi`, form, {
    authSession: snapshot.session,
    inputCurrent: options.inputCurrent,
    silent: true,
    headers: { 'Idempotency-Key': requestId }
  })
}
