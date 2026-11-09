/**
 * 训练任务看板：创建、列表、轮询。纯逻辑 + 注入式定时器，便于 node --test 验证。
 * 只要还有 QUEUED / RUNNING 的任务就继续轮询；全部进入终态后自动停止，避免无意义请求。
 */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED'])

export function isActiveTask(task) {
  return Boolean(task) && !TERMINAL.has(task.status)
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => Number(b.id) - Number(a.id))
}

export function summarizeTask(task) {
  const statusLabel = {
    QUEUED: '排队中', RUNNING: '训练中', SUCCEEDED: '已完成', FAILED: '失败', CANCELED: '已取消'
  }[task.status] || task.status
  const duration = task.startedAt && task.finishedAt
    ? Math.max(0, (Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000)
    : null
  const metrics = task.metrics || {}
  const after = metrics.after || metrics.history?.at(-1) || null
  const percent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : null)
  const parts = after
    ? [['MNIST', after.raw_mnist_1000 ?? after.raw_mnist],
       ['画板', after.canvas_simulated_1000 ?? after.canvas_simulated],
       ['照片', after.photo_simulated_1000 ?? after.photo_simulated]]
        .map(([label, value]) => (percent(value) ? `${label} ${percent(value)}` : null))
        .filter(Boolean)
    : []
  return {
    id: task.id,
    status: task.status,
    statusLabel,
    attemptLabel: task.attempt ? `第 ${task.attempt} 次尝试` : '尚未开始',
    paramsLabel: `epoch ${task.epochs} · 样本 ${task.samples} · batch ${task.batchSize} · lr ${task.learningRate}`,
    durationLabel: duration === null ? '—' : `${duration.toFixed(1)}s`,
    versionLabel: task.modelVersion || '—',
    digestLabel: task.sha256 ? `${task.sha256.slice(0, 12)}…` : '—',
    errorLabel: task.errorCategory ? `${task.errorCategory}${task.errorMessage ? '：' + task.errorMessage : ''}` : '',
    metricsLabel: parts.length ? parts.join(' · ') : '暂无指标'
  }
}

/**
 * @param api        {listDatasets, listTasks, createTask}
 * @param getSession () => authSession
 * @param onTasks    (tasks) => void
 * @param onError    (message) => void
 * @param intervalMs 轮询间隔
 */
export function createTrainingBoard({ api, getSession, onTasks = () => {}, onError = () => {},
                                      intervalMs = 4000,
                                      schedule = (fn, ms) => setInterval(fn, ms),
                                      unschedule = (handle) => clearInterval(handle) }) {
  let timer = null
  let disposed = false
  let tasks = []

  function publish(next) {
    tasks = sortTasks(next)
    onTasks(tasks)
    return tasks
  }

  async function refresh() {
    const next = await api.listTasks(getSession(), 20)
    if (disposed) return tasks
    if (!Array.isArray(next)) throw new Error('任务列表格式无效')
    publish(next)
    if (!tasks.some(isActiveTask)) stop()
    return tasks
  }

  function start() {
    if (disposed || timer) return
    timer = schedule(async () => {
      try {
        await refresh()
      } catch (failure) {
        onError(failure?.message || '刷新训练任务失败')
      }
    }, intervalMs)
  }

  function stop() {
    if (timer) { unschedule(timer); timer = null }
  }

  async function load() {
    try {
      const datasets = await api.listDatasets(getSession())
      if (!Array.isArray(datasets)) throw new Error('数据集列表格式无效')
      return datasets
    } catch (failure) {
      onError(failure?.message || '加载数据集失败')
      return []
    }
  }

  async function create(datasetId, payload) {
    const created = await api.createTask(datasetId, payload, getSession())
    if (!created || typeof created.id !== 'string' || created.status !== 'QUEUED')
      throw new Error('服务端未确认任务已入队')
    publish([created, ...tasks])
    start()
    return created
  }

  function dispose() {
    disposed = true
    stop()
  }

  return { refresh, start, stop, load, create, dispose,
           get tasks() { return tasks }, polling: () => Boolean(timer) }
}
