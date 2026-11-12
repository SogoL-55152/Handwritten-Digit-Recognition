/** 统计页的纯格式化逻辑：把接口数据变成卡片、图表与表格，便于单测。 */
export function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '0'
}

export function formatMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

export function ratio(part, total) {
  if (!total || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}

export function formatRatio(part, total) {
  return `${ratio(part, total).toFixed(1)}%`
}

export function summaryCards(stats) {
  const total = stats?.total || 0
  return [
    { key: 'total', label: '识别请求', value: formatCount(total), hint: `近 ${stats?.days ?? 0} 天` },
    { key: 'accepted', label: '返回结果', value: formatCount(stats?.accepted || 0), hint: formatRatio(stats?.accepted || 0, total) },
    { key: 'declined', label: '拒识', value: formatCount(stats?.declined || 0), hint: formatRatio(stats?.declined || 0, total) },
    { key: 'failed', label: '服务失败', value: formatCount(stats?.failed || 0), hint: formatRatio(stats?.failed || 0, total) },
    { key: 'latency', label: '平均耗时', value: formatMs(stats?.averageProcessingMs || 0), hint: '模型调用 + 预处理' }
  ]
}

export function dailySeries(stats) {
  const daily = Array.isArray(stats?.daily) ? stats.daily : []
  return {
    dates: daily.map((item) => (item.date || '').slice(5)),
    total: daily.map((item) => item.total || 0),
    accepted: daily.map((item) => item.accepted || 0),
    declined: daily.map((item) => item.declined || 0),
    failed: daily.map((item) => item.failed || 0)
  }
}

export function modelRows(stats) {
  const models = Array.isArray(stats?.models) ? stats.models : []
  const total = models.reduce((sum, item) => sum + (item.total || 0), 0)
  return models.map((item) => ({
    version: item.modelVersion,
    total: item.total || 0,
    accepted: item.accepted || 0,
    share: formatRatio(item.total || 0, total),
    acceptedRate: formatRatio(item.accepted || 0, item.total || 0)
  }))
}

export function trainingCard(stats) {
  if (!stats || stats.trainingTotal === undefined) return null
  return {
    label: '训练任务',
    value: formatCount(stats.trainingTotal),
    hint: `成功 ${stats.trainingSucceeded || 0} · 失败 ${stats.trainingFailed || 0}`
  }
}

const FAILURE_LABEL = {
  UNRECOGNIZED_INPUT: '拒识',
  INVALID_CANVAS: '图片无效',
  CONCURRENCY_LIMIT: '并发受限',
  MODEL_UNAVAILABLE: '模型不可用'
}

/** 最近识别记录：把状态/数字/来源翻成可读文本。 */
export function recentRows(list) {
  return (Array.isArray(list) ? list : []).map((item) => {
    const text = typeof item.resultText === 'string' && item.resultText ? item.resultText : null
    const hasDigit = item.digit !== null && item.digit !== undefined
    return {
      id: item.id,
      time: String(item.createdAt || '').replace('T', ' ').slice(0, 19),
      outcome: text || (hasDigit ? String(item.digit) : (FAILURE_LABEL[item.failureCode] || '失败')),
      multi: Boolean(text),
      success: hasDigit || Boolean(text),
      confidence: typeof item.confidence === 'number' ? `${(item.confidence * 100).toFixed(1)}%` : '—',
      latency: typeof item.processingMs === 'number' ? `${item.processingMs}ms` : '—',
      model: item.modelVersion || '—',
      source: item.source === 'WEB' ? '网页' : item.source === 'MINIPROGRAM' ? '小程序' : (item.source || '—'),
      workspace: item.workspaceId || ''
    }
  })
}

/** 单条识别详情：翻成可读的键值行，供弹窗展示。 */
export function detailRows(detail) {
  if (!detail) return []
  const statusLabel = detail.status === 'SUCCEEDED' ? '已完成' : detail.status === 'FAILED' ? '失败' : '处理中'
  const result = detail.resultText || (detail.digit !== null && detail.digit !== undefined ? String(detail.digit) : '—')
  return [
    { key: '结果', value: result },
    { key: '状态', value: statusLabel },
    { key: '是否可用', value: detail.accepted ? '可接受' : '不确定' },
    { key: '置信度', value: typeof detail.confidence === 'number' ? `${(detail.confidence * 100).toFixed(1)}%` : '—' },
    { key: '耗时', value: typeof detail.processingMs === 'number' ? `${detail.processingMs}ms` : '—' },
    { key: '失败分类', value: detail.failureCode || '—' },
    { key: '模型', value: detail.modelVersion || '—' },
    { key: '预处理', value: detail.preprocessVersion || '—' },
    { key: '来源', value: detail.source === 'WEB' ? '网页' : detail.source === 'MINIPROGRAM' ? '小程序' : (detail.source || '—') },
    { key: '时间', value: String(detail.createdAt || '').replace('T', ' ').slice(0, 19) },
    { key: '请求 ID', value: detail.requestId || '—' }
  ]
}
