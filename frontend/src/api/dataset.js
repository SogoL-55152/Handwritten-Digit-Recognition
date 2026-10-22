import request from './request'

export const pageDatasets = (params) => request.get('/datasets', { params })
export const createDataset = (data) => request.post('/datasets', data)
