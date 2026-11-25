/** 数据集页的纯逻辑：版本命名、构建参数、统计行与提示，便于单测。 */

export const SPLITS = [
  { key: 'TRAIN', label: '训练集' },
  { key: 'VAL', label: '验证集' },
  { key: 'TEST', label: '测试集' }
]

/** 下一个版本号：v1、v2……（版本名只允许字母数字与 ._-） */
export function nextVersion(versions = []) {
  const used = new Set((versions || []).map((item) => String(item.version || '')))
  let index = 1
  while (used.has(`v${index}`)) index += 1
  return `v${index}`
}

/** 构建版本的请求体：只提交有效字段，比例夹在 0–50 之间。 */
export function buildPayload(form = {}) {
  const clamp = (value, fallback) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(50, Math.max(0, Math.round(number)))
  }
  const payload = {
    version: String(form.version || '').trim(),
    splitRule: form.splitRule === 'RANDOM' ? 'RANDOM' : 'WRITER',
    valPercent: clamp(form.valPercent, 15),
    testPercent: clamp(form.testPercent, 15)
  }
  if (form.label !== undefined && form.label !== null && form.label !== '') payload.label = Number(form.label)
  if (form.kind) payload.kind = form.kind
  // 沿用某个版本的划分：0/空 表示重新划分
  const source = Number(form.preserveSplitFrom)
  if (Number.isFinite(source) && source > 0) payload.preserveSplitFrom = Math.round(source)
  return payload
}

/** 可选的"沿用划分来源"版本（排除当前要新建的那个名字）。 */
export function splitSourceOptions(versions = [], currentVersion = '') {
  return (Array.isArray(versions) ? versions : [])
    .filter((item) => item && item.id && item.status === 'READY')
    .filter((item) => String(item.version || '') !== String(currentVersion || ''))
    .map((item) => ({
      id: Number(item.id),
      label: `#${item.id} · ${item.version || ''}（${item.sample_count ?? 0} 样本${item.split_source_id ? '，沿用 #' + item.split_source_id : ''}）`
    }))
}

/** 标签分布：按标签排序，带占比（用于条形图）。 */
export function labelRows(stats) {
  const rows = Array.isArray(stats?.byLabel) ? stats.byLabel : []
  const total = rows.reduce((sum, row) => sum + (row.count || 0), 0)
  return rows.map((row) => ({
    label: String(row.key),
    count: row.count || 0,
    percent: total ? Math.round(((row.count || 0) / total) * 1000) / 10 : 0
  }))
}

/** 划分分布：固定顺序 TRAIN/VAL/TEST，缺失的补 0。 */
export function splitRows(stats) {
  const found = new Map((Array.isArray(stats?.bySplit) ? stats.bySplit : []).map((row) => [row.key, row.count || 0]))
  return SPLITS.map(({ key, label }) => ({ key, label, count: found.get(key) || 0 }))
}

/** 划分提示：书写者跨划分泄漏、某侧为空、以及按人划分的前提。 */
export function splitHints(stats) {
  const hints = []
  const rows = splitRows(stats)
  const empty = rows.filter((row) => row.count === 0).map((row) => row.label)
  if (empty.length) hints.push(`${empty.join('、')}为空，训练或评测会缺数据`)
  const leak = Number(stats?.writerLeak || 0)
  if (leak > 0) hints.push(`有 ${leak} 位书写者同时出现在多个划分里，评测结果会偏乐观`)
  return hints
}
