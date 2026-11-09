import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateTraining, validateDataset, toCreatePayload } from '../src/training/validation.js'
import { createTrainingBoard, isActiveTask, sortTasks, summarizeTask } from '../src/training/board.js'

const VALID = { epochs: 1, samples: 1000, batchSize: 64, learningRate: 0.001, seed: 7, photoRatio: 0.5, useEmnist: false, initFrom: null }

function task(overrides = {}) {
  return {
    id: '7', status: 'SUCCEEDED', attempt: 1, celeryTaskId: 'c-7', epochs: 1, samples: 1000, batchSize: 64,
    learningRate: 0.001, seed: 7, photoRatio: 0.5, useEmnist: false, targetModelId: '1',
    modelVersion: 'w4-task-7-a1', artifact: 'w4-train/7/checkpoint.pt', sha256: 'a'.repeat(64),
    sizeBytes: 1690340, errorCategory: null, errorMessage: null,
    queuedAt: '2026-11-08T00:00:00Z', startedAt: '2026-11-08T00:00:01Z', finishedAt: '2026-11-08T00:00:16Z',
    metrics: { after: { raw_mnist_1000: 0.9, canvas_simulated_1000: 0.88, photo_simulated_1000: 0.6 } },
    ...overrides
  }
}

function fakeApi(overrides = {}) {
  const calls = []
  const tasks = [task({ id: '6' }), task({ id: '7' })]
  return {
    calls,
    listDatasets: async () => { calls.push(['datasets']); return [{ id: '1', name: 'MNIST', trainSamples: 60000 }] },
    listTasks: async () => { calls.push(['tasks']); return tasks.map((item) => ({ ...item })) },
    createTask: async (datasetId, payload) => {
      calls.push(['create', datasetId, payload])
      return task({ id: '8', status: 'QUEUED', attempt: 0, modelVersion: null, sha256: null, metrics: null })
    },
    ...overrides
  }
}

test('payload only contains the fields the server contract accepts', () => {
  assert.deepEqual(toCreatePayload({ ...VALID, datasetId: 1, extra: 'ignored' }), VALID)
  assert.deepEqual(Object.keys(toCreatePayload(VALID)).sort(),
    ['batchSize', 'epochs', 'initFrom', 'learningRate', 'photoRatio', 'samples', 'seed', 'useEmnist'])
})

test('dataset id must be a positive integer', () => {
  assert.deepEqual(validateDataset(1), {})
  for (const value of [0, -1, 1.5, '1', null, undefined]) assert.ok(validateDataset(value).datasetId, String(value))
})

test('initFrom accepts a registered version token or null only', () => {
  assert.deepEqual(validateTraining({ ...VALID, initFrom: 'w2-canvas-photo-3epoch' }), {})
  for (const value of ['', 'has space', '-leading', 'x'.repeat(65), 1]) {
    assert.ok(validateTraining({ ...VALID, initFrom: value }).initFrom, String(value))
  }
})

test('validation reports every invalid field at once', () => {
  const errors = validateTraining({ epochs: 0, samples: 10, batchSize: 7, learningRate: 0, seed: -1, photoRatio: 2, useEmnist: 'x', initFrom: '' })
  assert.deepEqual(Object.keys(errors).sort(),
    ['batchSize', 'epochs', 'initFrom', 'learningRate', 'photoRatio', 'samples', 'seed', 'useEmnist'])
  assert.deepEqual(validateTraining(VALID), {})
})

test('task summary exposes labels, duration and metrics', () => {
  const summary = summarizeTask(task())
  assert.equal(summary.statusLabel, '已完成')
  assert.equal(summary.attemptLabel, '第 1 次尝试')
  assert.equal(summary.durationLabel, '15.0s')
  assert.match(summary.metricsLabel, /MNIST 90\.00%/)
  assert.match(summary.digestLabel, /^a{12}…$/)
  const failed = summarizeTask(task({ status: 'FAILED', errorCategory: 'TIMEOUT', errorMessage: '训练超时' }))
  assert.equal(failed.statusLabel, '失败')
  assert.match(failed.errorLabel, /TIMEOUT/)
  assert.equal(summarizeTask(task({ metrics: null })).metricsLabel, '暂无指标')
})

test('active tasks are the non-terminal ones and lists sort newest first', () => {
  assert.equal(isActiveTask({ status: 'QUEUED' }), true)
  assert.equal(isActiveTask({ status: 'RUNNING' }), true)
  assert.equal(isActiveTask({ status: 'SUCCEEDED' }), false)
  assert.equal(isActiveTask({ status: 'FAILED' }), false)
  assert.deepEqual(sortTasks([{ id: '9' }, { id: '10' }, { id: '2' }]).map((item) => item.id), ['10', '9', '2'])
})

test('creating a task publishes it and starts polling', async () => {
  const api = fakeApi()
  const timers = []
  const board = createTrainingBoard({
    api, getSession: () => ({ token: 't' }),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    unschedule: () => {}
  })
  const created = await board.create(1, VALID)
  assert.equal(created.status, 'QUEUED')
  assert.equal(board.tasks[0].id, '8')
  assert.equal(board.polling(), true)
  assert.deepEqual(api.calls.at(-1), ['create', 1, VALID])
  assert.equal(timers[0].ms, 4000)
})

test('polling stops once every task is terminal and starts again on demand', async () => {
  const api = fakeApi()
  let cleared = 0
  const board = createTrainingBoard({
    api, getSession: () => ({ token: 't' }),
    schedule: () => 1, unschedule: () => { cleared += 1 }
  })
  await board.refresh() // 全部 SUCCEEDED
  assert.equal(board.polling(), false)
  board.start()
  assert.equal(board.polling(), true)
  board.dispose()
  assert.equal(cleared >= 1, true)
  assert.equal(board.polling(), false)
})

test('refresh keeps polling while a task is still running', async () => {
  const api = fakeApi({
    listTasks: async () => [task({ id: '9', status: 'RUNNING', modelVersion: null, metrics: null })]
  })
  let cleared = 0
  const board = createTrainingBoard({
    api, getSession: () => ({ token: 't' }),
    schedule: () => 5, unschedule: () => { cleared += 1 }
  })
  board.start()
  await board.refresh()
  assert.equal(board.polling(), true)
  assert.equal(cleared, 0)
  board.dispose()
})

test('create refuses a response the server did not confirm as queued', async () => {
  const api = fakeApi({ createTask: async () => task({ id: '8', status: 'SUCCEEDED' }) })
  const board = createTrainingBoard({ api, getSession: () => ({ token: 't' }),
    schedule: () => 1, unschedule: () => {} })
  await assert.rejects(() => board.create(1, VALID), /未确认/)
})

test('load surfaces dataset errors and never throws into the view', async () => {
  const messages = []
  const api = fakeApi({ listDatasets: async () => { throw new Error('网络异常') } })
  const board = createTrainingBoard({ api, getSession: () => ({ token: 't' }), onError: (m) => messages.push(m),
    schedule: () => 1, unschedule: () => {} })
  assert.deepEqual(await board.load(), [])
  assert.deepEqual(messages, ['网络异常'])
})
