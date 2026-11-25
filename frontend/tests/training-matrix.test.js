import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellIntensity, detailedView, domainOptions, formatScore } from '../src/training/matrix.js'

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

// ---------------------------------------------------------------- 三个评估域

function domainDetail(confusion, extra = {}) {
  const perClass = confusion.map((row, label) => {
    const support = row.reduce((sum, value) => sum + value, 0)
    const predicted = confusion.reduce((sum, item) => sum + item[label], 0)
    const correct = row[label]
    const precision = predicted ? correct / predicted : null
    const recall = support ? correct / support : null
    return {
      label, support, predicted, correct, accuracy: support ? correct / support : null,
      precision, recall,
      f1: precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall) : null
    }
  })
  return {
    perClass, confusion, worst: [], errorCount: 0, errors: [],
    macro: { precision: 1, recall: 1, f1: 1, classes: 10 },
    weighted: { f1: 1 }, ...extra
  }
}

test('domain options list every evaluated domain and fall back to the legacy field', () => {
  assert.deepEqual(domainOptions(null), [])
  const legacy = domainOptions(metricsWith(IDENTITY))
  assert.deepEqual(legacy, [{ key: 'canvas_simulated', label: '画板模拟' }])

  const full = domainOptions({
    detailed: {
      raw_mnist: domainDetail(IDENTITY),
      canvas_simulated: domainDetail(IDENTITY),
      photo_simulated: domainDetail(IDENTITY)
    }
  })
  assert.deepEqual(full.map((item) => item.key), ['raw_mnist', 'canvas_simulated', 'photo_simulated'])
  assert.equal(full[2].label, '照片模拟')
})

test('a selected domain is rendered instead of the canvas default', () => {
  const raw = IDENTITY.map((row) => [...row])
  const photo = IDENTITY.map((row) => [...row])
  photo[4][9] = 3
  photo[4][4] = 7
  const metrics = { detailed: { raw_mnist: domainDetail(raw), photo_simulated: domainDetail(photo) } }

  assert.equal(detailedView(metrics, 'raw_mnist').matrix[4][9], 0)
  const photoView = detailedView(metrics, 'photo_simulated')
  assert.equal(photoView.matrix[4][9], 3)
  assert.equal(photoView.perClass[4].percent, 70)
  assert.equal(photoView.perClass[4].total, 10)
  // 未指定域时回退到画板域；这里没有画板域，就用第一个可用域，不能返回 null
  assert.ok(detailedView(metrics))
})

test('per-class precision/recall/f1 and macro averages are exposed', () => {
  const confusion = IDENTITY.map((row) => [...row])
  confusion[7][1] = 2   // 7 被误判成 1 两条
  confusion[7][7] = 8
  const view = detailedView({ detailed: { canvas_simulated: domainDetail(confusion) } }, 'canvas_simulated')
  const seven = view.perClass[7]
  // 7：真实 10 条、判成 7 的 8 条、其中对 8 条
  assert.equal(seven.total, 10)
  assert.equal(seven.predicted, 8)
  assert.equal(seven.precision, 1)
  assert.equal(seven.recall, 0.8)
  assert.ok(Math.abs(seven.f1 - 8 / 9) < 1e-9)
  // 1：被 7 那两条误伤了查准率（列求和 12，其中 10 对）
  assert.equal(view.perClass[1].precision, 10 / 12)
  // 宏/加权由后端算好，前端原样透出
  assert.equal(view.macro.f1, 1)
  assert.equal(view.weighted.f1, 1)
})

test('null precision/recall stays null instead of becoming 0%', () => {
  const sparse = Array.from({ length: 10 }, () => Array(10).fill(0))
  sparse[1][1] = 5
  const view = detailedView({ detailed: { raw_mnist: domainDetail(sparse) } }, 'raw_mnist')
  assert.equal(view.perClass[1].percent, 100)
  assert.equal(view.perClass[0].precision, null)
  assert.equal(formatScore(view.perClass[0].precision), '—')
  assert.equal(formatScore(view.perClass[1].precision), '100.0%')
})

test('errors and errorCount are passed through for backtracking', () => {
  const detail = domainDetail(IDENTITY, {
    errorCount: 12,
    errors: [
      { index: 40, truth: 4, predicted: 9, confidence: 0.97 },
      { index: 7, truth: 7, predicted: 1, confidence: 0.91 }
    ],
    errorSheet: 'errors-canvas_simulated.png'
  })
  const view = detailedView({ detailed: { canvas_simulated: detail } }, 'canvas_simulated')
  assert.equal(view.errorCount, 12)
  assert.deepEqual(view.errors.map((item) => item.index), [40, 7])
  assert.equal(view.errorSheet, 'errors-canvas_simulated.png')
})
