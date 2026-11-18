/** 每类准确率与混淆矩阵的展示逻辑。 */

export const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

export function detailedView(metrics) {
  const detail = metrics?.detailed_canvas
  if (!detail || !Array.isArray(detail.perClass) || !Array.isArray(detail.confusion)) return null
  if (!detail.confusion.length && !detail.perClass.length) return null
  const matrix = DIGITS.map((truth) => {
    const row = Array.isArray(detail.confusion[truth]) ? detail.confusion[truth] : []
    return DIGITS.map((guess) => Number(row[guess] || 0))
  })
  const max = Math.max(1, ...matrix.flat())
  const perClass = DIGITS.map((label) => {
    const item = detail.perClass.find((entry) => Number(entry.label) === label) || {}
    const accuracy = typeof item.accuracy === 'number' ? item.accuracy : null
    return {
      label,
      correct: item.correct ?? 0,
      total: item.total ?? 0,
      accuracy,
      percent: accuracy === null ? null : Number((accuracy * 100).toFixed(1))
    }
  })
  const worst = perClass
    .filter((item) => item.accuracy !== null && item.total > 0)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 3)
  return { matrix, max, perClass, worst }
}

/** 混淆矩阵单个格子的强度（0–1），用于着色。 */
export function cellIntensity(count, max) {
  if (!count || !max) return 0
  return Math.min(1, Math.log1p(count) / Math.log1p(max))
}
