const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const { resolveRuntime } = require('../config/runtime')
const publicConfig = require('../config/public')
const { STORAGE_KEY, readSession, saveSession, snapshot, selectWorkspace, isSessionCurrent } = require('../utils/session')
const { request, upload, TIMEOUT_MS } = require('../utils/request')
const { createCanvasStub } = require('./helpers/canvas-stub')

function definition(path, kind = 'Page') {
  let value
  global[kind] = (data) => { value = data }
  delete require.cache[require.resolve(path)]
  require(path)
  delete global[kind]
  return value
}
const definitions = Object.fromEntries(['login', 'register', 'index', 'account', 'help', 'privacy']
  .map((name) => [name, definition(`../pages/${name}/${name}`)]))
const appDefinition = definition('../app', 'App')
const boardDefinition = definition('../components/drawing-board/drawing-board', 'Component')
// Syntactic fixtures only. Every network operation is captured by wx stubs; these are not deployment domains.
const pilotConfig = { mode: 'pilot', apiBaseUrl: 'https://api.synthetic-fixture.net', operator: '测试维护者', contact: '测试联系入口', privacyVersion: 'unit-fixture-v1' }
const user = { id: '9007199254740993', username: 'member', nickname: '普通成员', platformRole: 'USER' }
const identity = { user, defaultWorkspaceId: '9007199254741001' }
const spaces = [
  { id: identity.defaultWorkspaceId, name: '个人空间', role: 'OWNER', status: 'ACTIVE', defaultModelId: '9007199254741011' },
  { id: '9007199254741002', name: '其他空间', role: 'MEMBER', status: 'ACTIVE', defaultModelId: '9007199254741011' }
]
const credentials = { username: 'member', password: 'typed-password', confirmation: 'typed-password', nickname: '试用者', pilotCode: 'typed-invite-fixture' }
const passwords = { currentPassword: ' old password ', newPassword: 'new-password', confirmation: 'new-password' }
const flush = () => new Promise((resolve) => setImmediate(resolve))
function success(options, data, statusCode = 200) { options.success({ statusCode, data: { code: 0, data } }) }
function fail(options, statusCode) { options.success({ statusCode, data: { code: statusCode, message: `error-${statusCode}`, data: null } }) }
function mount(name) {
  return { ...definitions[name], data: structuredClone(definitions[name].data),
    updates: [], selectComponent() { return this.board || null },
    setData(patch) { assert.notEqual(this.unloaded, true, 'No setData after unload'); this.updates.push(patch); Object.assign(this.data, patch) } }
}
function harness({ config = pilotConfig, env = 'trial', cache = {} } = {}) {
  const storage = new Map(Object.entries(cache))
  const app = { globalData: structuredClone(appDefinition.globalData), _runtimeOptions: { publicConfig: { ...config } } }
  const requests = [], uploads = [], redirects = [], navigations = [], exports = []
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }),
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
    request: (options) => { requests.push(options); return { abort() { options.aborted = true } } },
    uploadFile: (options) => { uploads.push(options); return { abort() { options.aborted = true } } },
    reLaunch: ({ url }) => redirects.push(url), navigateTo: ({ url }) => navigations.push(url),
    getWindowInfo: () => ({ pixelRatio: 2 }), showToast: () => assert.fail('No unsolicited toast'),
    canvasToTempFilePath: (options) => exports.push(options),
    getRandomValues: (options) => options.success({ randomValues: new Uint8Array(16).fill(1).buffer })
  }
  global.wx = wx
  global.getApp = () => app
  appDefinition.onLaunch.call(app)
  return { app, storage, requests, uploads, redirects, navigations, exports, wx }
}
function mountBoard(owner) {
  const raster = createCanvasStub()
  const board = { ...boardDefinition.methods, data: { ...structuredClone(boardDefinition.data), simple: true },
    setData(patch) { Object.assign(this.data, patch) }, triggerEvent(name, detail) { owner.onDrawingChange({ detail }) },
    createSelectorQuery() { return { select() { return this }, fields() { return this }, exec(callback) { callback([{ node: raster.canvas, width: 100, height: 80 }]) } } }
  }
  owner.board = board
  boardDefinition.lifetimes.attached.call(board)
  boardDefinition.lifetimes.ready.call(board)
  return board
}
async function accountPage(h) {
  saveSession({ token: 'token-A', ...identity })
  const account = mount('account')
  const pending = account.onShow()
  success(h.requests.at(-1), identity)
  await pending
  return account
}
function fillRegistration(page, patch = {}) { page.setData({ ...credentials, ...patch }) }
function assertRegistrationCleared(page) {
  assert.equal(page.data.password, '')
  assert.equal(page.data.confirmation, '')
  assert.equal(page.data.pilotCode, '')
}
function assertPasswordCleared(page) {
  for (const field of ['currentPassword', 'newPassword', 'confirmation']) assert.equal(page.data[field], '')
}
afterEach(() => { delete global.wx; delete global.getApp })

