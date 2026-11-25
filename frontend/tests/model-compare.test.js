import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  disagreementRows, domainRows, formatPercent, metaRows, summaryLine, verdict
} from '../src/models/compare.js'

function side(overrides = {}) {
  return {
    id: '1', version: 'v-a', externalId: 'mnist-cnn-w1', preprocessVersion: 'adaptive-mnist-v2',
    status: 'INACTIVE', accuracy: 0.977, accuracyDataset: 'MNIST test', origin: 'BUILTIN',
    trainedAt: null, sha256: 'a'.repeat(64), sizeBytes: 1690340, inRegistry: true, verified: true,
    trainingMetrics: null, ...overrides
  }
}

function compareView(overrides = {}) {
  return {
    modelA: side(),
    modelB: side({ id: '2', version: 'v-b', status: 'ACTIVE', origin: 'TRAINED', accuracy: null,
      accuracyDataset: null, sha256: 'b'.repeat(64),
      trainingMetrics: {
        after: { raw_mnist_1000: 0.65, canvas_simulated_1000: 0.82, photo_simulated_1000: 0.33 },
        macro: { raw_mnist: { f1: 0.61 }, canvas_simulated: { f1: 0.81 } }
      } }),
    summary: { samples: 4, labelled: 4, agreement: 2, agreementRate: 0.5, accuracyA: 0.5, accuracyB: 0.75,
      bothRight: 2, onlyA: 0, onlyB: 1, bothWrong: 1, meanConfidenceA: 0.9, meanConfidenceB: 0.8 },
    rows: [
      { index: 0, sampleId: '11', label: 7, digitA: 7, confidenceA: 0.95, digitB: 7, confidenceB: 0.85, agree: true },
      { index: 1, sampleId: '12', label: 3, digitA: 9, confidenceA: 0.88, digitB: 3, confidenceB: 0.7, agree: false },
      { index: 2, sampleId: '13', label: 1, digitA: 1, confidenceA: 0.99, digitB: 7, confidenceB: 0.6, agree: false },
      { index: 3, sampleId: '14', label: 5, digitA: 6, confidenceA: 0.5, digitB: 8, confidenceB: 0.4, agree: false },
      { index: 4, sampleId: '15', label: 2, digitA: 2, confidenceA: 0.9, digitB: 2, confidenceB: 0.9, agree: true }
    ],
    processingMs: 120, datasetVersionId: 6, skipped: 1,
    ...overrides
  }
}

test('formatPercent keeps null as a dash instead of 0%', () => {
  assert.equal(formatPercent(0.5), '50.0%')
  assert.equal(formatPercent(0.9773, 2), '97.73%')
  assert.equal(formatPercent(null), '—')
  assert.equal(formatPercent(undefined), '—')
  assert.equal(formatPercent(Number.NaN), '—')
})

test('meta rows line the two versions up field by field', () => {
  const rows = metaRows(compareView())
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]))
  assert.equal(byLabel['版本'].a, 'v-a')
  assert.equal(byLabel['版本'].b, 'v-b')
  assert.equal(byLabel['登记准确率'].a, '97.70%')
  assert.equal(byLabel['登记准确率'].b, '—')
  assert.equal(byLabel['注册表'].a, '可推理')
  assert.equal(byLabel['权重摘要'].a, 'aaaaaaaa')
  assert.equal(rows.length, 9)
})

test('registry label distinguishes unverified and missing entries', () => {
  const rows = metaRows(compareView({ modelB: side({ inRegistry: false, verified: false }) }))
  assert.equal(rows.find((row) => row.label === '注册表').b, '不在注册表')
  const unverified = metaRows(compareView({ modelB: side({ inRegistry: true, verified: false }) }))
  assert.equal(unverified.find((row) => row.label === '注册表').b, '未通过校验')
})

test('domain rows compare training-time metrics and show the delta', () => {
  const rows = domainRows(compareView())
  assert.deepEqual(rows.map((row) => row.domain), ['raw_mnist', 'canvas_simulated', 'photo_simulated'])
  const canvas = rows.find((row) => row.domain === 'canvas_simulated')
  assert.equal(canvas.accuracyA, '—')          // A 没有训练指标
  assert.equal(canvas.accuracyB, '82.0%')
  assert.equal(canvas.f1B, '81.0%')
  assert.equal(canvas.delta, null)
  assert.deepEqual(domainRows(compareView({ modelB: side({ trainingMetrics: null }) })), [])
})

test('disagreements only include differing rows and name who is right', () => {
  const rows = disagreementRows(compareView())
  assert.deepEqual(rows.map((row) => row.sampleId), ['12', '13', '14'])
  assert.deepEqual(rows.map((row) => row.who), ['B', 'A', 'both-wrong'])
  assert.equal(disagreementRows(compareView(), 1).length, 1)
})

test('unlabelled disagreements are marked unknown', () => {
  const view = compareView({ rows: [{ index: 0, sampleId: '9', label: -1, digitA: 1, confidenceA: 0.5,
    digitB: 2, confidenceB: 0.5, agree: false }] })
  assert.equal(disagreementRows(view)[0].who, 'unknown')
})

test('summary line and verdict tell the story in one sentence', () => {
  const line = summaryLine(compareView())
  assert.ok(line.includes('共 4 张样本'))
  assert.ok(line.includes('一致 2 张（50.0%）'))
  assert.ok(line.includes('A 正确率 50.0%，B 正确率 75.0%'))
  assert.ok(line.includes('B 独占对 1 张'))

  assert.equal(verdict(compareView()).winner, 'B')
  assert.equal(verdict(compareView()).text, 'B 高 25.0 个百分点')
  const tie = compareView({ summary: { ...compareView().summary, accuracyB: 0.5 } })
  assert.equal(verdict(tie).winner, 'tie')
  assert.equal(verdict({ summary: { samples: 3 } }), null)
})

test('missing training metrics degrade to "only agreement" text', () => {
  const view = compareView({ summary: { samples: 3, labelled: 0, agreement: 3, agreementRate: 1,
    accuracyA: null, accuracyB: null, bothRight: 0, onlyA: 0, onlyB: 0, bothWrong: 0,
    meanConfidenceA: null, meanConfidenceB: null } })
  assert.ok(summaryLine(view).includes('样本缺少标签'))
  assert.equal(verdict(view), null)
})
