import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickDefaultTask, taskOptions } from '../src/training/visual.js'

const TASKS = [
  { id: '18', status: 'FAILED', modelVersion: null, metrics: null },
  {
    id: '20', status: 'SUCCEEDED', modelVersion: 'w4-task-20-a1',
    metrics: {
      extra_samples: 19,
      history: [{ epoch: 1, loss: 0.4, raw_mnist: 0.9, canvas_simulated: 0.88, photo_simulated: 0.6, durationMs: 900 }],
      after: { raw_mnist_1000: 0.9, canvas_simulated_1000: 0.88, photo_simulated_1000: 0.6 }
    }
  },
  { id: '1', status: 'QUEUED', metrics: null }
]

test('task options expose status, metrics presence and scores', () => {
  const options = taskOptions(TASKS)
  assert.equal(options.length, 3)
  const done = options.find((item) => item.id === '20')
  assert.equal(done.hasMetrics, true)
  assert.equal(done.mnist, 0.9)
  assert.equal(done.canvas, 0.88)
  assert.equal(done.epochs, 1)
  assert.equal(done.extraSamples, 19)
  const failed = options.find((item) => item.id === '18')
  assert.equal(failed.hasMetrics, false)
  assert.equal(failed.mnist, null)
})

test('default task prefers a succeeded task with metrics', () => {
  assert.equal(pickDefaultTask(taskOptions(TASKS)), '20')
  assert.equal(pickDefaultTask([{ id: '3', status: 'FAILED', hasMetrics: false }]), '3')
  assert.equal(pickDefaultTask([]), null)
  assert.equal(pickDefaultTask(null), null)
})