test('public configuration exports the exact non-secret development template', () => {
  assert.deepEqual(publicConfig, { mode: 'development', apiBaseUrl: 'http://127.0.0.1:8080', operator: '', contact: '', privacyVersion: '' })
  assert.equal(resolveRuntime({ envVersion: 'develop' }).networkAllowed, true)
  assert.equal('prototypeAllowed' in resolveRuntime({ envVersion: 'develop' }), false)
})

for (const env of ['', 'unknown', undefined, 'develop', 'trial', 'release']) {
  test(`runtime resolves actual wx environment ${String(env)} without guessing a default`, () => {
    const runtime = resolveRuntime({ publicConfig: pilotConfig, wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }) } })
    assert.equal(runtime.networkAllowed, ['develop', 'trial', 'release'].includes(env))
    assert.equal('prototypeAllowed' in runtime, false)
  })
}
test('missing or throwing wx environment API fails closed', () => {
  for (const wx of [{}, { getAccountInfoSync() { throw new Error('missing') } }]) {
    assert.equal(resolveRuntime({ publicConfig: pilotConfig, wx }).networkAllowed, false)
  }
})
for (const [label, patch] of [
  ['HTTP', { apiBaseUrl: 'http://api.synthetic-fixture.net' }],
  ['loopback', { apiBaseUrl: 'https://127.0.0.1:8080' }],
  ['localhost', { apiBaseUrl: 'https://localhost' }],
  ['IPv6', { apiBaseUrl: 'https://[::1]' }],
  ['integer IP', { apiBaseUrl: 'https://2130706433' }],
  ['example domain', { apiBaseUrl: 'https://api.example.com' }],
  ['reserved test', { apiBaseUrl: 'https://api.hdr.test' }],
  ['placeholder', { apiBaseUrl: 'https://your-domain.com' }],
  ['userinfo', { apiBaseUrl: 'https://user@api.synthetic-fixture.net' }],
  ['path', { apiBaseUrl: 'https://api.synthetic-fixture.net/api/v2' }],
  ['query', { apiBaseUrl: 'https://api.synthetic-fixture.net?secret=1' }],
  ['backslash', { apiBaseUrl: 'https://api.synthetic-fixture.net\\other' }],
  ['port', { apiBaseUrl: 'https://api.synthetic-fixture.net:99999' }],
  ['missing address', { apiBaseUrl: '' }], ['missing mode', { mode: '' }],
  ['development release', { mode: 'development' }],
  ['operator', { operator: '' }], ['contact', { contact: '  ' }], ['privacyVersion', { privacyVersion: '' }],
  ['placeholder metadata', { operator: 'TODO' }], ['private suffix', { apiBaseUrl: 'https://api.private' }],
  ['extra public field', { extraField: 'unsupported' }], ['missing public field', { contact: undefined }]
]) {
  test(`trial/release configuration blocks ${label} before request and upload`, async () => {
    for (const env of ['trial', 'release']) {
      const h = harness({ config: { ...pilotConfig, ...patch }, env })
      for (const send of [request, upload]) await assert.rejects(send({ url: '/api/v2/auth/me' }), (error) => error.configuration)
      assert.equal(h.requests.length + h.uploads.length, 0)
    }
  })
}
test('develop mode permits configured localhost and LAN while pilot requires HTTPS even in develop', () => {
  for (const apiBaseUrl of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://192.168.1.10:8080']) {
    assert.equal(resolveRuntime({ envVersion: 'develop', publicConfig: { ...publicConfig, apiBaseUrl } }).networkAllowed, true)
    assert.equal(resolveRuntime({ envVersion: 'develop', publicConfig: { ...pilotConfig, apiBaseUrl } }).networkAllowed, false)
  }
})
test('origin parser canonicalizes case, root slash and default port but never credentials', () => {
  const runtime = resolveRuntime({ envVersion: 'release', publicConfig: { ...pilotConfig, apiBaseUrl: 'HTTPS://API.SYNTHETIC-FIXTURE.NET:443/' } })
  assert.equal(runtime.apiBaseUrl, pilotConfig.apiBaseUrl)
  assert.equal(runtime.networkAllowed, true)
})

