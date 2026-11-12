import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_DIGITS_OPTIONS, buildMultiForm, multiSummary } from '../src/recognition/multi.js'

test('multi-digit options cover 1-4', () => {
  assert.deepEqual(MAX_DIGITS_OPTIONS, [1, 2, 3, 4])
})

test('form carries the image and the digit limit', () => {
  const image = new File([new Uint8Array([0x89, 0x50])], 'drawing.png', { type: 'image/png' })
  const form = buildMultiForm(image, 3)
  assert.equal(form.get('maxDigits'), '3')
  assert.equal(form.get('image').name, 'drawing.png')
})

test('summary exposes text, per-digit confidence and low-digit flags', () => {
  const summary = multiSummary({
    text: '357',
    accepted: false,
    digits: [
      { digit: 3, confidence: 0.99 },
      { digit: 5, confidence: 0.62 },
      { digit: 7, confidence: 0.97 }
    ]
  })
  assert.equal(summary.text, '357')
  assert.equal(summary.digits.length, 3)
  assert.equal(summary.digits[1].confidence, '62.0%')
  assert.equal(summary.digits[1].low, true)
  assert.equal(summary.digits[0].low, false)
  assert.match(summary.hint, /1 位/)
})

test('summary rejects malformed responses instead of guessing', () => {
  assert.equal(multiSummary(null).valid, false)
  assert.equal(multiSummary({ text: '3a7', digits: [] }).valid, false)
  assert.equal(multiSummary({ text: '357', digits: [1, 2] }).valid, false)
})

test('summary reports an accepted string', () => {
  const summary = multiSummary({
    text: '42', accepted: true,
    digits: [{ digit: 4, confidence: 0.98 }, { digit: 2, confidence: 0.96 }]
  })
  assert.equal(summary.accepted, true)
  assert.match(summary.hint, /阈值以上/)
})
