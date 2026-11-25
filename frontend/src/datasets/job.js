/** 异步导入任务的展示逻辑（纯函数，便于单测）。 */

export const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED']

export function isTerminalJob(status) {
  return TERMINAL_STATUSES.includes(status)
}

/** 扫描阶段 progressTotal=0，此时没有百分比可显示。 */
export function jobPercent(job) {
  if (!job || !job.progressTotal || job.progressTotal <= 0) return null
  const done = Math.max(0, Math.min(job.progressTotal, Number(job.progressDone) || 0))
  return Math.round((done / job.progressTotal) * 1000) / 10
}

export function jobStatusText(job) {
  if (!job) return ''
  switch (job.status) {
    case 'QUEUED':
      return '已排队，等待开始…'
    case 'RUNNING':
      if (!job.progressTotal) return '正在扫描目录…'
      return `正在导入 ${job.progressDone || 0} / ${job.progressTotal} 张`
    case 'SUCCEEDED':
      return `导入完成：成功 ${job.imported || 0} · 重复 ${job.duplicates || 0} · 失败 ${job.failed || 0}`
    case 'CANCELED':
      return `已取消（已导入 ${job.imported || 0} 张，可到批次列表回滚）`
    case 'FAILED':
      return `导入失败：${job.errorMessage || '未知原因'}`
    default:
      return job.status || ''
  }
}

/** 还在跑的任务才显示取消按钮。 */
export function canCancelJob(job) {
  return Boolean(job) && (job.status === 'QUEUED' || job.status === 'RUNNING') && !job.cancelRequested
}
