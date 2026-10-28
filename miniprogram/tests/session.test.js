const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const { readSession, clearSession, saveSession } = require('../utils/session')
const { request, upload } = require('../utils/request')

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
const prototypeDefinition = loadDefinition('../pages/drawing-prototype/drawing-prototype')
const appDefinition = loadDefinition('../app', 'App')

function page(definition) {
  return {
    ...definition,
    data: structuredClone(definition.data || {}),
    setData(patch) { Object.assign(this.data, patch) }
  }
}

function harness(cache = {}) {
  const storage = new Map(Object.entries(cache))
  const app = { globalData: { token: 'stale-memory-token', user: { username: 'stale' }, baseUrl: 'http://localhost:8080' } }
  const redirects = []
  const navigations = []
  const requests = []
  const uploads = []
  const toasts = []
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    reLaunch: ({ url }) => redirects.push(url),
    navigateTo: ({ url }) => navigations.push(url),
    request: (options) => requests.push(options),
    uploadFile: (options) => uploads.push(options),
    showToast: (options) => toasts.push(options)
  }
  global.wx = wx
  global.getApp = () => app
  return { storage, app, redirects, navigations, requests, uploads, toasts, wx }
}

afterEach(() => {
  delete global.wx
  delete global.getApp
})

for (const [label, cache] of [
  ['empty', {}],
  ['token only', { hdr_token: 'token' }],
  ['user only', { hdr_user: { username: 'admin' } }],
  ['blank token', { hdr_token: '   ', hdr_user: { username: 'admin' } }],
  ['invalid user', { hdr_token: 'token', hdr_user: 'admin' }],
  ['array user', { hdr_token: 'token', hdr_user: [] }]
]) {
  test(`${label} cache is cleared consistently and cannot cause a login/index redirect loop`, () => {
    const h = harness(cache)
    const login = page(loginDefinition)
    const index = page(indexDefinition)
    login.onShow()
    assert.equal(h.redirects.length, 0, 'Incomplete login never redirects to business index')
    assert.equal(h.storage.has('hdr_token'), false)
    assert.equal(h.storage.has('hdr_user'), false)
    assert.equal(h.app.globalData.token, '')
    assert.equal(h.app.globalData.user, null)
    index.onShow()
    assert.deepEqual(h.redirects, ['/pages/login/login'])
    login.onShow()
    assert.equal(h.redirects.length, 1, 'Login must not bounce back to index')
  })
}

test('complete cache restores memory and routes login to the authenticated index', () => {
  const user = { username: 'admin', nickname: '测试用户' }
  const h = harness({ hdr_token: 'valid-token', hdr_user: user })
  page(loginDefinition).onShow()
  assert.deepEqual(h.redirects, ['/pages/index/index'])
  const index = page(indexDefinition)
  index.onShow()
  assert.equal(index.data.user, user)
  assert.equal(h.app.globalData.token, 'valid-token')
  assert.equal(h.app.globalData.user, user)
  assert.equal(h.redirects.length, 1)
})

test('app launch applies the same complete-session rule', () => {
  const h = harness({ hdr_token: 'token-only' })
  appDefinition.onLaunch.call(h.app)
  assert.equal(h.storage.size, 0)
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.app.globalData.user, null)
  saveSession({ token: 'valid', user: { username: 'admin' } })
  appDefinition.onLaunch.call(h.app)
  assert.equal(h.app.globalData.token, 'valid')
})

