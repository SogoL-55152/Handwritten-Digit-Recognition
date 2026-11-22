import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPayload, labelRows, nextVersion, splitHints, splitRows } from '../src/datasets/format.js'

test('next version skips taken names', () => {
  assert.equal(nextVersion([]), 'v1')
  assert.equal(nextVersion([{ version: 'v1' }]), 'v2')
  assert.equal(nextVersion([{ version: 'v1' }, { version: 'v3' }]), 'v2')
})

test('build payload clamps ratios and keeps valid fields only', () => {
  assert.deepEqual(buildPayload({ version: 'v1', splitRule: 'WRITER', valPercent: 120, testPercent: -5 }),
    { version: 'v1', splitRule: 'WRITER', valPercent: 50, testPercent: 0 })
  assert.deepEqual(buildPayload({ version: 'v2', splitRule: 'RANDOM', valPercent: '10', testPercent: '20', label: 7 }),
    { version: 'v2', splitRule: 'RANDOM', valPercent: 10, testPercent: 20, label: 7 })
  assert.equal(buildPayload({ version: 'v1', label: '' }).label, undefined)
})

test('label rows carry counts and percentages', () => {
  const rows = labelRows({ byLabel: [{ key: '3', count: 3 }, { key: '7', count: 1 }] })
  assert.deepEqual(rows.map((row) => row.label), ['3', '7'])
  assert.equal(rows[0].percent, 75)
  assert.equal(rows[1].count, 1)
  assert.deepEqual(labelRows({}), [])
})

test('split rows keep a stable order and fill missing splits', () => {
  const rows = splitRows({ bySplit: [{ key: 'TEST', count: 4 }] })
  assert.deepEqual(rows.map((row) => row.key), ['TRAIN', 'VAL', 'TEST'])
  assert.deepEqual(rows.map((row) => row.count), [0, 0, 4])
})

test('split hints warn about empty splits, writer overlap and too few writers', () => {
  const hints = splitHints({
    bySplit: [{ key: 'TRAIN', count: 10 }, { key: 'VAL', count: 0 }, { key: 'TEST', count: 2 }],
    writerLeak: 1,
    version: { writerCount: 1 }
  })
  assert.ok(hints.some((hint) => hint.includes('验证集为空')))
  assert.ok(hints.some((hint) => hint.includes('1 位书写者同时出现在多个划分')))
  const healthy = splitHints({ bySplit: [{ key: 'TRAIN', count: 20 }, { key: 'VAL', count: 5 }, { key: 'TEST', count: 5 }], writerLeak: 0, version: { writerCount: 5 } })
  assert.deepEqual(healthy, [])
})