for (const name of ['login', 'register', 'index', 'account']) {
  test(`${name} shows a useful configuration error without network or redirect loops`, async () => {
    const h = harness({ config: publicConfig, env: 'release' })
    const page = mount(name)
    await page.onShow()
    assert.match(page.data.configurationError, /服务未配置/)
    if (page.submit) await page.submit()
    assert.equal(h.requests.length + h.uploads.length, 0)
    assert.equal(h.redirects.length, 0)
  })
}
for (const name of ['help', 'privacy']) {
  test(`${name} remains readable offline with explicit unconfigured operator/contact`, () => {
    const h = harness({ config: publicConfig, env: 'unknown' })
    const page = mount(name)
    page.onShow()
    assert.match(page.data.operator, /未配置/)
    assert.match(page.data.contact, /未配置/)
    assert.equal(h.requests.length + h.uploads.length, 0)
    assert.equal(h.redirects.length, 0)
  })
}
for (const cache of [{ token: 'unbound' }, { token: 'foreign', origin: 'https://other.synthetic-fixture.net' }]) {
  test('unbound or foreign-origin cache is discarded without sending its token', () => {
    const h = harness({ cache: { [STORAGE_KEY]: cache } })
    assert.equal(readSession(), null)
    assert.equal(h.storage.size, 0)
    mount('login').onShow()
    assert.equal(h.requests.length, 0)
  })
}
for (const kind of ['request', 'upload']) {
  test(`${kind} origin changes discard candidates and stale responses, including A-B-A`, async () => {
    const h = harness()
    saveSession({ token: 'old-secret', ...identity })
    const old = snapshot()
    const pending = (kind === 'request' ? request : upload)({ url: '/api/v2/auth/me', snapshot: old })
    const rejected = assert.rejects(pending, (error) => error.stale)
    const oldOptions = (kind === 'request' ? h.requests : h.uploads)[0]
    h.app._runtimeOptions.publicConfig.apiBaseUrl = 'https://other.synthetic-fixture.net'
    assert.equal(readSession(), null)
    assert.equal(h.storage.has(STORAGE_KEY), false)
    h.app._runtimeOptions.publicConfig.apiBaseUrl = pilotConfig.apiBaseUrl
    assert.equal(readSession(), null)
    saveSession({ token: 'replacement', ...identity })
    assert.equal(isSessionCurrent(old), false)
    fail(oldOptions, 401)
    await rejected
    assert.equal(h.app.globalData.token, 'replacement')
    assert.equal(h.redirects.length, 0)
    const next = request({ url: '/api/v2/auth/me' })
    assert.equal(h.requests.at(-1).header.Authorization, 'Bearer replacement')
    success(h.requests.at(-1), identity)
    await next
  })
}
test('a service change cannot forward old bearer even when caller supplies an old snapshot', async () => {
  const h = harness()
  saveSession({ token: 'old-secret', ...identity })
  const old = snapshot()
  h.app._runtimeOptions.publicConfig.apiBaseUrl = 'https://other.synthetic-fixture.net'
  await assert.rejects(request({ url: '/api/v2/auth/me', snapshot: old }), (error) => error.stale)
  assert.equal(h.requests.length, 0)
  assert.equal(h.app.globalData.token, '')
  const next = request({ url: '/api/v2/auth/me' })
  assert.equal(h.requests[0].header.Authorization, undefined)
  success(h.requests[0], identity)
  await next
})

