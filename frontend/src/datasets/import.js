/** 目录导入：把「按类别分文件夹」的数据集拆成按标签分组的批次。 */

const IMAGE_TYPES = /\.(png|jpe?g|webp|bmp)$/i

/** 文件相对路径的第一段作为标签，例如 "3/001.png" → 3；不是 0–9 返回 null。 */
export function labelOfPath(path) {
  if (typeof path !== 'string' || !path) return null
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const first = segments[0].trim()
  if (!/^[0-9]$/.test(first)) return null
  return Number(first)
}

export function isImage(file) {
  const name = file?.name || ''
  const type = file?.type || ''
  return IMAGE_TYPES.test(name) || type.startsWith('image/')
}

/**
 * 按标签分组。返回 {groups: {0:[file],...}, ignored: n, noLabel: n, emptyLabels: [...]}
 * - noLabel：不在 0–9 目录下的图片；
 * - ignored：非图片文件。
 */
export function groupByFolder(files) {
  const groups = {}
  for (let digit = 0; digit < 10; digit += 1) groups[digit] = []
  let ignored = 0
  let noLabel = 0
  for (const file of Array.from(files || [])) {
    const path = file?.webkitRelativePath || ''
    if (!isImage(file)) {
      ignored += 1
      continue
    }
    const label = labelOfPath(path)
    if (label === null) {
      noLabel += 1
      continue
    }
    groups[label].push(file)
  }
  const emptyLabels = Object.entries(groups).filter(([, list]) => list.length === 0).map(([digit]) => Number(digit))
  return { groups, ignored, noLabel, emptyLabels }
}

export function batchOf(list, size = 20) {
  const items = Array.from(list || [])
  const step = Math.max(1, Number(size) || 20)
  const batches = []
  for (let index = 0; index < items.length; index += step) {
    batches.push(items.slice(index, index + step))
  }
  return batches
}

/** 汇总多次导入结果，并给出"下一步"提示。 */
export function importSummary(results) {
  const total = { imported: 0, duplicates: 0, failed: 0, total: 0 }
  for (const item of Array.isArray(results) ? results : []) {
    total.imported += Number(item?.imported || 0)
    total.duplicates += Number(item?.duplicates || 0)
    total.failed += Number(item?.failed || 0)
    total.total += Number(item?.total || 0)
  }
  const hint = total.imported > 0
    ? '导入完成，去「生成版本」让训练用上这批数据'
    : total.duplicates > 0
      ? '全部是重复样本（图片内容已在采集池里）'
      : '没有导入任何样本'
  return { ...total, hint }
}

/** 进度文本：当前第几个标签、第几批。 */
export function progressText({ label, labelIndex, labelCount, batchIndex, batchCount }) {
  if (!labelCount) return '没有可导入的图片'
  return `标签 ${label}（${labelIndex}/${labelCount}）· 第 ${batchIndex}/${batchCount} 批`
}
