import request from './request.js'

export const login = (data) => request.post('/auth/login', data, { skipAuth: true, silent: true })
export const register = (data) => request.post('/auth/register', data, { skipAuth: true, silent: true })
// The session state machine owns password success/401 handling, including late responses.
export const changePassword = (data, authSession) => request.post('/auth/password', data, { authSession, sessionValidation: true, silent: true })
export const getMe = (authSession) => request.get('/auth/me', { authSession, sessionValidation: true, silent: true })
// Explicit captured token: logout runs after the live client session is already cleared.
export const logout = (authSession) => request.post('/auth/logout', null, { authSession, sessionValidation: true, silent: true })
