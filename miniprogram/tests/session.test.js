const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const {
  STORAGE_KEY, readSession, clearSession, saveSession, verifySession,
  snapshot, isSessionCurrent, isWorkspaceCurrent, selectWorkspace
} = require('../utils/session')
const { request, upload, TIMEOUT_MS } = require('../utils/request')
const { validateResult } = require('../utils/recognition')
const { createCanvasStub } = require('./helpers/canvas-stub')

function loadDefinition(path, kind = 'Page') {
  let definition
  global[kind] = (value) => { definition = value }
  delete require.cache[require.resolve(path)]
  require(path)
  delete global[kind]
  return definition
}
const loginDefinition = loadDefinition('../pages/login/login')
const indexDefinition = loadDefinition('../pages/index/index')
const appDefinition = loadDefinition('../app', 'App')
const boardDefinition = loadDefinition('../components/drawing-board/drawing-board', 'Component')
const user = { id: '9007199254740993', username: 'member', nickname: '普通成员', platformRole: 'USER' }
const identity = { user, defaultWorkspaceId: '9007199254741001' }
const spaces = [
  { id: identity.defaultWorkspaceId, name: '成员空间', role: 'MEMBER', status: 'ACTIVE', defaultModelId: '9007199254741011' },
  { id: '9007199254741002', name: '个人空间', role: 'OWNER', status: 'ACTIVE', defaultModelId: '9007199254741011' }
]
const flush = () => new Promise((resolve) => setImmediate(resolve))
function success(options, data, statusCode = 200) { options.success({ statusCode, data: { code: 0, message: 'ok', data } }) }
function failure(options, code, category) {
  options.success({ statusCode: code, data: { code, message: `error-${code}`, data: { category } } })
}
function resultFor(options) {
  return {
    recognitionId: '9007199254741999', requestId: options.header['Idempotency-Key'], digit: 7, confidence: 0.9876,
    modelId: '9007199254741011', modelVersion: 'w2-canvas-photo-3epoch', preprocessVersion: 'adaptive-mnist-v2',
    source: 'MINIPROGRAM', processingMs: 31, createdAt: '2026-11-02T01:02:03Z'
  }
}
function page(definition) {
  return {
    ...definition, data: structuredClone(definition.data || {}), updates: [],
    selectComponent() { return this.board || null },
    setData(patch, callback) {
      assert.notEqual(this.unloaded, true, 'No Page.setData after unload')
      this.updates.push(patch)
      Object.assign(this.data, patch)
      if (callback) callback()
    }
  }
}
function harness(cache = {}) {
  const storage = new Map(Object.entries(cache))
  // W2 fixtures explicitly retain their development origin under the pilot runtime contract.
  const app = { globalData: structuredClone(appDefinition.globalData),
    _runtimeOptions: { publicConfig: { mode: 'development', apiBaseUrl: 'http://localhost:8080', operator: '', contact: '', privacyVersion: '' } } }
  const redirects = [], navigations = [], requests = [], uploads = [], exports = [], toasts = []
  let random = 0
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    reLaunch: ({ url }) => redirects.push(url),
    navigateTo: ({ url }) => navigations.push(url),
    showToast: (options) => toasts.push(options),
    request: (options) => { requests.push(options); return { abort() { options.aborted = true } } },
    uploadFile: (options) => { uploads.push(options); return { abort() { options.aborted = true } } },
    getWindowInfo: () => ({ pixelRatio: 2 }),
    canvasToTempFilePath: (options) => exports.push(options),
    getRandomValues: (options) => options.success({ randomValues: new Uint8Array(16).fill(++random).buffer })
  }
  global.wx = wx
  global.getApp = () => app
  appDefinition.onLaunch.call(app)
  return { storage, app, redirects, navigations, requests, uploads, exports, toasts, wx }
}
function mountBoard(h, owner) {
  const raster = createCanvasStub()
  const board = {
    ...boardDefinition.methods, data: structuredClone(boardDefinition.data),
    setData(patch) { assert.notEqual(this._detached, true); Object.assign(this.data, patch) },
    triggerEvent(name, detail) { owner.onDrawingChange({ detail }) },
    createSelectorQuery() {
      return {
        select() { return this }, fields() { return this },
        exec(callback) { callback([{ node: raster.canvas, width: 100, height: 80 }]) }
      }
    }
  }
  owner.board = board
  boardDefinition.lifetimes.attached.call(board)
  boardDefinition.lifetimes.ready.call(board)
  return board
}
function dot(board, x = 20) {
  const touch = { x, y: 20, identifier: 1 }
  board.onTouchStart({ touches: [touch] })
  board.onTouchEnd({ changedTouches: [touch] })
}
async function authorizedPage(h) {
  saveSession({ token: 'token-A', ...identity })
  const index = page(indexDefinition)
  const pending = index.onShow()
  success(h.requests.at(-1), identity)
  await flush()
  success(h.requests.at(-1), spaces)
  await flush()
  success(h.requests.at(-1), spaces[0])
  await pending
  mountBoard(h, index)
  return index
}
async function startUpload(h, index) {
  dot(index.board)
  const pending = index.recognize()
  h.exports.at(-1).success({ tempFilePath: 'wxfile://real-component-stub.png' })
  await flush()
  return { pending, options: h.uploads.at(-1) }
}
afterEach(() => { delete global.wx; delete global.getApp })

for (const [label, cache] of [
  ['empty', {}], ['token only legacy', { hdr_token: 'old' }], ['user only legacy', { hdr_user: user }],
  ['complete W1', { hdr_token: 'old', hdr_user: user }],
  ['blank v2', { [STORAGE_KEY]: { token: '   ' } }], ['invalid v2', { [STORAGE_KEY]: { token: 123 } }]
]) {
  test(`${label} cache cannot authorize or cause login/index bounce`, async () => {
    const h = harness(cache)
    const login = page(loginDefinition)
    login.onShow()
    assert.equal(h.requests.length, 0)
    assert.equal(h.redirects.length, 0)
    assert.equal(readSession(), null)
    const index = page(indexDefinition)
    await index.onShow()
    assert.equal(index.data.authorized, false)
    assert.deepEqual(h.redirects, ['/pages/login/login'])
    login.onShow()
    assert.equal(h.redirects.length, 1)
    assert.equal(h.storage.size, 0)
  })
}

