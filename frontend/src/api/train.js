import request from './request'

export const createTrainTask = (data) => request.post('/train-tasks', data)
export const pageTrainTasks = (params) => request.get('/train-tasks', { params })
export const getTrainTask = (id) => request.get(`/train-tasks/${id}`)
export const getTrainMetrics = (id) => request.get(`/train-tasks/${id}/metrics`)
