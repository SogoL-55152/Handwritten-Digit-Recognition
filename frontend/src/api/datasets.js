import axios from 'axios'
import request from './request.js'

const raw = axios.create({ baseURL: '/api/v2', timeout: 20000 })
const base = (snapshot) => `/workspaces/${encodeURIComponent(snapshot.workspaceId)}`

export const listDatasets = (snapshot) =>
  request.get(`${base(snapshot)}/datasets`, { authSession: snapshot.session, silent: true })

export const createDataset = (snapshot, body) =>
  request.post(`${base(snapshot)}/datasets`, body, { authSession: snapshot.session, silent: true })

export const listVersions = (snapshot, datasetId) =>
  request.get(`${base(snapshot)}/datasets/${encodeURIComponent(datasetId)}/versions`,
    { authSession: snapshot.session, silent: true })

export const buildVersion = (snapshot, datasetId, body) =>
  request.post(`${base(snapshot)}/datasets/${encodeURIComponent(datasetId)}/versions`, body,
    { authSession: snapshot.session, silent: true })

export const versionStats = (snapshot, versionId) =>
  request.get(`${base(snapshot)}/dataset-versions/${encodeURIComponent(versionId)}/stats`,
    { authSession: snapshot.session, silent: true })

export const versionSamples = (snapshot, versionId, params = {}) => {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  })
  const suffix = query.toString() ? `?${query}` : ''
  return request.get(`${base(snapshot)}/dataset-versions/${encodeURIComponent(versionId)}/samples${suffix}`,
    { authSession: snapshot.session, silent: true })
}

/** 样本原图（二进制），用于缩略图；后端返回原图，前端按网格缩放。 */
export async function sampleImage(snapshot, versionId, sampleId) {
  const response = await raw.get(
    `${base(snapshot)}/dataset-versions/${encodeURIComponent(versionId)}/samples/${encodeURIComponent(sampleId)}/image`,
    {
      headers: { Authorization: `Bearer ${snapshot.session.token}` },
      responseType: 'blob',
      validateStatus: () => true
    })
  if (response.status === 200) return response.data
  const error = new Error(response.status === 404 ? '样本图片不存在' : '样本图片加载失败')
  error.status = response.status
  throw error
}

/** 导入外部图片：一次一个标签，后端按图片摘要去重。 */
export function importSamples(snapshot, datasetId, label, files) {
  const form = new FormData()
  form.append('label', String(label))
  for (const file of files) form.append('files', file, file.name)
  return request.post(`${base(snapshot)}/datasets/${encodeURIComponent(datasetId)}/import`, form,
    { authSession: snapshot.session, silent: true })
}

/** 跨数据集列出可用版本，用于「样本来源」勾选。 */
export const allVersions = (snapshot) =>
  request.get(`${base(snapshot)}/dataset-versions`, { authSession: snapshot.session, silent: true })

/** 后端拉起导入脚本：按 digitStruct.mat 的框裁字并导入（目录需在服务端允许的根目录下）。 */
export const importSvhn = (snapshot, datasetId, body) =>
  request.post(`${base(snapshot)}/datasets/${encodeURIComponent(datasetId)}/import-svhn`, body,
    { authSession: snapshot.session, silent: true })
