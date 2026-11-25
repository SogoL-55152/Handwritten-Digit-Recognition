/**
 * 实时推送与轮询的分工：SSE 连着的时候不轮询，断开/不可用才用轮询兜底。
 * 纯函数 + 常量，便于 node --test 直接验证（视图里只做接线）。
 */

/** SSE 客户端可能报告的状态。 */
export const SSE_STATUS = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  UNAVAILABLE: 'unavailable',
  CLOSED: 'closed'
}

const LABELS = {
  live: '实时推送已连接',
  connecting: '实时推送连接中',
  reconnecting: '推送断开，正在重连',
  unavailable: '实时推送不可用，使用轮询兜底',
  closed: '实时推送已关闭'
}

export function liveLabel(status) {
  return LABELS[status] || status || ''
}

/**
 * 是否需要轮询兜底。
 * 只有 'live' 才停轮询：连接中/重连中/不可用都继续轮询，
 * 否则一旦 SSE 建连失败，界面就彻底不刷新了。
 */
export function shouldPoll(status) {
  return status !== SSE_STATUS.LIVE
}

/** 轮询间隔：SSE 连上返回 0（表示不用起定时器）。 */
export function pollIntervalMs(status, fallbackMs = 4000) {
  return shouldPoll(status) ? fallbackMs : 0
}

/** 是否还在跑（QUEUED/RUNNING）；用来决定要不要继续刷新日志。 */
export function isActiveStatus(status) {
  return status === 'QUEUED' || status === 'RUNNING'
}
