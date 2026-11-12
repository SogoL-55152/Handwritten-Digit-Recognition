import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FEEDBACK_LABELS, buildFeedbackForm, feedbackMessage, validateFeedback } from '../src/recognition/feedback.js'

const RESULT = { digit: 7, confidence: 0.976, modelVersion: 'w2-canvas-photo-3epoch', recognitionId: '42' }

function fileOf(type = 'image/png', name = 'drawing.png') {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type })
}

test('labels cover 0-9 in order', () => {
  assert.deepEqual(FEEDBACK_LABELS, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('validation requires a digit and consent', () => {
  assert.deepEqual(validateFeedback({ label: 7, consent: true }), {})
  for (const label of [null, -1, 10, 1.5, '7']) {
    assert.ok(validateFeedback({ label, consent: true }).label, String(label))
  }
  assert.ok(validateFeedback({ label: 7, consent: false }).consent)
})

test('form carries label, consent and the model context of that submission', () => {
  const form = buildFeedbackForm({ image: fileOf(), label: 7, consent: true, result: RESULT })
  assert.equal(form.get('label'), '7')
  assert.equal(form.get('consent'), 'true')
  assert.equal(form.get('source'), 'WEB')
  assert.equal(form.get('predictedDigit'), '7')
  assert.equal(form.get('confidence'), '0.976')
  assert.equal(form.get('modelVersion'), 'w2-canvas-photo-3epoch')
  assert.equal(form.get('recognitionId'), '42')
  assert.equal(form.get('image').type, 'image/png')
})

test('form works without a recognition result (rejected input)', () => {
  const form = buildFeedbackForm({ image: fileOf('image/jpeg', 'photo.jpg'), label: 9, consent: true, result: null })
  assert.equal(form.get('label'), '9')
  assert.equal(form.get('predictedDigit'), null)
  assert.equal(form.get('confidence'), null)
  assert.equal(form.get('image').name, 'photo.jpg')
})

test('messages distinguish first submission from duplicate', () => {
  assert.match(feedbackMessage({ duplicate: false, contributedTotal: 3 }), /感谢/)
  assert.match(feedbackMessage({ duplicate: false, contributedTotal: 3 }), /3 条/)
  assert.match(feedbackMessage({ duplicate: true, contributedTotal: 3 }), /已经采集过/)
  assert.match(feedbackMessage(null), /0 条/)
})