test('actual registration posts v2 exact data once, clears invite, and waits for /me before drawing', async () => {
  const h = harness()
  const register = mount('register')
  register.onShow()
  fillRegistration(register)
  const pending = register.submit()
  register.submit()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, pilotConfig.apiBaseUrl + '/api/v2/auth/register')
  assert.equal(h.requests[0].method, 'POST')
  assert.equal(h.requests[0].header.Authorization, undefined)
  assert.deepEqual(h.requests[0].data, { username: credentials.username, password: credentials.password, nickname: credentials.nickname, pilotCode: credentials.pilotCode })
  assert.equal(Object.hasOwn(h.requests[0].data, 'confirmation'), false)
  success(h.requests[0], { token: 'registered', ...identity }, 201)
  await flush()
  assertRegistrationCleared(register)
  assert.equal(h.app.globalData.verified, false)
  assert.equal(h.redirects.length, 0)
  assert.equal(h.requests[1].url, pilotConfig.apiBaseUrl + '/api/v2/auth/me')
  success(h.requests[1], identity)
  await pending
  assert.deepEqual(h.redirects, ['/pages/index/index'])
  assert.deepEqual(h.storage.get(STORAGE_KEY), { token: 'registered', origin: pilotConfig.apiBaseUrl })
  assertRegistrationCleared(register)
})

test('development registration permits omitted invite/nickname without introducing a second API', async () => {
  const h = harness({ config: publicConfig, env: 'develop' })
  const register = mount('register')
  register.onShow()
  fillRegistration(register, { pilotCode: '', nickname: '' })
  const pending = register.submit()
  assert.deepEqual(h.requests[0].data, { username: credentials.username, password: credentials.password })
  fail(h.requests[0], 400)
  await pending
  assertRegistrationCleared(register)
})

for (const [field, value] of [['confirmation', 'mismatch'], ['pilotCode', ''], ['nickname', 'n'.repeat(65)], ['username', 'ab'], ['username', 'a'.repeat(33)], ['password', 'short'], ['password', 'a'.repeat(33)]]) {
  test(`actual registration rejects invalid ${field} locally, without retaining sensitive fields`, async () => {
    const h = harness()
    const register = mount('register')
    register.onShow()
    fillRegistration(register, { [field]: value })
    await register.submit()
    assert.ok(register.data.error)
    assert.equal(h.requests.length, 0)
    assertRegistrationCleared(register)
  })
}

test('every contract Unicode whitespace is rejected for new registration/password, not silently trimmed', async () => {
  const h = harness()
  const account = await accountPage(h)
  const register = mount('register')
  register.onShow()
  // Explicit independent contract list, rather than reusing the implementation regex.
  const points = [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]
  const before = h.requests.length
  for (const code of points) {
    const whitespace = String.fromCodePoint(code)
    for (const field of ['username', 'password']) {
      fillRegistration(register, { [field]: `abc${whitespace}def`, ...(field === 'password' ? { confirmation: `abc${whitespace}def` } : {}) })
      await register.submit()
      assert.match(register.data.error, /空白/, `${field} rejects U+${code.toString(16)}`)
    }
    account.setData({ ...passwords, newPassword: `abc${whitespace}def`, confirmation: `abc${whitespace}def` })
    await account.submit()
    assert.match(account.data.error, /空白/, `newPassword rejects U+${code.toString(16)}`)
  }
  assert.equal(h.requests.length, before)
})
test('legacy login sends surrounding/internal whitespace byte-for-byte', async () => {
  const h = harness()
  const login = mount('login')
  login.onShow()
  login.setData({ username: ' old user ', password: ' old password ' })
  const pending = login.submit()
  assert.deepEqual(h.requests[0].data, { username: ' old user ', password: ' old password ' })
  fail(h.requests[0], 400)
  await pending
  assert.equal(login.data.password, '')
})

