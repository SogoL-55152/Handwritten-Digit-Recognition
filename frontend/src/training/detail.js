/** 训练任务详情：把参数、逐轮指标与样本构成整理成可渲染的结构。 */
export function taskDetail(task) {
  const metrics = task?.metrics || {}
  const history = Array.isArray(metrics.history) ? metrics.history : []
  const percent = (value) => (typeof value === 'number' ? Number((value * 100).toFixed(2)) : null)

  const cards = [
    { key: 'epochs', label: '轮数', value: task?.epochs ?? '—' },
    { key: 'samples', label: '样本数', value: task?.samples ?? '—' },
    { key: 'batch', label: 'batch', value: task?.batchSize ?? '—' },
    { key: 'lr', label: '学习率', value: task?.learningRate ?? '—' },
    { key: 'seed', label: '随机种子', value: task?.seed ?? '—' },
    { key: 'photo', label: '照片增广', value: task?.photoRatio ?? '—' },
    { key: 'initFrom', label: '起点', value: task?.initFrom || '从零训练' },
    { key: 'dataset', label: '数据版本', value: task?.datasetVersionId ? `#${task.datasetVersionId}` : '未使用' }
  ]

  const rows = history.map((item) => ({
    epoch: item.epoch,
    loss: typeof item.loss === 'number' ? item.loss : null,
    trainAcc: percent(item.trainAcc),
    mnist: percent(item.raw_mnist),
    canvas: percent(item.canvas_simulated),
    photo: percent(item.photo_simulated),
    lr: typeof item.lr === 'number' ? item.lr : null,
    tps: typeof item.tps === 'number' ? item.tps : null,
    gradNorm: typeof item.gradNorm === 'number' ? item.gradNorm : null,
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : null
  }))
  const durations = rows.map((row) => row.durationMs || 0)
  const maxDuration = Math.max(1, ...durations)

  return {
    cards,
    rows,
    durations,
    maxDuration,
    bestEpoch: typeof metrics.bestEpoch === 'number' ? metrics.bestEpoch : null,
    composition: {
      extraSamples: Number(metrics.extra_samples || 0),
      rendered: typeof metrics.samples_rendered === 'number' ? metrics.samples_rendered : null,
      unusable: typeof metrics.samples_unusable === 'number' ? metrics.samples_unusable : null
    },
    hasHistory: rows.length > 0
  }
}
