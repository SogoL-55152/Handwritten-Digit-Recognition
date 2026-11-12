const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const vm = require('node:vm')
const { createRequestId, validWorkspace, validateResult } = require('../utils/recognition')

const NATIVE_ID = '00010203-0405-4607-8809-0a0b0c0d0e0f'
const SERVER_ID = 'f81d4fae-7dec-4a0d-a765-00a0c91e6bf6'
const response = () => ({ randomValues: Uint8Array.from({ length: 16 }, (_, i) => i).buffer })
const flush = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  let aborted = 0
  promise.abort = () => { aborted++ }
  return { promise, resolve, reject, get aborted() { return aborted } }
}
function captureNative() {
  let callbacks
  global.wx = { getRandomValues(options) { callbacks = options } }
  return () => callbacks
}
afterEach(() => { delete global.wx })

test('native callback creates UUIDv4 without options, preserving the source bytes', async () => {
  const result = response()
  const original = new Uint8Array(result.randomValues).slice()
  global.wx = {
    getRandomValues(options) {
      assert.equal(this, global.wx)
      assert.equal(options.length, 16)
      options.success(result)
    }
  }
  const pending = createRequestId()
  assert.equal(typeof pending.abort, 'function')
  assert.equal(await pending, NATIVE_ID)
  assert.deepEqual(new Uint8Array(result.randomValues), original)
  pending.abort()
  assert.equal(await pending, NATIVE_ID)
})

for (const [label, makeValue] of [
  ['cross-realm ArrayBuffer', () => vm.runInNewContext('Uint8Array.from({ length: 16 }, (_, i) => i).buffer')],
  ['offset Uint8Array', () => Uint8Array.from({ length: 40 }, (_, i) => i - 8).subarray(8, 24)],
  ['offset Uint32Array', () => new Uint32Array(Uint8Array.from({ length: 40 }, (_, i) => i - 8).buffer, 8, 4)],
  ['offset DataView', () => new DataView(Uint8Array.from({ length: 40 }, (_, i) => i - 8).buffer, 8, 16)],
  ['cross-realm offset typed array', () => vm.runInNewContext('new Uint16Array(Uint8Array.from({ length: 40 }, (_, i) => i - 8).buffer, 8, 8)')],
  ['cross-realm offset DataView', () => vm.runInNewContext('new DataView(Uint8Array.from({ length: 40 }, (_, i) => i - 8).buffer, 8, 16)')]
]) {
  test(`native accepts real ${label} and uses exactly its 16 bytes`, async () => {
    const value = makeValue()
    const buffer = ArrayBuffer.isView(value) ? value.buffer : value
    const before = new Uint8Array(buffer).slice()
    const sources = []
    global.wx = { getRandomValues: ({ success }) => success({ randomValues: value }) }
    const id = await createRequestId({ fallback: () => assert.fail('Native must win'), onGenerator: (source) => sources.push(source) })
    assert.equal(id, NATIVE_ID)
    assert.deepEqual(new Uint8Array(buffer), before)
    assert.deepEqual(sources, ['native'])
  })
}

for (const [label, setup, reason] of [
  ['missing wx', () => { delete global.wx }, 'unavailable'],
  ['missing API', () => { global.wx = {} }, 'unavailable'],
  ['non-function API', () => { global.wx = { getRandomValues: true } }, 'unavailable'],
  ['throwing API', () => { global.wx = { getRandomValues() { throw new Error('synthetic-sensitive-detail') } } }, 'threw'],
  ['fail callback', () => { global.wx = { getRandomValues: ({ fail }) => fail({ errMsg: 'synthetic-sensitive-detail' }) } }, 'failed'],
  ['Promise rejection', () => { global.wx = { getRandomValues: () => Promise.reject(new Error('synthetic-sensitive-detail')) } }, 'failed']
]) {
  test(`${label} uses one server fallback and canonicalizes uppercase UUID`, async () => {
    setup()
    let calls = 0
    const sources = []
    assert.equal(await createRequestId({
      fallback: () => { calls++; return Promise.resolve({ requestId: SERVER_ID.toUpperCase() }) },
      onGenerator: (source) => sources.push(source)
    }), SERVER_ID)
    assert.equal(calls, 1)
    assert.deepEqual(sources, ['server'])
  })
  test(`${label} without fallback reports only sanitized, actionable diagnostics`, async (t) => {
    setup()
    const log = t.mock.method(console, 'log', () => {})
    const warn = t.mock.method(console, 'warn', () => {})
    const errorLog = t.mock.method(console, 'error', () => {})
    const sources = []
    await assert.rejects(createRequestId({ onGenerator: (source) => sources.push(source) }), (error) => {
      assert.equal(error.generator, 'native')
      assert.equal(error.reason, reason)
      assert.match(error.message, /请重试/)
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-sensitive-detail|基础库|开发者/)
      return true
    })
    assert.deepEqual(sources, [])
    assert.equal(log.mock.callCount() + warn.mock.callCount() + errorLog.mock.callCount(), 0)
  })
}

