/** 可视化页：任务列表与展示用的数据整理。 */
export function taskOptions(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  return list.map((task) => {
    const metrics = task.metrics || {}
    const after = metrics.after || {}
    const last = Array.isArray(metrics.history) && metrics.history.length
      ? metrics.history[metrics.history.length - 1]
      : null
    const pick = (key) => after[key] ?? last?.[key.replace('1000', '')] ?? null
    return {
      id: String(task.id),
      label: `任务 #${task.id}`,
      status: task.status,
      modelVersion: task.modelVersion || '',
      hasMetrics: Boolean(last || Object.keys(after).length),
      epochs: Array.isArray(metrics.history) ? metrics.history.length : 0,
      mnist: pick('raw_mnist_1000'),
      canvas: pick('canvas_simulated_1000'),
      photo: pick('photo_simulated_1000'),
      extraSamples: Number(metrics.extra_samples || 0)
    }
  })
}

export function pickDefaultTask(options) {
  const list = Array.isArray(options) ? options : []
  return (list.find((item) => item.status === 'SUCCEEDED' && item.hasMetrics) || list[0] || null)?.id || null
}
