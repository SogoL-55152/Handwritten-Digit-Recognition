/** step 级指标：抽样点整理与图表数据，纯函数便于单测。 */

export function stepSeriesOf(metrics, limit = 500) {
  const raw = Array.isArray(metrics?.stepSeries) ? metrics.stepSeries : []
  const points = []
  for (const item of raw) {
    const step = Number(item?.step)
    if (!Number.isFinite(step)) continue
    points.push({
      step,
      epoch: Number(item?.epoch) || null,
      loss: typeof item?.loss === 'number' ? item.loss : null,
      lr: typeof item?.lr === 'number' ? item.lr : null
    })
    if (points.length >= limit) break
  }
  return points.sort((a, b) => a.step - b.step)
}

export function stepsSummary(metrics) {
  const points = stepSeriesOf(metrics)
  if (!points.length) return null
  const losses = points.map((point) => point.loss).filter((value) => value !== null)
  return {
    count: points.length,
    firstStep: points[0].step,
    lastStep: points[points.length - 1].step,
    minLoss: losses.length ? Math.min(...losses) : null,
    maxLoss: losses.length ? Math.max(...losses) : null,
    epochs: new Set(points.map((point) => point.epoch).filter(Boolean)).size
  }
}

/** 日志行合并：新行更多时替换，旧行是前缀时只追加。 */
export function mergeLogs(previous, incoming) {
  const before = Array.isArray(previous) ? previous : []
  const next = Array.isArray(incoming) ? incoming : []
  if (!before.length) return next
  if (!next.length) return before
  if (next.length <= before.length) return next
  return next
}
