import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskDetail } from '../src/training/detail.js'

const TASK = {
  id: '20', status: 'SUCCEEDED', epochs: 2, samples: 1000, batchSize: 64, learningRate: 0.001,
  seed: 42, photoRatio: 0.5, initFrom: 'w4-task-8-a1', datasetVersionId: '2',
  metrics: {
    samples_rendered: 981, samples_unusable: 19, extra_samples: 19,
    history: [
      { epoch: 1, loss: 0.391, raw_mnist: 0.911, canvas_simulated: 0.902, photo_simulated: 0.6, durationMs: 1200 },
      { epoch: 2, loss: 0.211, raw_mnist: 0.951, canvas_simulated: 0.94, photo_simulated: 0.64, durationMs: 800 }
    ]
  }
}

test('detail exposes hyperparameter cards', () => {
  const { cards } = taskDetail(TASK)
  const map = Object.fromEntries(cards.map((card) => [card.key, card.value]))
  assert.equal(map.epochs, 2)
  assert.equal(map.batch, 64)
  assert.equal(map.lr, 0.001)
  assert.equal(map.initFrom, 'w4-task-8-a1')
  assert.equal(map.dataset, '#2')
  assert.equal(taskDetail({}).cards.find((card) => card.key === 'dataset').value, '未使用')
})

test('detail keeps per-epoch metrics and durations', () => {
  const { rows, durations, maxDuration } = taskDetail(TASK)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].mnist, 91.1)
  assert.equal(rows[1].canvas, 94)
  assert.equal(rows[1].durationMs, 800)
  assert.deepEqual(durations, [1200, 800])
  assert.equal(maxDuration, 1200)
})

test('detail reports sample composition', () => {
  const { composition } = taskDetail(TASK)
  assert.equal(composition.extraSamples, 19)
  assert.equal(composition.rendered, 981)
  assert.equal(composition.unusable, 19)
  assert.equal(taskDetail({ metrics: {} }).composition.extraSamples, 0)
})

test('detail handles tasks without metrics', () => {
  const empty = taskDetail({ id: '1', status: 'QUEUED' })
  assert.equal(empty.hasHistory, false)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.maxDuration, 1)
})
