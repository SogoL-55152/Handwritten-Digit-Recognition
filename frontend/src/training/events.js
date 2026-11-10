/**
 * 训练任务实时推送：先换一次性票据，再用它订阅 SSE。
 * EventSource 在测试或旧浏览器里可能不存在，此时返回空客户端，调用方保留轮询兜底。
 */
export function createTrainingEvents({
  api,
  getSession,
  onTask = () => {},
  onStatus = () => {},
  EventSourceImpl = globalThis.EventSource,
  retryDelayMs = 4000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle)
}) {
  let source = null
  let timer = null
  let closed = false

  function teardown() {
    if (source) { try { source.close() } catch (ignored) { /* 已关闭 */ } source = null }
    if (timer) { cancel(timer); timer = null }
  }

  function scheduleReconnect() {
    if (closed || timer) return
    if (source) { try { source.close() } catch (ignored) { /* ignore */ } source = null }
    timer = schedule(() => { timer = null; connect() }, retryDelayMs)
  }

  async function connect() {
    if (closed) return
    if (typeof EventSourceImpl !== 'function') { onStatus('unavailable'); return }
    try {
      const issued = await api.eventsTicket(getSession())
      const ticket = issued && issued.ticket
      if (!ticket) throw new Error('未取得订阅票据')
      if (closed) return
      source = new EventSourceImpl(`/api/v2/admin/training/events?ticket=${encodeURIComponent(ticket)}`)
      source.addEventListener('ready', () => onStatus('live'))
      source.addEventListener('task', (event) => {
        try {
          onTask(JSON.parse(event.data))
        } catch (ignored) { /* 单条坏数据不影响后续 */ }
      })
      source.onerror = () => { onStatus('reconnecting'); scheduleReconnect() }
    } catch (failure) {
      onStatus('unavailable')
      scheduleReconnect()
    }
  }

  connect()
  return {
    close() { closed = true; teardown() },
    status() { return closed ? 'closed' : source ? 'live' : 'connecting' }
  }
}
