import request from './request'

export const pageUsers = (params) => request.get('/users', { params })
export const updateUserStatus = (id, status) => request.put(`/users/${id}/status`, { status })
