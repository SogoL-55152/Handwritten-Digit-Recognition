import request from './request'

export const getOverview = () => request.get('/stats/overview')
export const getCallTrend = () => request.get('/stats/call-trend')
export const getModelUsage = () => request.get('/stats/model-usage')
