import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paramRows, rankedRows, spreadOf, tunedRows } from '../src/training/params.js'

const TASKS = [
  {
    id: '20', status: 'SUCCEEDED', epochs: 1, samples: 1000, batchSize: 64, learningRate: 0.001,
    seed: 42, photoRatio: 0.5, initFrom: null, datasetVersionId: '2',
    startedAt: '2026-11-18T06:00:00Z', finishedAt: '2026-11-18T06:00:20Z', modelVersion: 'w4-task-20-a1',
    metrics: { extra_samples: 19, after: { raw_mnist_1000: 0.9, canvas_simulated_1000: 0.88 } }
  },
  {
    id: '21', status: 'SUCCEEDED', epochs: 2, samples: 5000, batchSize: 64, learningRate: 0.0005,
    seed: 7, photoRatio: 0.3, initFrom: 'w4-task-20-a1', datasetVersionId: null,
    startedAt: '2026-11-18T06:05:00Z', finishedAt: '2026-11-18T06:06:00Z', modelVersion: 'w4-task-21-a1',
    metrics: { history: [{ epoch: 1, canvas_simulated: 0.9 }, { epoch: 2, canvas_simulated: 0.93, raw_mnist: 0.95 }] }
  },
  { id: '22', status: 'FAILED', epochs: 1, samples: 1000, metrics: null }
]

test('param rows expose hyperparameters, scores and duration', () => {
  const rows = paramRows(TASKS)
  assert.equal(rows.length, 3)
  const first = rows[0]
  assert.equal(first.samples, 1000)
  assert.equal(first.learningRate, 0.001)
  assert.equal(first.canvas, 88)
  assert.equal(first.mnist, 90)
  assert.equal(first.extraSamples, 19)
  assert.equal(first.durationSeconds, 20)
  const second = rows[1]
  assert.equal(second.canvas, 93)   // 取最后一轮
  assert.equal(second.durationSeconds, 60)
  assert.equal(rows[2].canvas, null)
})

test('ranking keeps only scored tasks and sorts descending', () => {
  const ranked = rankedRows(paramRows(TASKS))
  assert.deepEqual(ranked.map((row) => row.id), ['21', '20'])
  assert.equal(ranked[0].score, 93)
})

test('spread counts distinct parameter values', () => {
  const spread = spreadOf(paramRows(TASKS))
  assert.equal(spread.samples, 2)
  assert.equal(spread.epochs, 2)
  assert.equal(spread.learningRate, 2)
  assert.equal(spread.initFrom, 1)   // 只有一个任务带微调起点
})

test('tuned rows split by fine-tuning origin', () => {
  const { fromScratch, tuned } = tunedRows(paramRows(TASKS))
  assert.deepEqual(fromScratch.map((row) => row.id), ['20', '22'])
  assert.deepEqual(tuned.map((row) => row.id), ['21'])
})
