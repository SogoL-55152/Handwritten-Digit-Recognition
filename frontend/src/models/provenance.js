/** 模型来源的可读标签与详情，供模型管理页展示。 */
export const ORIGINS = {
  BUILTIN: { label: '内置基线', tone: 'builtin', hint: '随项目提供的初始模型' },
  TRAINED: { label: '训练产出', tone: 'trained', hint: '由训练任务训练得到' },
  FINE_TUNED: { label: '微调', tone: 'fine-tuned', hint: '基于已有模型继续训练' },
  IMPORTED: { label: '手工导入', tone: 'imported', hint: '从模型服务注册表手工登记' }
}

export function originOf(row) {
  return ORIGINS[row?.origin] || ORIGINS.IMPORTED
}

function formatTime(value) {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 详情行：训练/微调给任务号与时间，其余给一句说明。 */
export function provenanceDetail(row) {
  const origin = originOf(row)
  if (!row || (row.origin !== 'TRAINED' && row.origin !== 'FINE_TUNED')) return origin.hint
  const parts = []
  if (row.taskId) parts.push(`任务 #${row.taskId}`)
  if (row.initFrom) parts.push(`起点 ${row.initFrom}`)
  const time = formatTime(row.trainedAt)
  if (time) parts.push(time)
  return parts.length ? parts.join(' · ') : origin.hint
}
