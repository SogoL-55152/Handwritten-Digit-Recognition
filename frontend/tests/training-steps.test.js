import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeLogs, stepSeriesOf, stepsSummary } from '../src/training/steps.js'

const METRICS = {
  stepSeries: [
    { step: 640, epoch: 1, loss: 2.1, lr: 0.001 },
    { step: 1280, epoch: 1, loss: 1.5, lr: 0.001 },
    { step: 1920, epoch: 2, loss: 0.9, lr: 0.0008 },
    { step: 2560, epoch: 2, loss: 0.7, lr: 0.0006 }
  ],
  bestEpoch: 2
}

test('step series are sorted and validated', () => {
  const points = stepSeriesOf({ stepSeries: [...METRICS.stepSeries].reverse() })
  assert.deepEqual(points.map((point) => point.step), [640, 1280, 1920, 2560])
  assert.equal(points[0].loss, 2.1)
  assert.equal(stepSeriesOf(null).length, 0)
  assert.equal(stepSeriesOf({ stepSeries: [{ step: 'x' }] }).length, 0)
})

test('step series respects the limit', () => {
  assert.equal(stepSeriesOf(METRICS, 2).length, 2)
})

test('summary reports counts, range and loss bounds', () => {
  const summary = stepsSummary(METRICS)
  assert.equal(summary.count, 4)
  assert.equal(summary.firstStep, 640)
  assert.equal(summary.lastStep, 2560)
  assert.equal(summary.minLoss, 0.7)
  assert.equal(summary.maxLoss, 2.1)
  assert.equal(summary.epochs, 2)
  assert.equal(stepsSummary({}), null)
})

test('mergeLogs keeps the larger snapshot', () => {
  assert.deepEqual(mergeLogs([], ['a']), ['a'])
  assert.deepEqual(mergeLogs(['a', 'b'], []), ['a', 'b'])
  assert.deepEqual(mergeLogs(['a'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(mergeLogs(['a', 'b'], ['a']), ['a'])
})
