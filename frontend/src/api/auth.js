import request from './request.js'

export const login = (data) => request.post('/auth/login', data, { skipAuth: true, silent: true })
export const register = (data) => request.post('/auth/register', data, { skipAuth: true })
export const getMe = (authSession) => request.get('/auth/me', {
  authSession,
  sessionValidation: true,
  silent: true
})
