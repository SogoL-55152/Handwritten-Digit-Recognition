/** 模型对比的展示逻辑：元数据并排、训练指标并排、差异样本分组。 */

export const DOMAIN_LABELS = {
  raw_mnist: '原始 MNIST',
  canvas_simulated: '画板模拟',
  photo_simulated: '照片模拟'
}

const DOMAIN_ORDER = ['raw_mnist', 'canvas_simulated', 'photo_simulated']

/** 0–1 的分数转成 "97.6%"，null/undefined 显示为 "—"。 */
export function formatPercent(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

function registryLabel(side) {
  if (!side) return '—'
  if (!side.inRegistry) return '不在注册表'
  return side.verified ? '可推理' : '未通过校验'
}

function shortDigest(value) {
  return typeof value === 'string' && value.length >= 8 ? value.slice(0, 8) : '—'
}

/** 两个版本的元数据并排；返回 [{label, a, b}]。 */
export function metaRows(view) {
  if (!view || !view.modelA || !view.modelB) return []
  const a = view.modelA
  const b = view.modelB
  return [
    { label: '版本', a: a.version || '—', b: b.version || '—' },
    { label: '状态', a: a.status || '—', b: b.status || '—' },
    { label: '来源', a: a.origin || '—', b: b.origin || '—' },
    { label: '预处理版本', a: a.preprocessVersion || '—', b: b.preprocessVersion || '—' },
    {
      label: '登记准确率',
      a: a.accuracy === null || a.accuracy === undefined ? '—' : formatPercent(a.accuracy, 2),
      b: b.accuracy === null || b.accuracy === undefined ? '—' : formatPercent(b.accuracy, 2)
    },
    { label: '准确率来源', a: a.accuracyDataset || '—', b: b.accuracyDataset || '—' },
    { label: '注册表', a: registryLabel(a), b: registryLabel(b) },
    { label: '训练完成', a: a.trainedAt || '—', b: b.trainedAt || '—' },
    { label: '权重摘要', a: shortDigest(a.sha256), b: shortDigest(b.sha256) }
  ]
}

function metricsOf(side, domain) {
  const metrics = side && side.trainingMetrics
  if (!metrics) return { accuracy: null, f1: null }
  const accuracy = metrics.after ? metrics.after[`${domain}_1000`] : null
  const macro = metrics.macro && metrics.macro[domain] ? metrics.macro[domain].f1 : null
  return {
    accuracy: typeof accuracy === 'number' ? accuracy : null,
    f1: typeof macro === 'number' ? macro : null
  }
}

/**
 * 训练时的三域指标并排（只在两个模型都留有训练指标时才有内容）。
 * 与下方"本次在同一批样本上跑"的准确率是两回事：前者是各自训练时算的，后者才是可比的。
 */
export function domainRows(view) {
  if (!view || !view.modelA || !view.modelB) return []
  const hasA = Boolean(view.modelA.trainingMetrics)
  const hasB = Boolean(view.modelB.trainingMetrics)
  if (!hasA && !hasB) return []
  return DOMAIN_ORDER.map((domain) => {
    const left = metricsOf(view.modelA, domain)
    const right = metricsOf(view.modelB, domain)
    return {
      domain,
      label: DOMAIN_LABELS[domain],
      accuracyA: formatPercent(left.accuracy),
      accuracyB: formatPercent(right.accuracy),
      f1A: formatPercent(left.f1),
      f1B: formatPercent(right.f1),
      delta: left.accuracy !== null && right.accuracy !== null
        ? Number(((right.accuracy - left.accuracy) * 100).toFixed(1))
        : null
    }
  })
}

function whoIsRight(row) {
  if (typeof row.label !== 'number' || row.label < 0) return 'unknown'
  const aRight = row.digitA === row.label
  const bRight = row.digitB === row.label
  if (aRight && bRight) return 'both'
  if (aRight) return 'A'
  if (bRight) return 'B'
  return 'both-wrong'
}

/** 只看两个模型判得不一致的样本，附"谁对"。 */
export function disagreementRows(view, limit = 20) {
  const rows = view && Array.isArray(view.rows) ? view.rows : []
  return rows
    .filter((row) => !row.agree)
    .slice(0, limit)
    .map((row) => ({ ...row, who: whoIsRight(row) }))
}

/** 一句话总结本次对比。 */
export function summaryLine(view) {
  const summary = view && view.summary
  if (!summary) return ''
  const parts = [`共 ${summary.samples} 张样本`]
  if (typeof summary.agreement === 'number' && typeof summary.agreementRate === 'number') {
    parts.push(`一致 ${summary.agreement} 张（${formatPercent(summary.agreementRate)}）`)
  }
  if (typeof summary.accuracyA === 'number' && typeof summary.accuracyB === 'number') {
    parts.push(`A 正确率 ${formatPercent(summary.accuracyA)}，B 正确率 ${formatPercent(summary.accuracyB)}`)
    parts.push(`A 独占对 ${summary.onlyA} 张，B 独占对 ${summary.onlyB} 张，都错 ${summary.bothWrong} 张`)
  } else {
    parts.push('样本缺少标签，只能看一致率')
  }
  return parts.join('；')
}

/** A/B 谁更好：用于给个明确结论，避免用户自己算。 */
export function verdict(view) {
  const summary = view && view.summary
  if (!summary || typeof summary.accuracyA !== 'number' || typeof summary.accuracyB !== 'number') return null
  const delta = Number(((summary.accuracyB - summary.accuracyA) * 100).toFixed(1))
  if (Math.abs(delta) < 0.05) return { winner: 'tie', delta: 0, text: '两个版本在这批样本上打平' }
  if (delta > 0) return { winner: 'B', delta, text: `B 高 ${delta.toFixed(1)} 个百分点` }
  return { winner: 'A', delta, text: `A 高 ${Math.abs(delta).toFixed(1)} 个百分点` }
}
