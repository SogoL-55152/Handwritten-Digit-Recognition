import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originOf, provenanceDetail } from '../src/models/provenance.js'

test('origin labels cover built-in, trained, fine-tuned and imported', () => {
  assert.equal(originOf({ origin: 'BUILTIN' }).label, '内置基线')
  assert.equal(originOf({ origin: 'TRAINED' }).label, '训练产出')
  assert.equal(originOf({ origin: 'FINE_TUNED' }).label, '微调')
  assert.equal(originOf({ origin: 'IMPORTED' }).label, '手工导入')
  assert.equal(originOf({}).label, '手工导入')
})

test('trained models show task id, start point and time', () => {
  const detail = provenanceDetail({
    origin: 'FINE_TUNED', taskId: 8, initFrom: 'w2-canvas-photo-3epoch',
    trainedAt: '2026-11-12T05:40:00Z'
  })
  assert.match(detail, /任务 #8/)
  assert.match(detail, /起点 w2-canvas-photo-3epoch/)
  assert.match(detail, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
})

test('trained models without a start point are not labelled as fine-tuned', () => {
  const detail = provenanceDetail({ origin: 'TRAINED', taskId: 3, trainedAt: null })
  assert.equal(detail, '任务 #3')
})

test('built-in and imported models fall back to a one-line hint', () => {
  assert.match(provenanceDetail({ origin: 'BUILTIN' }), /初始模型/)
  assert.match(provenanceDetail({ origin: 'IMPORTED' }), /手工登记/)
  assert.ok(provenanceDetail(null).length > 0)
})
