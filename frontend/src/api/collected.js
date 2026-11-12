import request from './request.js'

/** 用户自报标签并同意后的样本采集；未同意时前端也会拦住。 */
export function submitSample(snapshot, form, options = {}) {
  return request.post(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/collected-samples`, form, {
    authSession: snapshot.session,
    inputCurrent: options.inputCurrent,
    silent: true
  })
}

export const sampleSummary = (snapshot) =>
  request.get(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/collected-samples/summary`,
    { authSession: snapshot.session, silent: true })
