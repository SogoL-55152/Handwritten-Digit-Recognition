/** 每类准确率/精确率/召回率、混淆矩阵与错误样本的展示逻辑。 */

export const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** 三个评估域的中文名；键与后端 metrics.detailed 一致。 */
export const DOMAIN_LABELS = {
  raw_mnist: '原始 MNIST',
  canvas_simulated: '画板模拟',
  photo_simulated: '照片模拟'
}

const DEFAULT_DOMAIN = 'canvas_simulated'

function isUsable(detail) {
  return Boolean(detail) && Array.isArray(detail.perClass) && Array.isArray(detail.confusion)
    && (detail.confusion.length > 0 || detail.perClass.length > 0)
}

function pickDetail(metrics, domain) {
  if (!metrics) return null
  const detailed = metrics.detailed
  if (domain) {
    if (detailed && isUsable(detailed[domain])) return detailed[domain]
    // 旧记录里画板域在 detailed_canvas
    if (domain === DEFAULT_DOMAIN && isUsable(metrics.detailed_canvas)) return metrics.detailed_canvas
    return null
  }
  // 未指定域：优先画板域，其次 detailed 里的第一个可用域
  if (isUsable(metrics.detailed_canvas)) return metrics.detailed_canvas
  if (detailed && typeof detailed === 'object') {
    if (isUsable(detailed[DEFAULT_DOMAIN])) return detailed[DEFAULT_DOMAIN]
    const first = Object.keys(detailed).find((key) => isUsable(detailed[key]))
    if (first) return detailed[first]
  }
  return null
}

/** 该任务有哪些可切换的评估域（旧记录只返回一个）。 */
export function domainOptions(metrics) {
  const detailed = metrics && metrics.detailed
  const options = []
  if (detailed && typeof detailed === 'object') {
    Object.keys(detailed).forEach((key) => {
      if (isUsable(detailed[key])) options.push({ key, label: DOMAIN_LABELS[key] || key })
    })
  }
  if (!options.length && isUsable(metrics && metrics.detailed_canvas)) {
    options.push({ key: DEFAULT_DOMAIN, label: DOMAIN_LABELS[DEFAULT_DOMAIN] })
  }
  return options
}

export function detailedView(metrics, domain) {
  const detail = pickDetail(metrics, domain)
  if (!detail) return null

  const matrix = DIGITS.map((truth) => {
    const row = Array.isArray(detail.confusion[truth]) ? detail.confusion[truth] : []
    return DIGITS.map((guess) => Number(row[guess] || 0))
  })
  const max = Math.max(1, ...matrix.flat())

  const perClass = DIGITS.map((label) => {
    const item = detail.perClass.find((entry) => Number(entry.label) === label) || {}
    // 新记录用 support（该类的真实样本数），旧记录用 total
    const total = typeof item.support === 'number' ? item.support : (item.total ?? 0)
    const accuracy = typeof item.accuracy === 'number' ? item.accuracy : null
    const score = (value) => (typeof value === 'number' ? value : null)
    return {
      label,
      correct: item.correct ?? 0,
      total,
      predicted: typeof item.predicted === 'number' ? item.predicted : null,
      accuracy,
      percent: accuracy === null ? null : Number((accuracy * 100).toFixed(1)),
      precision: score(item.precision),
      recall: score(item.recall),
      f1: score(item.f1)
    }
  })

  const worst = perClass
    .filter((item) => item.accuracy !== null && item.total > 0)
    .sort((a, b) => a.accuracy - b.accuracy || a.label - b.label)
    .slice(0, 3)

  return {
    domain: detail.domain || domain || DEFAULT_DOMAIN,
    matrix,
    max,
    perClass,
    worst,
    macro: detail.macro || null,
    weighted: detail.weighted || null,
    errors: Array.isArray(detail.errors) ? detail.errors : [],
    errorCount: typeof detail.errorCount === 'number' ? detail.errorCount : (detail.errors || []).length,
    errorSheet: detail.errorSheet || null
  }
}

/** 混淆矩阵单个格子的强度（0–1），用于着色。 */
export function cellIntensity(count, max) {
  if (!count || !max) return 0
  return Math.min(1, Math.log1p(count) / Math.log1p(max))
}

/** 0–1 的分数转成 "97.6%"，null 显示为 "—"。 */
export function formatScore(value, digits = 1) {
  if (typeof value !== 'number') return '—'
  return `${(value * 100).toFixed(digits)}%`
}
