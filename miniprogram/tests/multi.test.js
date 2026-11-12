import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { multiQuery, validateMultiResult } = require('../utils/recognition')

const REQUEST_ID = '00000000-0000-4000-8000-000000000601'

function result(overrides = {}) {
  return {
    recognitionId: '280', requestId: REQUEST_ID, text: '351', accepted: false,
    digits: [
      { digit: 3, confidence: 1, margin: 1, left: 10, right: 90 },
      { digit: 5, confidence: 0.95, margin: 0.9, left: 120, right: 200 },
      { digit: 1, confidence: 0.63, margin: 0.2, left: 230, right: 260 }
    ],
    modelId: 'mnist-cnn-w1', modelVersion: 'w4-task-8-a1', preprocessVersion: 'adaptive-mnist-v2',
    source: 'MINIPROGRAM', processingMs: 90, createdAt: '2026-11-12T05:00:00Z',
    ...overrides
  }
}

test('multi query carries the digit limit and enhancement flag', () => {
  assert.equal(multiQuery(3, false), '?maxDigits=3')
  assert.equal(multiQuery(4, true), '?maxDigits=4&enhance=true')
})

test('multi result keeps the string, per-digit confidence and low flags', () => {
  const view = validateMultiResult(result(), REQUEST_ID)
  assert.equal(view.text, '351')
  assert.equal(view.digits.length, 3)
  assert.equal(view.digits[2].confidencePercent, '63.0')
  assert.equal(view.digits[2].low, true)
  assert.equal(view.lowCount, 1)
})

test('multi result rejects responses that disagree with the request', () => {
  assert.throws(() => validateMultiResult(result(), '00000000-0000-4000-8000-000000000999'), /不一致/)
  assert.throws(() => validateMultiResult(result({ text: '3a1' }), REQUEST_ID), /不一致/)
  assert.throws(() => validateMultiResult(result({ text: '351', digits: [] }), REQUEST_ID), /不一致/)
  assert.throws(() => validateMultiResult(result({ accepted: 'yes' }), REQUEST_ID), /不一致/)
  assert.throws(() => validateMultiResult(result({ source: 'WEB' }), REQUEST_ID), /不一致/)
  assert.throws(() => validateMultiResult(result({ digits: [{ digit: 12, confidence: 1 }] }), REQUEST_ID), /不一致/)
})