test('App and login do not contact server or authorize a cached token without verification', () => {
  const h = harness({ [STORAGE_KEY]: { token: 'candidate', origin: 'http://localhost:8080', user: { ...user, platformRole: 'SUPER_ADMIN' }, verified: true } })
  assert.equal(h.app.globalData.verified, false)
  assert.equal(h.app.globalData.user, null)
  const login = page(loginDefinition)
  login.onShow()
  assert.equal(login.openDrawingPrototype, undefined)
  assert.deepEqual(h.navigations, [])
  assert.equal(h.requests.length, 0)
  assert.equal(h.uploads.length, 0)
  assert.equal(h.redirects.length, 0)
  assert.equal(login.data.hasCandidate, true)
})

test('v2 login starts blank, suppresses double taps, then requires verified /me before navigation', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.onShow()
  assert.equal(login.data.username, '')
  assert.equal(login.data.password, '')
  await login.submit()
  assert.equal(h.requests.length, 0)
  login.onInput({ currentTarget: { dataset: { field: 'username' } }, detail: { value: 'member' } })
  login.onInput({ currentTarget: { dataset: { field: 'password' } }, detail: { value: 'user-supplied' } })
  const pending = login.submit()
  login.submit()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, 'http://localhost:8080/api/v2/auth/login')
  assert.equal(h.requests[0].header.Authorization, undefined)
  assert.deepEqual(h.requests[0].data, { username: 'member', password: 'user-supplied' })
  success(h.requests[0], { token: 'new-token', ...identity })
  await flush()
  assert.equal(h.redirects.length, 0)
  assert.equal(h.app.globalData.verified, false)
  assert.equal(login.data.password, '')
  assert.equal(h.requests[1].url, 'http://localhost:8080/api/v2/auth/me')
  assert.equal(h.requests[1].header.Authorization, 'Bearer new-token')
  success(h.requests[1], identity)
  await pending
  assert.equal(h.app.globalData.verified, true)
  assert.equal(h.app.globalData.user.platformRole, 'USER')
  assert.deepEqual(h.storage.get(STORAGE_KEY), { token: 'new-token', origin: 'http://localhost:8080' })
  assert.deepEqual(h.redirects, ['/pages/index/index'])
  assert.equal(login.data.loading, false)
})

test('continue candidate verifies /me rather than trusting cached data', async () => {
  const h = harness({ [STORAGE_KEY]: { token: 'candidate', origin: 'http://localhost:8080' } })
  const login = page(loginDefinition)
  login.onShow()
  const pending = login.continueSession()
  assert.equal(h.redirects.length, 0)
  success(h.requests[0], identity)
  await pending
  assert.deepEqual(h.redirects, ['/pages/index/index'])
})

for (const response of [{ token: 'only-token' }, { token: 'bad-id', ...identity, user: { ...user, id: 123 } }]) {
  test('malformed login data cannot authorize or leave loading stuck', async () => {
    const h = harness()
    const login = page(loginDefinition)
    login.onShow()
    login.setData({ username: 'member', password: 'typed' })
    const pending = login.submit()
    success(h.requests[0], response)
    await pending
    assert.equal(h.redirects.length, 0)
    assert.equal(h.app.globalData.verified, false)
    assert.equal(h.app.globalData.token, '')
    assert.match(login.data.error, /不完整/)
    assert.equal(login.data.loading, false)
  })
}

for (const stage of ['login', 'me']) {
  for (const callback of ['success', '401', 'network']) {
    test(`old ${stage} ${callback} cannot overwrite a new login, error, or finally`, async () => {
      const h = harness()
      const login = page(loginDefinition)
      login.onShow()
      login.setData({ username: 'old', password: 'typed' })
      const oldPending = login.submit()
      if (stage === 'me') {
        success(h.requests[0], { token: 'old-token', ...identity })
        await flush()
      }
      const old = h.requests.at(-1)
      login.onHide()
      login.onShow()
      login.setData({ username: 'new', password: 'typed-again' })
      const currentPending = login.submit()
      const current = h.requests.at(-1)
      if (callback === 'success') success(old, stage === 'me' ? identity : { token: 'late-old', ...identity })
      if (callback === '401') failure(old, 401)
      if (callback === 'network') old.fail({ errMsg: 'offline' })
      await oldPending
      assert.equal(login.data.loading, true)
      assert.equal(login.data.error, '')
      assert.equal(h.redirects.length, 0)
      success(current, { token: 'new-token', ...identity })
      await flush()
      success(h.requests.at(-1), identity)
      await currentPending
      assert.equal(h.app.globalData.token, 'new-token')
      assert.equal(h.redirects.length, 1)
    })
  }
}

test('login unloaded before completion cannot save, redirect or setData', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.onShow()
  login.setData({ username: 'member', password: 'typed' })
  const pending = login.submit()
  login.onUnload()
  login.unloaded = true
  success(h.requests[0], { token: 'late', ...identity })
  await pending
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.redirects.length, 0)
})

test('verification is deduplicated per generation and an old finalizer cannot delete newer pending me', async () => {
  const h = harness()
  saveSession({ token: 'A', ...identity })
  const first = verifySession()
  const rejected = assert.rejects(first, (error) => error.stale)
  assert.equal(verifySession(), first)
  saveSession({ token: 'B', ...identity })
  const second = verifySession()
  failure(h.requests[0], 401)
  await rejected
  assert.equal(verifySession(), second)
  success(h.requests[1], identity)
  await second
  assert.equal(h.app.globalData.token, 'B')
  assert.equal(h.redirects.length, 0)
})

for (const bad of [null, { user, defaultWorkspaceId: 123 }, { user: { ...user, id: 1 }, defaultWorkspaceId: '1' }]) {
  test('invalid me response fails closed without trusting the login identity', async () => {
    const h = harness()
    saveSession({ token: 'A', ...identity })
    const pending = verifySession()
    const rejected = assert.rejects(pending, /身份响应格式错误/)
    success(h.requests[0], bad)
    await rejected
    assert.equal(h.app.globalData.verified, false)
    assert.equal(h.app.globalData.user, null)
  })
}

