import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SSE_STATUS, isActiveStatus, liveLabel, pollIntervalMs, shouldPoll } from '../src/training/live.js'

test('polling stops only when the stream is truly live', () => {
  assert.equal(shouldPoll(SSE_STATUS.LIVE), false)
  // 连接中/重连中/不可用都必须继续轮询兜底，否则界面就不刷新了
  assert.equal(shouldPoll(SSE_STATUS.CONNECTING), true)
  assert.equal(shouldPoll(SSE_STATUS.RECONNECTING), true)
  assert.equal(shouldPoll(SSE_STATUS.UNAVAILABLE), true)
  assert.equal(shouldPoll(SSE_STATUS.CLOSED), true)
  assert.equal(shouldPoll(undefined), true)
})

test('poll interval is zero while live and the fallback otherwise', () => {
  assert.equal(pollIntervalMs(SSE_STATUS.LIVE), 0)
  assert.equal(pollIntervalMs(SSE_STATUS.UNAVAILABLE), 4000)
  assert.equal(pollIntervalMs(SSE_STATUS.UNAVAILABLE, 2000), 2000)
})

test('labels explain what is happening', () => {
  assert.equal(liveLabel(SSE_STATUS.LIVE), '实时推送已连接')
  assert.ok(liveLabel(SSE_STATUS.UNAVAILABLE).includes('轮询'))
  assert.equal(liveLabel(''), '')
  assert.equal(liveLabel(undefined), '')
})

test('active statuses are queue and running only', () => {
  assert.equal(isActiveStatus('QUEUED'), true)
  assert.equal(isActiveStatus('RUNNING'), true)
  assert.equal(isActiveStatus('SUCCEEDED'), false)
  assert.equal(isActiveStatus('FAILED'), false)
  assert.equal(isActiveStatus('CANCELED'), false)
  assert.equal(isActiveStatus(null), false)
})
