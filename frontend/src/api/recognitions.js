import axios from 'axios'
import request from './request.js'

const raw = axios.create({ baseURL: '/api/v2', timeout: 20000 })

/** 单条识别详情（单字与多位数通用），只返回本人的记录。 */
export function recognitionDetail(snapshot, id) {
  return request.get(`/workspaces/${encodeURIComponent(snapshot.workspaceId)}/recognitions/${encodeURIComponent(id)}/detail`,
    { authSession: snapshot.session, silent: true })
}

/** 识别原图；旧记录没有保存图片时后端返回 404。 */
export async function recognitionImage(snapshot, id) {
  const response = await raw.get(
    `/workspaces/${encodeURIComponent(snapshot.workspaceId)}/recognitions/${encodeURIComponent(id)}/image`,
    {
      headers: { Authorization: `Bearer ${snapshot.session.token}` },
      responseType: 'blob',
      validateStatus: () => true
    })
  if (response.status === 200) return response.data
  const error = new Error(response.status === 404 ? '该记录没有保存图片' : '图片加载失败')
  error.status = response.status
  throw error
}