for (const kind of ['request', 'upload']) {
  const send = kind === 'request' ? request : upload
  for (const [label, statusCode, data, code] of [
    ['HTTP401 despite body success', 401, { code: 0, data: null }, 401],
    ['body401', 200, { code: 401, message: 'expired' }, 401],
    ['HTML413', 413, '<html>too large</html>', 413],
    ['body403', 200, { code: 403, message: 'denied' }, 403],
    ['HTTP404', 404, { code: 404, message: 'missing' }, 404],
    ['invalidJSON', 200, 'oops', 200],
    ['HTML502', 502, '<html>bad gateway</html>', 502],
    ['503', 503, { code: 503 }, 503]
  ]) {
    test(`${kind} handles ${label} using HTTP and envelope; only current 401 clears auth`, async () => {
      const h = harness()
      saveSession({ token: 'A', ...identity })
      const pending = send({ url: '/api/v2/test', filePath: 'wxfile://stub.png' })
      const rejected = assert.rejects(pending, (error) => error.code === code)
      const options = kind === 'request' ? h.requests[0] : h.uploads[0]
      assert.equal(options.header.Authorization, 'Bearer A')
      assert.equal(options.timeout, TIMEOUT_MS)
      options.success({ statusCode, data: kind === 'upload' && typeof data === 'object' ? JSON.stringify(data) : data })
      await rejected
      assert.equal(h.app.globalData.token, code === 401 ? '' : 'A')
      assert.equal(h.redirects.length, code === 401 ? 1 : 0)
      assert.equal(h.toasts.length, 0)
    })
  }

  test(`${kind} old session 401 cannot clear replacement token`, async () => {
    const h = harness()
    saveSession({ token: 'A', ...identity })
    const pending = send({ url: '/api/v2/test', filePath: 'wxfile://stub.png' })
    const rejected = assert.rejects(pending, (error) => error.stale)
    saveSession({ token: 'B', ...identity })
    failure(kind === 'request' ? h.requests[0] : h.uploads[0], 401)
    await rejected
    assert.equal(h.app.globalData.token, 'B')
    assert.equal(h.redirects.length, 0)
  })

  test(`${kind} abort settles without platform callback, late 401 is ignored`, async () => {
    const h = harness()
    saveSession({ token: 'A', ...identity })
    const pending = send({ url: '/api/v2/test', filePath: 'wxfile://stub.png' })
    const rejected = assert.rejects(pending, (error) => error.aborted)
    pending.abort()
    const options = kind === 'request' ? h.requests[0] : h.uploads[0]
    assert.equal(options.aborted, true)
    failure(options, 401)
    await rejected
    assert.equal(h.app.globalData.token, 'A')
  })

  test(`${kind} timeout aborts once and does not retry POST`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    const pending = send({ url: '/api/v2/test', method: 'POST', filePath: 'wxfile://stub.png' })
    const rejected = assert.rejects(pending, (error) => error.timeout)
    t.mock.timers.tick(TIMEOUT_MS)
    await rejected
    const items = kind === 'request' ? h.requests : h.uploads
    assert.equal(items.length, 1)
    assert.equal(items[0].aborted, true)
    success(items[0], 'late')
    assert.equal(h.toasts.length, 0)
  })
}

test('429 exposes category and Retry-After without signing out', async () => {
  const h = harness()
  saveSession({ token: 'A', ...identity })
  const pending = upload({ url: '/api/v2/test', filePath: 'wxfile://stub.png' })
  const rejected = assert.rejects(pending, (error) => error.code === 429 && error.category === 'WORKSPACE' && error.retryAfterSeconds === '12' && /12/.test(error.message))
  h.uploads[0].success({ statusCode: 429, header: { 'Retry-After': '12' }, data: JSON.stringify({ code: 429, data: { category: 'WORKSPACE' } }) })
  await rejected
  assert.equal(h.app.globalData.token, 'A')
})

