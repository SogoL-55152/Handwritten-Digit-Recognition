import request from './request.js'

export const spaceStatistics = (workspaceId, authSession, days = 7) =>
  request.get(`/workspaces/${encodeURIComponent(workspaceId)}/statistics`, { authSession, params: { days }, silent: true })

export const platformStatistics = (authSession, days = 30) =>
  request.get('/platform/statistics', { authSession, params: { days }, silent: true })

export const recentSpace = (workspaceId, authSession, limit = 5) =>
  request.get(`/workspaces/${encodeURIComponent(workspaceId)}/statistics/recent`,
    { authSession, params: { limit }, silent: true })

export const recentPlatform = (authSession, limit = 5) =>
  request.get('/platform/statistics/recent', { authSession, params: { limit }, silent: true })
