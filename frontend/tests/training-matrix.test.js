import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellIntensity, detailedView } from '../src/training/matrix.js'

function metricsWith(confusion) {
  const perClass = confusion.map((row, label) => {
    const total = row.reduce((sum, value) => sum + value, 0)
    return { label, correct: row[label], total, accuracy: total ? row[label] / total : null }
  })
  return { detailed_canvas: { perClass, confusion, worst: [] } }
}

const IDENTITY = Array.from({ length: 10 }, (_, index) => {
  const row = Array(10).fill(0)
  row[index] = 10
  return row
})

test('missing detailed metrics are handled', () => {
  assert.equal(detailedView(null), null)
  assert.equal(detailedView({}), null)
  assert.equal(detailedView({ detailed_canvas: { perClass: [], confusion: [] } }), null)
})

test('confusion matrix and per-class accuracy are computed', () => {
  const confusion = IDENTITY.map((row) => [...row])
  confusion[7][1] = 2   // 7 被误判成 1 两条
  confusion[7][7] = 8
  const view = detailedView(metricsWith(confusion))
  assert.equal(view.matrix[7][1], 2)
  assert.equal(view.matrix[7][7], 8)
  const seven = view.perClass[7]
  assert.equal(seven.total, 10)
  assert.equal(seven.percent, 80)
  assert.equal(view.max, 10)
})

test('worst classes are ordered by accuracy with ties broken by label order', () => {
  const confusion = IDENTITY.map((row) => [...row])
  confusion[3][3] = 4   // 3: 40%
  confusion[3][8] = 6
  confusion[5][5] = 6   // 5: 60%
  confusion[5][6] = 4
  const view = detailedView(metricsWith(confusion))
  assert.deepEqual(view.worst.map((item) => item.label), [3, 5, 0])
  assert.equal(view.worst[0].percent, 40)
})

test('cell intensity grows with count and is capped', () => {
  assert.equal(cellIntensity(0, 10), 0)
  assert.ok(cellIntensity(1, 10) > 0)
  assert.ok(cellIntensity(10, 10) > cellIntensity(1, 10))
  assert.ok(cellIntensity(10, 10) <= 1)
  assert.equal(cellIntensity(5, 0), 0)
})