test('ordinary MEMBER reaches protected business page only after me/list/detail and uploads exact v2 contract', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  assert.equal(index.data.workspaceReady, true)
  assert.equal(index.data.user.platformRole, 'USER')
  assert.equal(index.data.workspace.role, 'MEMBER')
  assert.equal(index.data.workspace.id, identity.defaultWorkspaceId)
  assert.deepEqual(h.requests.map((item) => item.url.replace('http://localhost:8080', '')), [
    '/api/v2/auth/me', '/api/v2/workspaces', `/api/v2/workspaces/${identity.defaultWorkspaceId}`
  ])
  await index.recognize()
  assert.equal(h.uploads.length, 0, 'blank drawing cannot upload')
  const operation = await startUpload(h, index)
  index.recognize()
  assert.equal(h.uploads.length, 1)
  const options = operation.options
  assert.equal(options.url, `http://localhost:8080/api/v2/workspaces/${identity.defaultWorkspaceId}/recognitions`)
  assert.equal(options.name, 'image')
  assert.deepEqual(options.formData, { source: 'MINIPROGRAM' })
  assert.equal(options.header.Authorization, 'Bearer token-A')
  assert.equal(options.header['Content-Type'], undefined, 'platform sets multipart boundary')
  assert.match(options.header['Idempotency-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  options.success({ statusCode: 200, data: JSON.stringify({ code: 0, data: resultFor(options) }) })
  await operation.pending
  assert.equal(index.data.result.digit, 7)
  assert.equal(index.data.result.confidencePercent, '98.76')
  assert.equal(index.data.result.recognitionId, '9007199254741999')
  assert.equal(index.data.recognizing, false)
  assert.equal(index.board.data.previewPath, options.filePath)
})

for (const code of [403, 404]) {
  test(`space ${code} blocks drawing, keeps session, and another space can be selected`, async () => {
    const h = harness()
    const index = await authorizedPage(h)
    const pending = index.onWorkspaceChange({ detail: { value: 1 } })
    failure(h.requests.at(-1), code)
    await pending
    assert.equal(index.data.workspaceReady, false)
    assert.equal(index.data.authorized, true)
    assert.equal(h.app.globalData.token, 'token-A')
    assert.equal(h.redirects.length, 0)
    assert.match(index.data.error, new RegExp(String(code)))
    const retry = index.onWorkspaceChange({ detail: { value: 0 } })
    success(h.requests.at(-1), spaces[0])
    await retry
    assert.equal(index.data.workspaceReady, true)
    assert.equal(index.data.error, '')
  })
}

test('empty workspace list is a genuine empty state, not demo data or logout', async () => {
  const h = harness()
  saveSession({ token: 'A', ...identity })
  const index = page(indexDefinition)
  const pending = index.onShow()
  success(h.requests[0], identity)
  await flush()
  success(h.requests[1], [])
  await pending
  assert.equal(index.data.workspaceReady, false)
  assert.deepEqual(index.data.workspaces, [])
  assert.match(index.data.error, /暂无/)
  assert.equal(h.redirects.length, 0)
})

for (const stage of ['me', 'list', 'detail']) {
  test(`unload during ${stage} suppresses all late page effects`, async () => {
    const h = harness()
    saveSession({ token: 'A', ...identity })
    const index = page(indexDefinition)
    const pending = index.onShow()
    if (stage !== 'me') { success(h.requests.at(-1), identity); await flush() }
    if (stage === 'detail') { success(h.requests.at(-1), spaces); await flush() }
    const old = h.requests.at(-1)
    index.onUnload()
    index.unloaded = true
    success(old, stage === 'me' ? identity : stage === 'list' ? spaces : spaces[0])
    await pending
    assert.equal(h.uploads.length, 0)
    assert.equal(h.redirects.length, 0)
  })
}

for (const callback of ['success', '401', 'network']) {
  test(`old workspace detail ${callback} cannot overwrite a newer selection or loading`, async () => {
    const h = harness()
    const index = await authorizedPage(h)
    const first = index.onWorkspaceChange({ detail: { value: 1 } })
    const old = h.requests.at(-1)
    const second = index.onWorkspaceChange({ detail: { value: 0 } })
    const current = h.requests.at(-1)
    if (callback === 'success') success(old, spaces[1])
    if (callback === '401') failure(old, 401)
    if (callback === 'network') old.fail({ errMsg: 'offline' })
    await first
    assert.equal(index.data.spaceLoading, true)
    assert.equal(index.data.workspace, null)
    assert.equal(index.data.error, '')
    success(current, spaces[0])
    await second
    assert.equal(index.data.workspace.id, spaces[0].id)
    assert.equal(h.app.globalData.token, 'token-A')
  })
}

for (const mutation of ['clear', 'redraw', 'switch', 'logout', 'unload', 'new-session']) {
  for (const callback of ['success', '401', 'network']) {
    test(`upload ${callback} after ${mutation} cannot mutate result/error/finally or revoke newer auth`, async () => {
      const h = harness()
      const index = await authorizedPage(h)
      const old = await startUpload(h, index)
      if (mutation === 'clear') index.board.clear()
      if (mutation === 'redraw') dot(index.board, 60)
      if (mutation === 'switch') {
        const change = index.onWorkspaceChange({ detail: { value: 1 } })
        success(h.requests.at(-1), spaces[1])
        await change
      }
      if (mutation === 'logout') index.logout()
      if (mutation === 'unload') { index.onUnload(); index.unloaded = true }
      if (mutation === 'new-session') saveSession({ token: 'new-account', ...identity })
      const before = structuredClone(index.data)
      const updates = index.updates.length
      if (callback === 'success') success(old.options, resultFor(old.options))
      if (callback === '401') failure(old.options, 401)
      if (callback === 'network') old.options.fail({ errMsg: 'offline' })
      await old.pending
      assert.deepEqual(index.data, before)
      assert.equal(index.updates.length, updates)
      assert.equal(h.toasts.length, 0)
      assert.equal(old.options.aborted, true)
      assert.equal(h.app.globalData.token, mutation === 'logout' ? '' : mutation === 'new-session' ? 'new-account' : 'token-A')
    })
  }
}

for (const mutation of ['clear', 'redraw', 'switch', 'unload']) {
  test(`pending export after ${mutation} never becomes an upload`, async () => {
    const h = harness()
    const index = await authorizedPage(h)
    dot(index.board)
    const pending = index.recognize()
    const old = h.exports.at(-1)
    if (mutation === 'clear') index.board.clear()
    if (mutation === 'redraw') dot(index.board, 50)
    if (mutation === 'switch') {
      const change = index.onWorkspaceChange({ detail: { value: 1 } })
      success(h.requests.at(-1), spaces[1])
      await change
    }
    if (mutation === 'unload') { index.onUnload(); index.unloaded = true }
    old.success({ tempFilePath: 'wxfile://stale.png' })
    await pending
    assert.equal(h.uploads.length, 0)
    assert.equal(h.toasts.length, 0)
  })
}

test('old recognition finally cannot stop a newer recognition; explicit retries receive new UUIDs', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  const first = await startUpload(h, index)
  index.board.clear()
  dot(index.board, 50)
  const secondPending = index.recognize()
  first.options.fail({ errMsg: 'old' })
  await first.pending
  assert.equal(index.data.recognizing, true)
  h.exports.at(-1).success({ tempFilePath: 'wxfile://new.png' })
  await flush()
  const second = h.uploads.at(-1)
  assert.notEqual(second.header['Idempotency-Key'], first.options.header['Idempotency-Key'])
  success(second, resultFor(second))
  await secondPending
  assert.equal(index.data.result.requestId, second.header['Idempotency-Key'])
})

for (const category of ['IN_PROGRESS', 'IDEMPOTENCY_CONFLICT', 'REQUEST_FAILED']) {
  test(`409 ${category} does not auto-retry and keeps current drawing`, async () => {
    const h = harness()
    const index = await authorizedPage(h)
    const operation = await startUpload(h, index)
    failure(operation.options, 409, category)
    await operation.pending
    assert.equal(h.uploads.length, 1)
    assert.equal(index.data.hasInk, true)
    assert.equal(index.data.result, null)
    assert.equal(index.data.recognizing, false)
    assert.match(index.data.recognitionError, /409/)
  })
}

for (const patch of [{ digit: 10 }, { confidence: Infinity }, { confidence: -0.1 }, { requestId: 'mismatch' },
  { modelVersion: '' }, { recognitionId: 9007199254740992 }, { source: 'WEB' }, { processingMs: NaN }]) {
  test(`invalid recognition response is not displayed: ${Object.keys(patch)[0]}`, () => {
    const result = resultFor({ header: { 'Idempotency-Key': 'expected' } })
    assert.throws(() => validateResult({ ...result, ...patch }, 'expected'), /合同不一致/)
  })
}