for (const [label, makeResult] of [
  ['missing response', () => undefined],
  ['missing bytes', () => ({})],
  ['null bytes', () => ({ randomValues: null })],
  ['15-byte buffer', () => ({ randomValues: new ArrayBuffer(15) })],
  ['17-byte buffer', () => ({ randomValues: new ArrayBuffer(17) })],
  ['short offset view', () => ({ randomValues: new Uint8Array(new ArrayBuffer(32), 8, 15) })],
  ['long offset view', () => ({ randomValues: new DataView(new ArrayBuffer(32), 8, 17) })],
  ['ordinary byte array', () => ({ randomValues: Array(16).fill(0) })],
  ['array-like object', () => ({ randomValues: { length: 16, byteLength: 16 } })],
  ['spoofed ArrayBuffer tag', () => ({ randomValues: { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 16 } })],
  ['spoofed ArrayBuffer prototype', () => ({ randomValues: Object.create(ArrayBuffer.prototype) })],
  ['detached buffer', () => {
    const buffer = new ArrayBuffer(16)
    structuredClone(buffer, { transfer: [buffer] })
    return { randomValues: buffer }
  }]
]) {
  test(`native rejects ${label}, then uses exactly one fallback`, async () => {
    let calls = 0
    global.wx = { getRandomValues: ({ success }) => success(makeResult()) }
    assert.equal(await createRequestId({ fallback: () => { calls++; return Promise.resolve({ requestId: SERVER_ID }) } }), SERVER_ID)
    assert.equal(calls, 1)
    await assert.rejects(createRequestId(), (error) => error.reason === 'malformed' && /请重试/.test(error.message))
  })
}

test('Promise-only native success needs no callback or fallback', async () => {
  global.wx = { getRandomValues: () => Promise.resolve(response()) }
  assert.equal(await createRequestId({ fallback: () => assert.fail('No fallback') }), NATIVE_ID)
})

test('callback success wins over duplicate, malformed, failure and rejected Promise responses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let callbacks
  const native = deferred(), sources = []
  global.wx = { getRandomValues(options) { callbacks = options; options.success(response()); return native.promise } }
  const pending = createRequestId({ fallback: () => assert.fail('No fallback after native success'), onGenerator: (source) => sources.push(source) })
  callbacks.success({})
  callbacks.fail({ errMsg: 'late' })
  native.reject(new Error('late'))
  t.mock.timers.tick(3000)
  assert.equal(await pending, NATIVE_ID)
  await flush()
  assert.deepEqual(sources, ['native'])
})

test('Promise success wins over later callback responses', async () => {
  let callbacks
  const sources = []
  global.wx = { getRandomValues(options) { callbacks = options; return Promise.resolve(response()) } }
  const pending = createRequestId({ fallback: () => assert.fail('No fallback'), onGenerator: (source) => sources.push(source) })
  assert.equal(await pending, NATIVE_ID)
  callbacks.fail({})
  callbacks.success(response())
  assert.deepEqual(sources, ['native'])
})

test('native failure closes native path before in-progress fallback, including late Promise success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const native = deferred(), server = deferred(), sources = []
  let callbacks, calls = 0, settled = false
  global.wx = { getRandomValues(options) { callbacks = options; return native.promise } }
  const pending = createRequestId({ fallback: () => { calls++; return server.promise }, onGenerator: (source) => sources.push(source) })
  pending.then(() => { settled = true })
  callbacks.fail({})
  callbacks.success(response())
  callbacks.fail({})
  native.resolve(response())
  t.mock.timers.tick(9000)
  await flush()
  assert.equal(calls, 1)
  assert.equal(settled, false)
  assert.deepEqual(sources, [])
  server.resolve({ requestId: SERVER_ID })
  assert.equal(await pending, SERVER_ID)
  callbacks.success(response())
  assert.deepEqual(sources, ['server'])
})

