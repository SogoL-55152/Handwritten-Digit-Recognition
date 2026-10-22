import request from './request'

export const pageModels = (params) => request.get('/models', { params })
export const getActiveModel = () => request.get('/models/active')
export const activateModel = (id) => request.post(`/models/${id}/activate`)
export const deleteModel = (id) => request.delete(`/models/${id}`)