test('logout sends v2 revocation with old bearer, clears state immediately, ignores late failure', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  index.logout()
  const revocation = h.requests.at(-1)
  assert.equal(revocation.url, 'http://localhost:8080/api/v2/auth/logout')
  assert.equal(revocation.method, 'POST')
  assert.equal(revocation.header.Authorization, 'Bearer token-A')
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.storage.has(STORAGE_KEY), false)
  assert.equal(index.data.authorized, false)
  saveSession({ token: 'replacement', ...identity })
  failure(revocation, 401)
  await flush()
  assert.equal(h.app.globalData.token, 'replacement')
  assert.equal(h.redirects.length, 1)
})

test('login network failure is visible, clears sensitive password, and unlocks retry', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.onShow()
  login.setData({ username: 'member', password: 'typed' })
  const pending = login.submit()
  h.requests[0].fail({ errMsg: 'offline' })
  await pending
  assert.match(login.data.error, /网络异常/)
  assert.equal(login.data.password, '', 'pilot contract clears sensitive inputs after completion')
  assert.equal(login.data.loading, false)
  assert.equal(h.requests.length, 1)
})

for (const callback of ['success', '401']) {
  test(`login leaves during me: late ${callback} cannot verify or clear cached candidate`, async () => {
    const h = harness({ [STORAGE_KEY]: { token: 'candidate', origin: 'http://localhost:8080' } })
    const login = page(loginDefinition)
    login.onShow()
    const pending = login.continueSession()
    login.onUnload()
    login.unloaded = true
    if (callback === 'success') success(h.requests[0], identity)
    else failure(h.requests[0], 401)
    await pending
    assert.equal(h.requests[0].aborted, true)
    assert.equal(h.app.globalData.verified, false)
    assert.equal(h.app.globalData.token, 'candidate')
    assert.equal(h.redirects.length, 0)
  })
}

test('queued me success before unload is not allowed to verify after unload', async () => {
  const h = harness({ [STORAGE_KEY]: { token: 'candidate', origin: 'http://localhost:8080' } })
  const login = page(loginDefinition)
  login.onShow()
  const pending = login.continueSession()
  success(h.requests[0], identity)
  login.onUnload()
  login.unloaded = true
  await pending
  assert.equal(h.app.globalData.verified, false)
  assert.equal(h.redirects.length, 0)
})

test('current business upload 401 clears protected UI and routes to login', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  const operation = await startUpload(h, index)
  failure(operation.options, 401)
  await operation.pending
  assert.equal(h.app.globalData.token, '')
  assert.equal(index.data.authorized, false)
  assert.equal(index.data.workspaceReady, false)
  assert.equal(index.data.recognizing, false)
  assert.equal(index.data.result, null)
  assert.deepEqual(h.redirects, ['/pages/login/login'])
})

test('HTML413 and malformed result are visible on the actual page without losing current auth', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  const first = await startUpload(h, index)
  first.options.success({ statusCode: 413, data: '<html>too large</html>' })
  await first.pending
  assert.match(index.data.recognitionError, /图片过大/)
  assert.equal(index.data.recognizing, false)
  const second = await startUpload(h, index)
  success(second.options, { ...resultFor(second.options), digit: 20 })
  await second.pending
  assert.match(index.data.recognitionError, /合同不一致/)
  assert.equal(index.data.result, null)
  assert.equal(h.app.globalData.token, 'token-A')
})

test('422 shows a rewrite hint with no guess or automatic retry and preserves login', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  const operation = await startUpload(h, index)
  operation.options.success({ statusCode: 422, data: { code: 422, data: { category: 'UNRECOGNIZED_INPUT' } } })
  await operation.pending
  assert.equal(index.data.result, null)
  assert.match(index.data.recognitionError, /重新书写/)
  assert.equal(index.data.recognizing, false)
  assert.equal(h.app.globalData.token, 'token-A')
  assert.equal(h.uploads.length, 1)
  assert.equal(h.redirects.length, 0)
})

test('422 arriving after clear does not revive a rejected result or error', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  const operation = await startUpload(h, index)
  index.board.clear()
  failure(operation.options, 422, 'UNRECOGNIZED_INPUT')
  await operation.pending
  assert.equal(index.data.result, null)
  assert.equal(index.data.recognitionError, '')
  assert.equal(index.data.recognizing, false)
})

test('native UUID failure requests one server identifier without uploading until it succeeds', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  h.wx.getRandomValues = (options) => options.fail({ errMsg: 'unavailable' })
  const operation = await startUpload(h, index)
  assert.equal(h.uploads.length, 0)
  const fallback = h.requests.at(-1)
  assert.equal(fallback.url, `http://localhost:8080/api/v2/workspaces/${spaces[0].id}/recognitions/request-id`)
  assert.equal(fallback.header.Authorization, 'Bearer token-A')
  const requestId = '00000000-0000-4000-8000-000000000123'
  success(fallback, { requestId })
  await flush()
  const options = h.uploads.at(-1)
  assert.equal(options.header['Idempotency-Key'], requestId)
  success(options, resultFor(options))
  await operation.pending
  assert.equal(index.data.result.digit, 7)
  assert.equal(index.data.recognizing, false)
})

for (const action of ['clear', 'hide', 'logout']) {
  test(`server request-id response after ${action} cannot upload a stale image`, async () => {
    const h = harness()
    const index = await authorizedPage(h)
    h.wx.getRandomValues = undefined
    const operation = await startUpload(h, index)
    const fallback = h.requests.at(-1)
    if (action === 'clear') index.board.clear()
    if (action === 'hide') index.onHide()
    if (action === 'logout') index.logout()
    assert.equal(fallback.aborted, true)
    success(fallback, { requestId: '00000000-0000-4000-8000-000000000123' })
    await operation.pending
    assert.equal(h.uploads.length, 0)
    assert.equal(index.data.result, null)
  })
}

test('failed server request-id lookup preserves its error and never retries inference', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  h.wx.getRandomValues = undefined
  const operation = await startUpload(h, index)
  failure(h.requests.at(-1), 503)
  await operation.pending
  assert.equal(h.uploads.length, 0)
  assert.equal(index.data.recognitionError, 'error-503')
  assert.equal(index.data.recognizing, false)
})

test('clear during random UUID generation cannot start a stale upload or stop a new export', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  let random
  h.wx.getRandomValues = (options) => { random = options }
  const first = await startUpload(h, index)
  index.board.clear()
  dot(index.board, 50)
  const second = index.recognize()
  random.success({ randomValues: new Uint8Array(16).buffer })
  await first.pending
  assert.equal(h.uploads.length, 0)
  assert.equal(index.data.recognizing, true)
  index.board.clear()
  await second
})

