import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_DIGITS_OPTIONS, buildMultiForm, buildMultiQuery, buildMultiSampleForm, multiSummary, resolveMultiSampleLabel, validateMultiLabel } from '../src/recognition/multi.js'

test('multi-digit options cover 1-4', () => {
  assert.deepEqual(MAX_DIGITS_OPTIONS, [1, 2, 3, 4])
})

test('form carries the image and the source (limit travels as a query param)', () => {
  const image = new File([new Uint8Array([0x89, 0x50])], 'drawing.png', { type: 'image/png' })
  const form = buildMultiForm(image, 3)
  assert.equal(form.get('source'), 'WEB')
  assert.equal(form.get('image').name, 'drawing.png')
  assert.equal(form.get('maxDigits'), null)
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
  assert.equal(summary.recognitionId, '')
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

test('multi sample label must be 1-4 digits typed by the user', () => {
  assert.equal(validateMultiLabel('351'), '')
  assert.equal(validateMultiLabel(' 7 '), '')
  assert.match(validateMultiLabel(''), /请填写/)
  assert.match(validateMultiLabel('35a'), /1–4 位数字/)
  assert.match(validateMultiLabel('12345'), /1–4 位数字/)
})

test('multi sample form carries labelText instead of a single label', () => {
  const image = new File([new Uint8Array([0x89, 0x50])], 'drawing.png', { type: 'image/png' })
  const form = buildMultiSampleForm({ image, labelText: '351', consent: true,
    result: { text: '351', recognitionId: '280', modelVersion: 'w4-task-8-a1' } })
  assert.equal(form.get('labelText'), '351')
  assert.equal(form.get('label'), null)
  assert.equal(form.get('consent'), 'true')
  assert.equal(form.get('predictedText'), '351')
  assert.equal(form.get('recognitionId'), '280')
})

test('verdict confirm reuses the predicted string, correct mode uses what the user typed', () => {
  assert.equal(resolveMultiSampleLabel('confirm', '351', ''), '351')
  assert.equal(resolveMultiSampleLabel('confirm', '351', '999'), '351')
  assert.equal(resolveMultiSampleLabel('correct', '351', ' 357 '), '357')
  assert.equal(resolveMultiSampleLabel('correct', '351', ''), '')
  assert.equal(validateMultiLabel(resolveMultiSampleLabel('correct', '351', '357')), '')
})

test('query carries the digit limit and asks for enhancement only for images', () => {
  assert.equal(buildMultiQuery(3, false), '?maxDigits=3')
  assert.equal(buildMultiQuery(4, true), '?maxDigits=4&enhance=true')
  assert.equal(buildMultiQuery(1, undefined), '?maxDigits=1')
})