test('native timeout waits exactly 3 seconds then uses one fallback, ignoring late callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const callbacks = captureNative()
  let calls = 0
  const pending = createRequestId({ fallback: () => { calls++; return Promise.resolve({ requestId: SERVER_ID }) } })
  t.mock.timers.tick(2999)
  assert.equal(calls, 0)
  t.mock.timers.tick(1)
  callbacks().success(response())
  callbacks().fail({})
  t.mock.timers.tick(3000)
  assert.equal(await pending, SERVER_ID)
  assert.equal(calls, 1)
})

test('native timeout without fallback settles with retry guidance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const callbacks = captureNative()
  const pending = createRequestId()
  const rejected = assert.rejects(pending, (error) => error.reason === 'timeout' && /超时.*请重试/.test(error.message))
  t.mock.timers.tick(3000)
  callbacks().success(response())
  await rejected
})

for (const value of [
  undefined, null, {}, SERVER_ID, { requestId: 123 }, { requestId: '' },
  { requestId: SERVER_ID.replace('-4a0d-', '-1a0d-') },
  { requestId: SERVER_ID.replace('-a765-', '-7765-') },
  { requestId: SERVER_ID.replaceAll('-', '') },
  { requestId: ` ${SERVER_ID}` }, { requestId: `${SERVER_ID}\n` }, { requestId: `${SERVER_ID}suffix` }
]) {
  test(`server fallback rejects noncanonical/non-v4 payload ${JSON.stringify(value)}`, async () => {
    const sources = []
    await assert.rejects(createRequestId({ fallback: () => Promise.resolve(value), onGenerator: (source) => sources.push(source) }), /服务返回的请求标识无效，请重试/)
    assert.deepEqual(sources, [])
  })
}

for (const code of [401, 429, 503]) {
  test(`fallback preserves HTTP ${code} error identity and metadata without retry`, async () => {
    const error = Object.assign(new Error(code === 401 ? '登录已失效，请重新登录' : '请稍后重试'), { code, status: code, retryAfterSeconds: 17 })
    let calls = 0
    const pending = createRequestId({ fallback: () => { calls++; return Promise.reject(error) } })
    await assert.rejects(pending, (actual) => actual === error)
    assert.equal(calls, 1)
  })
}

test('fallback synchronous error is preserved without retry', async () => {
  const error = new Error('服务暂不可用，请重试')
  let calls = 0
  await assert.rejects(createRequestId({ fallback: () => { calls++; throw error } }), (actual) => actual === error)
  assert.equal(calls, 1)
})

test('abort settles silent native waiting immediately and prevents fallback, callbacks and diagnostics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const callbacks = captureNative(), sources = []
  const pending = createRequestId({ fallback: () => assert.fail('No fallback after abort'), onGenerator: (source) => sources.push(source) })
  const rejected = assert.rejects(pending, (error) => error.aborted === true)
  pending.abort()
  pending.abort()
  callbacks().success(response())
  callbacks().fail({})
  t.mock.timers.tick(3000)
  await rejected
  assert.deepEqual(sources, [])
})

for (const late of ['success', 'failure']) {
  test(`abort cancels in-progress server once and ignores late ${late}`, async () => {
    const server = deferred(), sources = []
    const pending = createRequestId({ fallback: () => server.promise, onGenerator: (source) => sources.push(source) })
    const rejected = assert.rejects(pending, (error) => error.aborted === true)
    pending.abort()
    pending.abort()
    assert.equal(server.aborted, 1)
    if (late === 'success') server.resolve({ requestId: SERVER_ID })
    else server.reject(Object.assign(new Error('late'), { code: 401 }))
    await rejected
    await flush()
    assert.deepEqual(sources, [])
  })
}

test('throwing underlying abort cannot stop cancellation or leak its error', async () => {
  const server = deferred()
  server.promise.abort = () => { throw new Error('synthetic-sensitive-detail') }
  const pending = createRequestId({ fallback: () => server.promise })
  const rejected = assert.rejects(pending, (error) => error.aborted === true)
  assert.doesNotThrow(() => pending.abort())
  await rejected
  server.resolve({ requestId: SERVER_ID })
})

test('abort after successful server completion does not abort a completed request', async () => {
  const server = deferred()
  const pending = createRequestId({ fallback: () => server.promise })
  server.resolve({ requestId: SERVER_ID })
  assert.equal(await pending, SERVER_ID)
  pending.abort()
  assert.equal(server.aborted, 0)
})

