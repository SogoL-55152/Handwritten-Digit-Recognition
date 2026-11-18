import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batchOf, groupByFolder, importSummary, isImage, labelOfPath, progressText } from '../src/datasets/import.js'

function file(name, path, type = 'image/png') {
  return { name, type, webkitRelativePath: path }
}

test('label comes from the first folder segment', () => {
  assert.equal(labelOfPath('3/001.png'), 3)
  assert.equal(labelOfPath('0/a/b.png'), 0)
  assert.equal(labelOfPath('10/x.png'), null)
  assert.equal(labelOfPath('abc/x.png'), null)
  assert.equal(labelOfPath('x.png'), null)
  assert.equal(labelOfPath(''), null)
  assert.equal(labelOfPath(null), null)
})

test('only image files are considered', () => {
  assert.equal(isImage(file('a.png', '1/a.png')), true)
  assert.equal(isImage({ name: 'a.txt', type: 'text/plain', webkitRelativePath: '1/a.txt' }), false)
  assert.equal(isImage({ name: 'a', type: 'image/jpeg' }), true)
})

test('groupByFolder splits by digit and counts ignored files', () => {
  const files = [
    file('1.png', '3/1.png'),
    file('2.png', '3/2.png'),
    file('3.png', '9/3.png'),
    file('readme.txt', '3/readme.txt', 'text/plain'),
    file('loose.png', 'loose.png')
  ]
  const { groups, ignored, noLabel, emptyLabels } = groupByFolder(files)
  assert.equal(groups[3].length, 2)
  assert.equal(groups[9].length, 1)
  assert.equal(ignored, 1)
  assert.equal(noLabel, 1)
  assert.deepEqual(emptyLabels, [0, 1, 2, 4, 5, 6, 7, 8])
})

test('batches respect the size limit', () => {
  const list = Array.from({ length: 45 }, (_, index) => index)
  const batches = batchOf(list, 20)
  assert.deepEqual(batches.map((batch) => batch.length), [20, 20, 5])
  assert.deepEqual(batchOf([], 20), [])
  assert.equal(batchOf(list, 0).length, 3)   // size 传 0 回退到默认 20
})

test('summary adds counts and suggests the next step', () => {
  const summary = importSummary([
    { imported: 10, duplicates: 2, failed: 1, total: 13 },
    { imported: 5, duplicates: 0, failed: 0, total: 5 }
  ])
  assert.equal(summary.imported, 15)
  assert.equal(summary.duplicates, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.total, 18)
  assert.match(summary.hint, /生成版本/)
  assert.match(importSummary([{ imported: 0, duplicates: 3, failed: 0, total: 3 }]).hint, /重复/)
})

test('progress text shows label and batch position', () => {
  assert.equal(progressText({ label: 3, labelIndex: 2, labelCount: 10, batchIndex: 1, batchCount: 4 }),
    '标签 3（2/10）· 第 1/4 批')
  assert.match(progressText({ labelCount: 0 }), /没有可导入/)
})