test('business page revisits reverify /me rather than trusting in-memory verified state', async () => {
  const h = harness()
  const index = await authorizedPage(h)
  index.onHide()
  const pending = index.onShow()
  assert.equal(h.requests.at(-1).url, 'http://localhost:8080/api/v2/auth/me')
  assert.equal(index.data.authorized, false)
  assert.equal(h.app.globalData.verified, false)
  failure(h.requests.at(-1), 401)
  await pending
  assert.equal(h.app.globalData.token, '')
  assert.equal(index.data.loading, false)
  assert.equal(index.data.workspaceReady, false)
})

test('request workspace guard rejects stale 401 even when task could not be aborted', async () => {
  const h = harness()
  saveSession({ token: 'A', ...identity })
  const saved = selectWorkspace(spaces[0].id)
  const pending = upload({ url: '/api/v2/test', filePath: 'wxfile://stub.png', snapshot: saved, isCurrent: () => isWorkspaceCurrent(saved) })
  const rejected = assert.rejects(pending, (error) => error.stale)
  selectWorkspace(spaces[1].id)
  failure(h.uploads[0], 401)
  await rejected
  assert.equal(h.app.globalData.token, 'A')
  assert.equal(h.redirects.length, 0)
})

test('session and workspace snapshots distinguish A to B to A switches and replaced identical tokens', () => {
  harness()
  saveSession({ token: 'same', ...identity })
  const old = selectWorkspace(spaces[0].id)
  selectWorkspace(spaces[1].id)
  selectWorkspace(spaces[0].id)
  assert.equal(isSessionCurrent(old), true)
  assert.equal(isWorkspaceCurrent(old), false)
  clearSession()
  saveSession({ token: 'same', ...identity })
  assert.equal(isSessionCurrent(old), false)
  assert.equal(snapshot().workspaceId, '')
})

// Image-import tests use the same actual Page, App, Component and network modules above.
function imageInput(h, index, { stage, jpeg = false, size, width = 28 } = {}) {
  const picks = [], local = [], reads = []
  let ids = 0
  const random = h.wx.getRandomValues
  h.wx.getRandomValues = options => { ids++; return random(options) }
  const bytes = jpeg ? Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 0, 28, 0, 28, 1, 1, 17, 0, 255, 217]) : new Uint8Array(33)
  if (!jpeg) {
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    new DataView(bytes.buffer).setUint32(16, width)
    new DataView(bytes.buffer).setUint32(20, 28)
  }
  const invoke = (name, options, response) => {
    reads.push(name)
    if (stage === name) local.push({ options, response })
    else options.success(response)
  }
  h.wx.chooseMedia = options => { picks.push(options) }
  h.wx.getFileSystemManager = () => ({
    getFileInfo: options => invoke('size', options, { size: size === undefined ? bytes.length : size }),
    readFile: options => invoke('header', options, { data: bytes.buffer }),
    unlink: () => assert.fail('Platform owns original files'),
    copyFile: () => assert.fail('No original copies')
  })
  h.wx.getImageInfo = options => invoke('decode', options, { type: jpeg ? 'jpeg' : 'png', width, height: 28, path: 'wxfile://not-original' })
  h.wx.compressImage = () => assert.fail('No image compression')
  index.onInputKindChange({ currentTarget: { dataset: { kind: 'image' } } })
  return { picks, local, reads, get ids() { return ids },
    pick(path = 'wxfile://selected-original.png', pick = picks.at(-1)) { pick.success({ tempFiles: [{ tempFilePath: path }] }) }
  }
}
async function resumeIndex(h, index, me = identity, detail = spaces[0]) {
  const pending = index.onShow()
  success(h.requests.at(-1), me)
  await flush()
  success(h.requests.at(-1), spaces)
  await flush()
  success(h.requests.at(-1), detail)
  await pending
}
async function importImage(h, index, options) {
  const images = imageInput(h, index, options)
  const pending = index.chooseImage()
  images.pick()
  await pending
  return images
}

for (const jpeg of [false, true]) {
  test(`actual Page imports ${jpeg ? 'JPEG' : 'PNG'} locally, explicit click uploads original without Canvas readiness`, async () => {
    const h = harness(), index = await authorizedPage(h)
    const beforeStorage = [...h.storage]
    const images = await importImage(h, index, { jpeg })
    assert.equal(images.ids, 0)
    assert.equal(h.requests.length, 3)
    assert.equal(h.uploads.length, 0)
    assert.equal(h.exports.length, 0)
    assert.equal(index.data.imageInfo.type, jpeg ? 'JPEG' : 'PNG')
    assert.equal(index.data.imagePath, 'wxfile://selected-original.png')
    assert.deepEqual([...h.storage], beforeStorage)
    index.board = null // Canvas unavailable must not block imported images.
    const pending = index.recognize()
    index.recognize()
    await flush()
    assert.equal(images.ids, 1)
    assert.equal(h.uploads.length, 1)
    const upload = h.uploads[0]
    assert.equal(upload.filePath, 'wxfile://selected-original.png')
    assert.equal(upload.name, 'image')
    assert.deepEqual(upload.formData, { source: 'MINIPROGRAM' })
    assert.equal(upload.header.Authorization, 'Bearer token-A')
    assert.ok(upload.url.endsWith(`/workspaces/${spaces[0].id}/recognitions`))
    success(upload, resultFor(upload))
    await pending
    assert.equal(index.data.result.digit, 7)
    assert.equal(index.data.recognizing, false)
    const retry = index.recognize()
    await flush()
    assert.notEqual(h.uploads[1].header['Idempotency-Key'], upload.header['Idempotency-Key'])
    success(h.uploads[1], resultFor(h.uploads[1]))
    await retry
    index.onUnload()
    assert.equal(index.data.imagePath, '')
  })
}

