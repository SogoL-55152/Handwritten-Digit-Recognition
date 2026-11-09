import request from './request.js'

const base = '/admin/models'
const path = (id) => `${base}/${encodeURIComponent(id)}`

export const listModels = (authSession) => request.get(base, { authSession, silent: true })
export const registerModel = (payload, authSession) => request.post(`${base}/register`, payload, { authSession, silent: true })
export const activateModel = (id, authSession) => request.post(path(id) + '/activate', {}, { authSession, silent: true })
export const disableModel = (id, authSession) => request.post(path(id) + '/disable', {}, { authSession, silent: true })
export const deleteModel = (id, authSession) => request.delete(path(id), { authSession, silent: true })
export const reloadRegistry = (authSession) => request.post(`${base}/registry/reload`, {}, { authSession, silent: true })
