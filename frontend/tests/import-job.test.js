import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canCancelJob, isTerminalJob, jobPercent, jobStatusText } from '../src/datasets/job.js'

function job(overrides = {}) {
  return { id: '1', status: 'RUNNING', progressTotal: 200, progressDone: 50,
    imported: 40, duplicates: 5, failed: 5, errorMessage: null, cancelRequested: false, ...overrides }
}

test('terminal statuses are recognised', () => {
  assert.equal(isTerminalJob('SUCCEEDED'), true)
  assert.equal(isTerminalJob('FAILED'), true)
  assert.equal(isTerminalJob('CANCELED'), true)
  assert.equal(isTerminalJob('RUNNING'), false)
  assert.equal(isTerminalJob('QUEUED'), false)
  assert.equal(isTerminalJob(undefined), false)
})

test('percent is null while scanning and clamps out-of-range progress', () => {
  assert.equal(jobPercent(job({ progressTotal: 0, progressDone: 0 })), null)
  assert.equal(jobPercent(null), null)
  assert.equal(jobPercent(job({ progressTotal: 200, progressDone: 0 })), 0)
  assert.equal(jobPercent(job({ progressTotal: 200, progressDone: 50 })), 25)
  assert.equal(jobPercent(job({ progressTotal: 3, progressDone: 1 })), 33.3)
  assert.equal(jobPercent(job({ progressTotal: 200, progressDone: 500 })), 100)
  assert.equal(jobPercent(job({ progressTotal: 200, progressDone: -5 })), 0)
})

test('status text tells scanning apart from importing', () => {
  assert.equal(jobStatusText(job({ status: 'QUEUED' })), '已排队，等待开始…')
  assert.equal(jobStatusText(job({ status: 'RUNNING', progressTotal: 0 })), '正在扫描目录…')
  assert.ok(jobStatusText(job()).includes('50 / 200'))
  assert.ok(jobStatusText(job({ status: 'SUCCEEDED' })).includes('成功 40'))
  assert.ok(jobStatusText(job({ status: 'CANCELED' })).includes('已导入 40'))
  assert.ok(jobStatusText(job({ status: 'FAILED', errorMessage: '没有识别到图片' })).includes('没有识别到图片'))
  assert.equal(jobStatusText(null), '')
})

test('cancel is offered only while the job is still running', () => {
  assert.equal(canCancelJob(job()), true)
  assert.equal(canCancelJob(job({ status: 'QUEUED' })), true)
  assert.equal(canCancelJob(job({ cancelRequested: true })), false)
  assert.equal(canCancelJob(job({ status: 'SUCCEEDED' })), false)
  assert.equal(canCancelJob(null), false)
})
