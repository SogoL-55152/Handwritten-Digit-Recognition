/** 参数与结果的对照：把任务的超参数和指标整理成可比较的行。 */

function percent(value) {
  return typeof value === 'number' ? Number((value * 100).toFixed(1)) : null
}

function accuracyOf(task) {
  const metrics = task?.metrics || {}
  const after = metrics.after || {}
  const last = Array.isArray(metrics.history) ? metrics.history.at(-1) : null
  const canvas = after.canvas_simulated_1000 ?? last?.canvas_simulated
  const mnist = after.raw_mnist_1000 ?? last?.raw_mnist
  return { canvas: percent(canvas), mnist: percent(mnist) }
}

function durationOf(task) {
  if (!task?.startedAt || !task?.finishedAt) return null
  const started = Date.parse(task.startedAt)
  const finished = Date.parse(task.finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null
  return Math.max(0, Math.round((finished - started) / 1000))
}

export function paramRows(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => {
    const scores = accuracyOf(task)
    const metrics = task.metrics || {}
    return {
      id: String(task.id),
      status: task.status,
      epochs: task.epochs ?? null,
      samples: task.samples ?? null,
      batchSize: task.batchSize ?? null,
      learningRate: task.learningRate ?? null,
      seed: task.seed ?? null,
      photoRatio: task.photoRatio ?? null,
      initFrom: task.initFrom || null,
      datasetVersionId: task.datasetVersionId || null,
      extraSamples: Number(metrics.extra_samples || 0),
      canvas: scores.canvas,
      mnist: scores.mnist,
      durationSeconds: durationOf(task),
      modelVersion: task.modelVersion || null
    }
  })
}

/** 只保留有准确率的行，按准确率从高到低；用于排名列表与散点。 */
export function rankedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => typeof row.canvas === 'number' || typeof row.mnist === 'number')
    .map((row) => ({ ...row, score: row.canvas ?? row.mnist }))
    .sort((a, b) => b.score - a.score)
}

/** 参数取值跨度：用于提示“哪些参数其实没变”。 */
export function spreadOf(rows) {
  const list = Array.isArray(rows) ? rows : []
  // 只统计真实出现过的取值：旧任务缺字段时不算一种取值
  const distinct = (key) => new Set(list
    .filter((row) => row[key] !== null && row[key] !== undefined)
    .map((row) => JSON.stringify(row[key])))
  return {
    samples: distinct('samples').size,
    epochs: distinct('epochs').size,
    batchSize: distinct('batchSize').size,
    learningRate: distinct('learningRate').size,
    photoRatio: distinct('photoRatio').size,
    initFrom: distinct('initFrom').size
  }
}

/** 微调与否：散点图用颜色区分。 */
export function tunedRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  return { fromScratch: list.filter((row) => !row.initFrom), tuned: list.filter((row) => row.initFrom) }
}