test('new credentials use exactly the whitespace list, allow boundary lengths, and leave invite unchanged', async () => {
  const h = harness()
  const register = mount('register')
  register.onShow()
  const password = 'p'.repeat(31) + String.fromCodePoint(0x200b)
  fillRegistration(register, { username: 'abc', password, confirmation: password, nickname: 'n'.repeat(64), pilotCode: ' invite with spaces ' })
  const pending = register.submit()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].data.password, password)
  assert.equal(h.requests[0].data.pilotCode, ' invite with spaces ')
  fail(h.requests[0], 400)
  await pending
  assertRegistrationCleared(register)
})

test('malformed registration success cannot save an unverified identity or stick loading', async () => {
  const h = harness()
  const register = mount('register')
  register.onShow()
  fillRegistration(register)
  const pending = register.submit()
  success(h.requests[0], { token: 'incomplete' }, 201)
  await pending
  assert.match(register.data.error, /响应不完整/)
  assert.equal(h.app.globalData.token, '')
  assert.equal(register.data.loading, false)
  assertRegistrationCleared(register)
})

test('old registration finalizer cannot clear a newer attempt after hide/show', async () => {
  const h = harness()
  const register = mount('register')
  register.onShow()
  fillRegistration(register)
  const old = register.submit()
  register.onHide()
  register.onShow()
  fillRegistration(register, { password: 'replacement-password', confirmation: 'replacement-password' })
  const next = register.submit()
  fail(h.requests[0], 401)
  await old
  assert.equal(register.data.loading, true)
  assert.equal(register.data.password, 'replacement-password')
  assert.equal(register.data.error, '')
  fail(h.requests[1], 429)
  await next
  assertRegistrationCleared(register)
  assert.equal(register.data.loading, false)
})

for (const status of [400, 403, 409, 429, 503]) {
  test(`registration HTTP ${status} is visible, clears secrets, and does not retry`, async () => {
    const h = harness()
    const register = mount('register')
    register.onShow()
    fillRegistration(register)
    const pending = register.submit()
    fail(h.requests[0], status)
    await pending
    assert.match(register.data.error, new RegExp(String(status)))
    assert.equal(register.data.loading, false)
    assertRegistrationCleared(register)
    assert.equal(h.storage.size, 0)
    assert.equal(h.requests.length, 1)
  })
}
for (const stage of ['register', 'me']) {
  for (const callback of ['success', '401', 'network']) {
    test(`registration ${stage} late ${callback} cannot alter a replacement login or unloaded page`, async () => {
      const h = harness()
      const register = mount('register')
      register.onShow()
      fillRegistration(register)
      const pending = register.submit()
      if (stage === 'me') { success(h.requests[0], { token: 'registered', ...identity }, 201); await flush() }
      const old = h.requests.at(-1)
      register.onUnload()
      register.unloaded = true
      assertRegistrationCleared(register)
      saveSession({ token: 'replacement', ...identity })
      if (callback === 'success') success(old, stage === 'me' ? identity : { token: 'late', ...identity }, stage === 'me' ? 200 : 201)
      if (callback === '401') fail(old, 401)
      if (callback === 'network') old.fail({ errMsg: 'offline' })
      await pending
      assert.equal(h.app.globalData.token, 'replacement')
      assert.equal(h.app.globalData.verified, false)
      assert.equal(h.redirects.length, 0)
      assert.equal(old.aborted, true)
    })
  }
}