for (const order of ['before-show', 'during-me', 'during-list', 'during-detail', 'after-show']) {
  test(`picker callback ${order} only promotes after fresh same-account membership verification`, async () => {
    const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
    const selected = index.chooseImage()
    index.onHide()
    const choose = async () => {
      images.pick()
      await selected
      await index.recognize()
      assert.equal(images.ids, 0)
      assert.equal(h.uploads.length, 0)
    }
    if (order === 'before-show') {
      await choose()
      assert.equal(index.data.imagePath, '')
      assert.equal(index._pickerIntent.candidate.filePath, 'wxfile://selected-original.png')
    }
    const showing = index.onShow()
    assert.equal(index.data.imagePath, '')
    assert.equal(index.data.workspaceReady, false)
    if (order === 'during-me') await choose()
    success(h.requests.at(-1), identity)
    await flush()
    if (order === 'during-list') await choose()
    assert.equal(index.data.imagePath, '')
    success(h.requests.at(-1), spaces)
    await flush()
    if (order === 'during-detail') await choose()
    assert.equal(index.data.imagePath, '')
    success(h.requests.at(-1), spaces[0])
    await showing
    if (order === 'after-show') {
      assert.equal(index.data.imagePath, '')
      images.pick()
      await selected
    }
    assert.equal(index.data.imagePath, 'wxfile://selected-original.png')
    assert.equal(index.data.imageBusy, false)
    assert.equal(images.ids, 0)
    assert.equal(h.requests.length, 6)
    assert.equal(h.uploads.length, 0)
    const pending = index.recognize()
    await flush()
    success(h.uploads[0], resultFor(h.uploads[0]))
    await pending
    index.onUnload()
  })
}

for (const order of ['before-show', 'after-show']) {
  test(`picker cancellation ${order} produces no error, ID or upload`, async () => {
    const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
    const selected = index.chooseImage()
    index.onHide()
    if (order === 'after-show') await resumeIndex(h, index)
    images.picks[0].fail({ errMsg: 'chooseMedia:fail cancel' })
    await selected
    if (order === 'before-show') await resumeIndex(h, index)
    assert.equal(index.data.imagePath, '')
    assert.equal(index.data.imageError, '')
    assert.equal(index.data.imageBusy, false)
    assert.equal(index._pickerIntent, null)
    assert.equal(images.ids, 0)
    assert.equal(h.uploads.length, 0)
    index.onUnload()
  })
}

for (const issue of ['size', 'dimensions', 'decode', 'permission', 'missing-api']) {
  test(`Page ${issue} failure is visible and never requests IDs or uploads`, async () => {
    const h = harness(), index = await authorizedPage(h)
    const images = imageInput(h, index, { size: issue === 'size' ? 5242881 : undefined,
      width: issue === 'dimensions' ? 2049 : 28, stage: issue === 'decode' ? 'decode' : undefined })
    if (issue === 'missing-api') delete h.wx.chooseMedia
    const selected = index.chooseImage()
    if (issue === 'permission') images.picks[0].fail({ errMsg: 'permission denied' })
    else if (issue !== 'missing-api') images.pick()
    await flush()
    if (issue === 'decode') images.local[0].options.fail({ errMsg: 'corrupt' })
    await selected
    assert.equal(index.data.imagePath, '')
    assert.ok(index.data.imageError)
    assert.equal(index.data.imageBusy, false)
    await index.recognize()
    assert.equal(images.ids, 0)
    assert.equal(h.requests.length, 3)
    assert.equal(h.uploads.length, 0)
    index.onUnload()
  })
}

for (const stage of ['picker', 'decode']) {
  for (const action of ['reselect', 'remove', 'mode', 'workspace', 'logout', 'account', 'unload']) {
    test(`late ${stage} after ${action} cannot revive image/error/busy or upload`, async () => {
      const h = harness(), index = await authorizedPage(h), images = imageInput(h, index, { stage: stage === 'decode' ? 'decode' : undefined })
      const first = index.chooseImage()
      if (stage === 'decode') { images.pick(); await flush() }
      let second
      if (action === 'reselect') second = index.chooseImage()
      if (action === 'remove') index.removeImage()
      if (action === 'mode') index.onInputKindChange({ currentTarget: { dataset: { kind: 'drawing' } } })
      if (action === 'workspace') {
        const switching = index.onWorkspaceChange({ detail: { value: 1 } })
        success(h.requests.at(-1), spaces[1])
        await switching
      }
      if (action === 'logout') index.logout()
      if (action === 'account') saveSession({ token: 'new-account', ...identity })
      if (action === 'unload') { index.onUnload(); index.unloaded = true }
      const before = structuredClone(index.data), updates = index.updates.length
      if (stage === 'decode') images.local[0].options.success(images.local[0].response)
      else images.pick('wxfile://old.png', images.picks[0])
      await first
      assert.deepEqual(index.data, before)
      assert.equal(index.updates.length, updates)
      assert.equal(images.ids, 0)
      assert.equal(h.uploads.length, 0)
      if (second) {
        images.pick('wxfile://new.png')
        await flush()
        if (stage === 'decode') images.local[1].options.success(images.local[1].response)
        await second
        assert.equal(index.data.imagePath, 'wxfile://new.png')
        index.onUnload()
      } else if (!index.unloaded) index.onUnload()
    })
  }
}

for (const action of ['second-hide', 'logout-hidden', 'account-hidden', 'origin-hidden', 'workspace-away-back']) {
  test(`${action} invalidates preserved picker intent rather than bypassing scope guards`, async () => {
    const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
    const selected = index.chooseImage()
    index.onHide()
    if (action === 'second-hide') { const showing = index.onShow(); index.onHide(); await showing }
    if (action === 'logout-hidden') index.logout()
    if (action === 'account-hidden') saveSession({ token: 'new-account', ...identity })
    if (action === 'origin-hidden') {
      h.app._runtimeOptions.publicConfig.apiBaseUrl = 'http://127.0.0.1:8080'
      snapshot()
    }
    if (action === 'workspace-away-back') { selectWorkspace(spaces[1].id); selectWorkspace(spaces[0].id) }
    images.pick()
    await selected
    assert.equal(index._pickerIntent, null)
    assert.equal(index._image, null)
    assert.equal(index.data.imagePath, '')
    assert.equal(images.ids, 0)
    assert.equal(h.uploads.length, 0)
    index.onUnload()
  })
}

for (const stage of ['me', 'list', 'detail']) {
  test(`picker resume ${stage} rejection discards candidate and never uploads`, async () => {
    const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
    const selected = index.chooseImage()
    index.onHide()
    images.pick()
    await selected
    const showing = index.onShow()
    if (stage !== 'me') { success(h.requests.at(-1), identity); await flush() }
    if (stage === 'detail') { success(h.requests.at(-1), spaces); await flush() }
    failure(h.requests.at(-1), stage === 'me' ? 401 : 403)
    await showing
    assert.equal(index._pickerIntent, null)
    assert.equal(index._image, null)
    assert.equal(index.data.imagePath, '')
    assert.equal(index.data.imageBusy, false)
    assert.equal(images.ids, 0)
    assert.equal(h.uploads.length, 0)
    index.onUnload()
  })
}

