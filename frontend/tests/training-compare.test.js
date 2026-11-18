import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffRows, fineTunePairs, paramRows } from '../src/training/params.js'

const TASKS = [
  {
    id: '20', status: 'SUCCEEDED', epochs: 1, samples: 1000, batchSize: 64, learningRate: 0.001,
    photoRatio: 0.5, initFrom: null, modelVersion: 'w4-task-20-a1',
    metrics: { after: { canvas_simulated_1000: 0.88 } }
  },
  {
    id: '21', status: 'SUCCEEDED', epochs: 2, samples: 2000, batchSize: 64, learningRate: 0.001,
    photoRatio: 0.5, initFrom: 'w4-task-20-a1', modelVersion: 'w4-task-21-a1',
    metrics: { after: { canvas_simulated_1000: 0.93 } }
  },
  {
    id: '22', status: 'SUCCEEDED', epochs: 1, samples: 1000, batchSize: 32, learningRate: 0.0005,
    photoRatio: 0.2, initFrom: 'w4-task-unknown', modelVersion: 'w4-task-22-a1',
    metrics: { after: { canvas_simulated_1000: 0.8 } }
  }
]

test('fine-tune pairs compare against the starting model when it exists', () => {
  const pairs = fineTunePairs(paramRows(TASKS))
  assert.equal(pairs.length, 2)
  const first = pairs.find((pair) => pair.id === '21')
  assert.equal(first.baseId, '20')
  assert.equal(first.baseScore, 88)
  assert.equal(first.score, 93)
  assert.equal(first.delta, 5)
  const unknown = pairs.find((pair) => pair.id === '22')
  assert.equal(unknown.baseId, null)
  assert.equal(unknown.baseScore, null)
  assert.equal(unknown.delta, null)
})

test('pairs are sorted by delta with unknown last', () => {
  const pairs = fineTunePairs(paramRows(TASKS))
  assert.deepEqual(pairs.map((pair) => pair.id), ['21', '22'])
})

test('diff rows mark equal and different parameters', () => {
  const rows = paramRows(TASKS)
  const a = { ...rows[0], score: 88 }
  const b = { ...rows[1], score: 93 }
  const diff = diffRows(a, b)
  const byKey = Object.fromEntries(diff.map((row) => [row.key, row]))
  assert.equal(byKey.samples.same, false)
  assert.equal(byKey.batchSize.same, true)
  assert.equal(byKey.score.left, 88)
  assert.equal(byKey.score.right, 93)
  assert.equal(diffRows(null, b).length, 0)
})