test('account requires fresh /me, sends legacy current password unchanged, clears all local state on null success', async () => {
  const h = harness()
  const account = await accountPage(h)
  assert.equal(account.data.authorized, true)
  account.setData(passwords)
  const pending = account.submit()
  account.submit()
  const options = h.requests.at(-1)
  assert.equal(h.requests.length, 2)
  assert.equal(options.url, pilotConfig.apiBaseUrl + '/api/v2/auth/password')
  assert.equal(options.method, 'POST')
  assert.equal(options.header.Authorization, 'Bearer token-A')
  assert.deepEqual(options.data, { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword })
  success(options, null)
  await pending
  assertPasswordCleared(account)
  assert.equal(h.app.globalData.token, '')
  assert.equal(h.app.globalData.workspaceId, '')
  assert.equal(h.app.globalData.verified, false)
  assert.equal(h.storage.size, 0)
  assert.equal(account.data.authorized, false)
  assert.deepEqual(h.redirects, ['/pages/login/login'])
})
for (const status of [400, 401, 429, 503]) {
  test(`account HTTP ${status} clears secrets; only 401 clears its current session`, async () => {
    const h = harness()
    const account = await accountPage(h)
    account.setData(passwords)
    const pending = account.submit()
    fail(h.requests.at(-1), status)
    await pending
    assertPasswordCleared(account)
    assert.equal(h.app.globalData.token, status === 401 ? '' : 'token-A')
    assert.equal(h.redirects.length, status === 401 ? 1 : 0)
    if (status !== 401) assert.match(account.data.error, new RegExp(String(status)))
    assert.equal(account.data.loading, false)
    assert.equal(h.requests.length, 2)
  })
}
for (const data of [undefined, {}, { success: true }]) {
  test('account rejects malformed success instead of claiming password changed', async () => {
    const h = harness()
    const account = await accountPage(h)
    account.setData(passwords)
    const pending = account.submit()
    success(h.requests.at(-1), data)
    await pending
    assert.match(account.data.error, /响应格式错误/)
    assert.equal(h.app.globalData.token, 'token-A')
    assert.equal(h.redirects.length, 0)
    assertPasswordCleared(account)
  })
}
for (const [field, value] of [['confirmation', 'mismatch'], ['currentPassword', '     '], ['newPassword', 'short'], ['newPassword', 'a'.repeat(33)]]) {
  test(`account ${field} validation makes no password request`, async () => {
    const h = harness()
    const account = await accountPage(h)
    account.setData({ ...passwords, [field]: value })
    await account.submit()
    assert.ok(account.data.error)
    assert.equal(h.requests.length, 1)
    assertPasswordCleared(account)
  })
}
for (const mutation of ['hide', 'unload', 'new-session', 'logout']) {
  for (const callback of ['success', '401', 'network']) {
    test(`account old ${callback} after ${mutation} never clears a newer session or changes page state`, async () => {
      const h = harness()
      const account = await accountPage(h)
      account.setData(passwords)
      const pending = account.submit()
      const old = h.requests.at(-1)
      if (mutation === 'hide') account.onHide()
      if (mutation === 'unload') { account.onUnload(); account.unloaded = true }
      if (mutation === 'logout') account.logout()
      saveSession({ token: 'replacement', ...identity })
      const before = structuredClone(account.data), redirects = h.redirects.length
      if (callback === 'success') success(old, null)
      if (callback === '401') fail(old, 401)
      if (callback === 'network') old.fail({ errMsg: 'offline' })
      await pending
      assert.deepEqual(account.data, before)
      assertPasswordCleared(account)
      assert.equal(h.app.globalData.token, 'replacement')
      assert.equal(h.redirects.length, redirects)
      assert.equal(old.aborted, true)
    })
  }
}
for (const name of ['register', 'account']) {
  test(`${name} timeout completes visibly, clears sensitive inputs, and never retries`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    const page = name === 'account' ? await accountPage(h) : mount('register')
    if (name === 'register') { page.onShow(); fillRegistration(page) } else page.setData(passwords)
    const before = h.requests.length
    const pending = page.submit()
    t.mock.timers.tick(TIMEOUT_MS)
    await pending
    assert.match(page.data.error, /超时/)
    assert.equal(page.data.loading, false)
    if (name === 'account') assertPasswordCleared(page)
    else assertRegistrationCleared(page)
    assert.equal(h.requests.length, before + 1)
    assert.equal(h.requests.at(-1).aborted, true)
  })
}

