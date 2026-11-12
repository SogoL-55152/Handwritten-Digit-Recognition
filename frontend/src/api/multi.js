import request from './request.js'
import { buildMultiQuery } from '@/recognition/multi.js'

/** 多位数识别：会写入识别历史，带幂等键；图片导入时按需做照片增强。 */
export function submitMulti(snapshot, form, requestId, options = {}) {
  const query = buildMultiQuery(options.maxDigits ?? 3, options.enhance)
  return request.post(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/recognitions/multi${query}`, form, {
    authSession: snapshot.session,
    inputCurrent: options.inputCurrent,
    silent: true,
    headers: { 'Idempotency-Key': requestId }
  })
}
