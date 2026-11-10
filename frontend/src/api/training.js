import request from './request.js'

const base = '/admin/training/tasks'

export const listDatasets = (authSession) => request.get(`${base}/datasets`, { authSession, silent: true })
export const listTasks = (authSession, limit = 20) => request.get(base, { authSession, params: { limit }, silent: true })
export const getTask = (id, authSession) => request.get(`${base}/${encodeURIComponent(id)}`, { authSession, silent: true })
export const createTask = (datasetId, payload, authSession) =>
  request.post(`${base}?datasetId=${encodeURIComponent(datasetId)}`, payload, { authSession, silent: true })

export const eventsTicket = (authSession) =>
  request.post('/admin/training/tasks/events/ticket', {}, { authSession, silent: true })
