import request from './request.js'

/** 多位数预览：不写数据库、不做幂等、不计入统计，仅用于验证体验与准确率。 */
export function previewMulti(snapshot, form, options = {}) {
  return request.post(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/recognitions/multi-preview`, form, {
    authSession: snapshot.session,
    inputCurrent: options.inputCurrent,
    silent: true
  })
}