test('both pages expose the same independent prototype and it has no auth or request side effect', () => {
  const h = harness()
  page(loginDefinition).openDrawingPrototype()
  page(indexDefinition).openDrawingPrototype()
  assert.deepEqual(h.navigations, [
    '/pages/drawing-prototype/drawing-prototype',
    '/pages/drawing-prototype/drawing-prototype'
  ])
  const prototype = page(prototypeDefinition)
  if (prototype.onLoad) prototype.onLoad()
  if (prototype.onShow) prototype.onShow()
  assert.equal(h.redirects.length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal(h.uploads.length, 0)
})

test('existing credential login still calls auth API and stores a complete session', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.onShow()
  login.onInput({ currentTarget: { dataset: { field: 'username' } }, detail: { value: 'member' } })
  login.submit()
  assert.equal(h.requests.length, 1)
  const req = h.requests[0]
  assert.equal(req.url, 'http://localhost:8080/api/auth/login')
  assert.equal(req.method, 'POST')
  assert.deepEqual(req.data, { username: 'member', password: 'admin123' })
  assert.equal(login.data.loading, true)
  const user = { username: 'member' }
  req.success({ data: { code: 0, data: { token: 'server-token', user } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.redirects, ['/pages/index/index'])
  assert.equal(h.storage.get('hdr_token'), 'server-token')
  assert.equal(h.storage.get('hdr_user'), user)
  assert.equal(h.app.globalData.user, user)
  assert.equal(login.data.loading, false)
})

test('incomplete login response is cleared without routing to index', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.submit()
  h.requests[0].success({ data: { code: 0, data: { token: 'missing-user' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.storage.size, 0)
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.app.globalData.user, null)
  assert.equal(h.redirects.length, 0)
  assert.match(h.toasts[0].title, /登录信息不完整/)
  assert.equal(login.data.loading, false)
})

test('empty credentials do not make requests and failed login is recoverable', async () => {
  const h = harness()
  const login = page(loginDefinition)
  login.setData({ password: '' })
  login.submit()
  assert.equal(h.requests.length, 0)
  login.setData({ password: 'wrong' })
  login.submit()
  h.requests[0].fail(new Error('offline'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(login.data.loading, false)
  assert.equal(h.redirects.length, 0)
})

test('logout clears both cache and global state; revisiting business index still requires login', () => {
  const h = harness({ hdr_token: 'token', hdr_user: { username: 'admin' } })
  const index = page(indexDefinition)
  index.onShow()
  index.logout()
  assert.equal(h.storage.size, 0)
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.app.globalData.user, null)
  index.onShow()
  assert.equal(index.data.user, null)
  assert.deepEqual(h.redirects, ['/pages/login/login', '/pages/login/login'])
})

test('request retains bearer authentication and API 401 clears the complete session', async () => {
  const h = harness({ hdr_token: 'token', hdr_user: { username: 'admin' } })
  readSession()
  const promise = request({ url: '/api/protected' })
  const rejection = assert.rejects(promise, (error) => error.code === 401)
  assert.equal(h.requests[0].header.Authorization, 'Bearer token')
  h.requests[0].success({ data: { code: 401, message: '登录过期' } })
  await rejection
  assert.equal(h.storage.size, 0)
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.app.globalData.user, null)
  assert.deepEqual(h.redirects, ['/pages/login/login'])
})

test('existing upload helper still authenticates and clears session on 401 (stub only)', async () => {
  const h = harness({ hdr_token: 'token', hdr_user: { username: 'admin' } })
  readSession()
  const promise = upload({ url: '/api/protected-upload', filePath: 'wxfile://stub.png' })
  const rejection = assert.rejects(promise, (error) => error.code === 401)
  assert.equal(h.uploads[0].header.Authorization, 'Bearer token')
  h.uploads[0].success({ data: JSON.stringify({ code: 401 }) })
  await rejection
  assert.equal(h.storage.size, 0)
  assert.equal(h.app.globalData.token, '')
  assert.deepEqual(h.redirects, ['/pages/login/login'])
})

test('session helpers reject incomplete writes and clear both halves', () => {
  const h = harness()
  assert.equal(saveSession({ token: 'only-token' }), false)
  assert.equal(readSession(), null)
  assert.equal(saveSession({ token: 'valid', user: { username: 'member' } }), true)
  assert.equal(h.storage.size, 2)
  clearSession()
  assert.equal(h.storage.size, 0)
})