test('anonymous drawing entry is removed while login stays network-free', () => {
  const h = harness()
  const login = mount('login')
  login.onShow()
  assert.equal(login.openDrawingPrototype, undefined)
  assert.equal(mount('index').openDrawingPrototype, undefined)
  assert.equal(require('../app.json').pages.some((path) => path.includes('drawing-prototype')), false)
  assert.equal(h.navigations.length, 0)
  assert.equal(h.redirects.length, 0)
  assert.equal(h.requests.length + h.uploads.length, 0)
})
test('pilot verifies server default workspace, ignores prior selection and blocks programmatic switching', async () => {
  const h = harness()
  saveSession({ token: 'token-A', ...identity })
  selectWorkspace(spaces[1].id)
  const index = mount('index')
  const pending = index.onShow()
  success(h.requests[0], identity)
  await flush()
  assert.equal(index.data.workspaceReady, false)
  success(h.requests[1], [spaces[1], spaces[0]])
  await flush()
  assert.equal(h.requests[2].url, `${pilotConfig.apiBaseUrl}/api/v2/workspaces/${identity.defaultWorkspaceId}`)
  success(h.requests[2], spaces[0])
  await pending
  assert.equal(index.data.workspaceReady, true)
  assert.equal(index.data.workspace.id, identity.defaultWorkspaceId)
  assert.equal(index.data.pilot, true)
  await index.onWorkspaceChange({ detail: { value: 0 } })
  await index._chooseWorkspace(spaces[1].id)
  assert.equal(h.requests.length, 3)
  assert.equal(index.toggleDetails, undefined)
  const board = mountBoard(index)
  const touch = { x: 20, y: 20, identifier: 1 }
  board.onTouchStart({ touches: [touch] }); board.onTouchEnd({ changedTouches: [touch] })
  const recognition = index.recognize()
  h.exports[0].success({ tempFilePath: 'wxfile://actual-component-stub.png' })
  await flush()
  const options = h.uploads[0]
  assert.equal(options.url, `${pilotConfig.apiBaseUrl}/api/v2/workspaces/${identity.defaultWorkspaceId}/recognitions`)
  assert.deepEqual(options.formData, { source: 'MINIPROGRAM' })
  assert.equal(options.name, 'image')
  success(options, { recognitionId: '9007199254741111', requestId: options.header['Idempotency-Key'], digit: 7, confidence: 0.98,
    modelId: spaces[0].defaultModelId, modelVersion: 'w2-canvas-photo-3epoch', preprocessVersion: 'adaptive-mnist-v2', source: 'MINIPROGRAM', processingMs: 12, createdAt: '2026-11-04T00:00:00Z' })
  await recognition
  assert.equal(index.data.result.digit, 7)
  assert.equal(index.data.recognizing, false)
})
test('pilot never falls back to another workspace when default is missing from server list', async () => {
  const h = harness()
  saveSession({ token: 'token-A', ...identity })
  const index = mount('index')
  const pending = index.onShow()
  success(h.requests[0], identity)
  await flush()
  success(h.requests[1], [spaces[1]])
  await pending
  assert.equal(index.data.workspaceReady, false)
  assert.match(index.data.error, /默认个人空间不可访问/)
  assert.equal(h.requests.length, 2)
  assert.equal(h.app.globalData.workspaceId, '')
})
