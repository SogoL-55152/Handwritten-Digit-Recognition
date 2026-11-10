import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dailySeries, formatCount, formatMs, formatRatio, modelRows, ratio, summaryCards, trainingCard
} from '../src/statistics/format.js'
import { dailyOption, modelShareOption, trainingCurveOption } from '../src/statistics/chart.js'
import { createTrainingEvents } from '../src/training/events.js'

const STATS = {
  days: 7, total: 100, accepted: 80, declined: 15, failed: 5, averageProcessingMs: 412.5,
  daily: [
    { date: '2026-11-08', total: 40, accepted: 32, declined: 6, failed: 2 },
    { date: '2026-11-09', total: 60, accepted: 48, declined: 9, failed: 3 }
  ],
  models: [
    { modelVersion: 'w2-canvas-photo-3epoch', total: 75, accepted: 62 },
    { modelVersion: 'w2-canvas-photo-b-2epoch', total: 25, accepted: 18 }
  ],
  note: '不给准确率'
}

test('counts and latency format predictably', () => {
  assert.equal(formatCount(12345), '12,345')
  assert.equal(formatCount(undefined), '0')
  assert.equal(formatMs(412.5), '413ms')
  assert.equal(formatMs(2500), '2.50s')
  assert.equal(formatMs(0), '—')
  assert.equal(ratio(15, 100), 15)
  assert.equal(ratio(1, 0), 0)
  assert.equal(formatRatio(80, 100), '80.0%')
})

test('summary cards split accepted, declined and failed', () => {
  const cards = summaryCards(STATS)
  assert.deepEqual(cards.map((card) => card.key), ['total', 'accepted', 'declined', 'failed', 'latency'])
  assert.equal(cards[0].value, '100')
  assert.equal(cards[2].hint, '15.0%')
  assert.equal(cards[4].value, '413ms')
  assert.equal(trainingCard(STATS), null)
  assert.equal(trainingCard({ trainingTotal: 4, trainingSucceeded: 3, trainingFailed: 1 }).hint, '成功 3 · 失败 1')
})

test('daily series keeps labels and splits statuses', () => {
  const series = dailySeries(STATS)
  assert.deepEqual(series.dates, ['11-08', '11-09'])
  assert.deepEqual(series.total, [40, 60])
  assert.deepEqual(series.declined, [6, 9])
  assert.deepEqual(dailySeries(null).dates, [])
})

test('model rows compute share against window total', () => {
  const rows = modelRows(STATS)
  assert.equal(rows[0].share, '75.0%')
  assert.equal(rows[0].acceptedRate, '82.7%')
  assert.equal(rows[1].version, 'w2-canvas-photo-b-2epoch')
})

test('chart options carry the series the page needs', () => {
  const daily = dailyOption(dailySeries(STATS))
  assert.deepEqual(daily.xAxis.data, ['11-08', '11-09'])
  assert.equal(daily.series[0].name, '请求')
  const curve = trainingCurveOption([{ epoch: 1, loss: 1.2, raw_mnist: 0.9, canvas_simulated: 0.88, photo_simulated: 0.5 }])
  assert.deepEqual(curve.xAxis.data, ['第 1 轮'])
  assert.deepEqual(curve.series[1].data, [90])
  assert.equal(curve.series[0].yAxisIndex, 0)
  const share = modelShareOption(modelRows(STATS))
  assert.equal(share.series[0].data.length, 2)
})

test('training curve tolerates missing metrics', () => {
  const curve = trainingCurveOption([])
  assert.deepEqual(curve.xAxis.data, [])
  assert.deepEqual(curve.series[3].data, [])
})

function fakeEventSource() {
  const created = []
  class FakeSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; created.push(this) }
    addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) }
    emit(name, data) { (this.listeners[name] || []).forEach((handler) => handler({ data })) }
    close() { this.closed = true }
  }
  return { FakeSource, created }
}

test('events client subscribes with a ticket and forwards tasks', async () => {
  const { FakeSource, created } = fakeEventSource()
  const received = []
  const statuses = []
  const api = { eventsTicket: async () => ({ ticket: 'abc123' }) }
  const client = createTrainingEvents({
    api, getSession: () => ({ token: 't' }), onTask: (task) => received.push(task),
    onStatus: (status) => statuses.push(status), EventSourceImpl: FakeSource,
    schedule: () => 1, cancel: () => {}
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(created.length, 1)
  assert.match(created[0].url, /ticket=abc123$/)
  created[0].emit('ready')
  created[0].emit('task', JSON.stringify({ id: '9', status: 'RUNNING' }))
  created[0].emit('task', 'not-json')
  assert.deepEqual(statuses, ['live'])
  assert.deepEqual(received, [{ id: '9', status: 'RUNNING' }])
  client.close()
  assert.equal(created[0].closed, true)
  assert.equal(client.status(), 'closed')
})

test('events client reports unavailability instead of throwing', async () => {
  const statuses = []
  const client = createTrainingEvents({
    api: { eventsTicket: async () => { throw new Error('401') } },
    getSession: () => ({ token: 't' }), onStatus: (status) => statuses.push(status),
    EventSourceImpl: fakeEventSource().FakeSource, schedule: () => 1, cancel: () => {}
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(statuses, ['unavailable'])
  client.close()
})

test('events client falls back when EventSource is missing', async () => {
  const statuses = []
  const client = createTrainingEvents({
    api: { eventsTicket: async () => ({ ticket: 'x' }) },
    getSession: () => ({ token: 't' }), onStatus: (status) => statuses.push(status),
    EventSourceImpl: undefined, schedule: () => 1, cancel: () => {}
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(statuses, ['unavailable'])
  client.close()
})