test('fresh me identifying a different user with the same token cannot promote candidate', async () => {
  const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
  const selected = index.chooseImage()
  index.onHide()
  images.pick()
  await selected
  await resumeIndex(h, index, { ...identity, user: { ...user, id: 'another-user' } })
  assert.equal(index.data.imagePath, '')
  assert.equal(index._image, null)
  assert.equal(images.ids, 0)
  index.onUnload()
})

for (const callback of ['success', '401', '422']) {
  for (const action of ['reselect', 'remove', 'mode', 'workspace', 'hide', 'logout', 'account', 'unload']) {
    test(`import upload ${callback} after ${action} cannot mutate newer state or revoke auth`, async () => {
      const h = harness(), index = await authorizedPage(h), images = await importImage(h, index)
      const uploading = index.recognize()
      await flush()
      const old = h.uploads[0]
      let selecting
      if (action === 'reselect') selecting = index.chooseImage()
      if (action === 'remove') index.removeImage()
      if (action === 'mode') index.onInputKindChange({ currentTarget: { dataset: { kind: 'drawing' } } })
      if (action === 'workspace') {
        const changing = index.onWorkspaceChange({ detail: { value: 1 } })
        success(h.requests.at(-1), spaces[1])
        await changing
      }
      if (action === 'hide') index.onHide()
      if (action === 'logout') index.logout()
      if (action === 'account') saveSession({ token: 'new-account', ...identity })
      if (action === 'unload') { index.onUnload(); index.unloaded = true }
      const before = structuredClone(index.data), updates = index.updates.length
      if (callback === 'success') success(old, resultFor(old))
      else failure(old, Number(callback), 'UNRECOGNIZED_INPUT')
      await uploading
      assert.equal(old.aborted, true)
      assert.deepEqual(index.data, before)
      assert.equal(index.updates.length, updates)
      assert.equal(h.app.globalData.token, action === 'logout' ? '' : action === 'account' ? 'new-account' : 'token-A')
      if (selecting) { images.picks.at(-1).fail({ errMsg: 'cancel' }); await selecting }
      if (!index.unloaded) index.onUnload()
    })
  }
}

test('imported 422 gives replace/rewrite guidance, retains input and does not retry', async () => {
  const h = harness(), index = await authorizedPage(h)
  await importImage(h, index)
  const pending = index.recognize()
  await flush()
  failure(h.uploads[0], 422, 'UNRECOGNIZED_INPUT')
  await pending
  assert.match(index.data.recognitionError, /更换图片或重新书写/)
  assert.equal(index.data.result, null)
  assert.equal(index.data.imagePath, 'wxfile://selected-original.png')
  assert.equal(index.data.recognizing, false)
  assert.equal(h.uploads.length, 1)
  assert.equal(h.app.globalData.token, 'token-A')
  index.onUnload()
})

test('inactive production drawing changes cannot invalidate imported result; switch back uses actual ink', async () => {
  const h = harness(), index = await authorizedPage(h)
  await importImage(h, index)
  const pending = index.recognize()
  await flush()
  success(h.uploads[0], resultFor(h.uploads[0]))
  await pending
  dot(index.board)
  assert.equal(index.data.result.digit, 7)
  assert.equal(index.data.imagePath, 'wxfile://selected-original.png')
  index.onInputKindChange({ currentTarget: { dataset: { kind: 'drawing' } } })
  assert.equal(index.data.imagePath, '')
  assert.equal(index.data.result, null)
  assert.equal(index.data.hasInk, true)
  index.onUnload()
})

test('switching back initializes a real board that previously measured hidden zero size', async () => {
  const h = harness(), index = await authorizedPage(h)
  await importImage(h, index)
  const query = index.board.createSelectorQuery
  index.board.createSelectorQuery = () => ({ select() { return this }, fields() { return this }, exec(callback) { callback([]) } })
  index.board.initCanvas()
  assert.equal(index.board.getSnapshot().ready, false)
  assert.equal(index.data.imagePath, 'wxfile://selected-original.png')
  index.board.createSelectorQuery = query
  index.onInputKindChange({ currentTarget: { dataset: { kind: 'drawing' } } })
  assert.equal(index.board.getSnapshot().ready, true)
  dot(index.board)
  assert.equal(index.data.hasInk, true)
  index.onUnload()
})

for (const stage of ['me', 'list', 'detail']) {
  test(`hide during picker-resume ${stage} aborts auth and ignores late 401`, async () => {
    const h = harness(), index = await authorizedPage(h), images = imageInput(h, index)
    const selected = index.chooseImage()
    index.onHide()
    const showing = index.onShow()
    if (stage !== 'me') { success(h.requests.at(-1), identity); await flush() }
    if (stage === 'detail') { success(h.requests.at(-1), spaces); await flush() }
    const old = h.requests.at(-1)
    index.onHide()
    const before = structuredClone(index.data)
    failure(old, 401)
    images.pick()
    await selected
    await showing
    assert.equal(old.aborted, true)
    assert.deepEqual(index.data, before)
    assert.equal(h.app.globalData.token, 'token-A')
    assert.equal(h.uploads.length, 0)
    assert.equal(index._pickerIntent, null)
    index.onUnload()
  })
}

test('image request-ID fallback only starts on explicit click and is cancelled on hide', async () => {
  const h = harness(), index = await authorizedPage(h)
  delete h.wx.getRandomValues
  const images = imageInput(h, index)
  delete h.wx.getRandomValues
  await index.recognize()
  const selected = index.chooseImage()
  await index.recognize()
  images.pick()
  await selected
  assert.equal(h.requests.length, 3)
  const pending = index.recognize()
  await flush()
  const fallback = h.requests.at(-1)
  assert.ok(fallback.url.endsWith('/recognitions/request-id'))
  assert.equal(h.uploads.length, 0)
  index.onHide()
  assert.equal(fallback.aborted, true)
  success(fallback, { requestId: '00000000-0000-4000-8000-000000000123' })
  await pending
  assert.equal(h.uploads.length, 0)
  index.onUnload()
})