test('already stale call does not invoke native API, fallback or diagnostics', async () => {
  const sources = []
  global.wx = { getRandomValues: () => assert.fail('No native call') }
  await assert.rejects(createRequestId({
    isCurrent: () => false, fallback: () => assert.fail('No fallback'), onGenerator: (source) => sources.push(source)
  }), (error) => error.stale === true)
  assert.deepEqual(sources, [])
})

for (const event of ['success', 'failure', 'timeout']) {
  test(`stale native ${event} settles stale without starting fallback or diagnostics`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let current = true
    const callbacks = captureNative(), sources = []
    const pending = createRequestId({
      isCurrent: () => current, fallback: () => assert.fail('No stale fallback'), onGenerator: (source) => sources.push(source)
    })
    const rejected = assert.rejects(pending, (error) => error.stale === true)
    current = false
    if (event === 'success') callbacks().success(response())
    if (event === 'failure') callbacks().fail({})
    if (event === 'timeout') t.mock.timers.tick(3000)
    await rejected
    assert.deepEqual(sources, [])
  })
}

for (const event of ['success', 'failure']) {
  test(`in-progress fallback ${event} is discarded after becoming stale`, async () => {
    let current = true
    const server = deferred(), sources = []
    const pending = createRequestId({ isCurrent: () => current, fallback: () => server.promise, onGenerator: (source) => sources.push(source) })
    const rejected = assert.rejects(pending, (error) => error.stale === true)
    current = false
    if (event === 'success') server.resolve({ requestId: SERVER_ID })
    else server.reject(Object.assign(new Error('late unauthorized'), { code: 401 }))
    await rejected
    assert.deepEqual(sources, [])
  })
}

test('diagnostic callback exceptions cannot trigger fallback or replace success', async () => {
  global.wx = { getRandomValues: ({ success }) => success(response()) }
  assert.equal(await createRequestId({ fallback: () => assert.fail('No fallback'), onGenerator: () => { throw new Error('diagnostic failure') } }), NATIVE_ID)
  delete global.wx
  assert.equal(await createRequestId({ fallback: () => Promise.resolve({ requestId: SERVER_ID }), onGenerator: () => { throw new Error('diagnostic failure') } }), SERVER_ID)
})

test('request IDs never depend on Math.random or timestamps', async (t) => {
  t.mock.method(Math, 'random', () => assert.fail('No weak random source'))
  t.mock.method(Date, 'now', () => assert.fail('No timestamp source'))
  global.wx = { getRandomValues: ({ success }) => success(response()) }
  assert.equal(await createRequestId(), NATIVE_ID)
  delete global.wx
  assert.equal(await createRequestId({ fallback: () => Promise.resolve({ requestId: SERVER_ID }) }), SERVER_ID)
  await assert.rejects(createRequestId(), /请重试/)
})

test('workspace and recognition result validation retain their contract and exports', () => {
  assert.deepEqual(Object.keys(require('../utils/recognition')).sort(), ['createRequestId', 'multiQuery', 'validWorkspace', 'validateMultiResult', 'validateResult'])
  const workspace = { id: '9007199254741001', name: '', role: 'OWNER', status: 'ACTIVE' }
  assert.equal(validWorkspace(workspace), true)
  assert.equal(validWorkspace({ ...workspace, role: 'VIEWER' }), false)
  assert.equal(validWorkspace({ ...workspace, status: 'ARCHIVED' }), false)
  const result = {
    recognitionId: '9007199254741999', requestId: NATIVE_ID, digit: 7, confidence: 0.9876,
    modelId: '9007199254741011', modelVersion: 'w2-canvas-photo-3epoch', preprocessVersion: 'adaptive-mnist-v2',
    source: 'MINIPROGRAM', processingMs: 31, createdAt: '2026-11-02T01:02:03Z'
  }
  assert.deepEqual(validateResult(result, NATIVE_ID), { ...result, confidencePercent: '98.76' })
  assert.throws(() => validateResult(result, SERVER_ID), /合同不一致/)
  assert.throws(() => validateResult({ ...result, digit: 10 }, NATIVE_ID), /合同不一致/)
  // W3：模型版本由服务端决定，客户端只拒绝形状非法的值。
  assert.throws(() => validateResult({ ...result, modelVersion: '' }, NATIVE_ID), /合同不一致/)
  assert.ok(validateResult({ ...result, modelVersion: 'another-registered-model' }, NATIVE_ID))
})
