import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHistory, createRouter } from 'vue-router'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compile, createSSRApp, h } from 'vue'
import { parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { readAppConfig, assertPublishable } from '../src/config.js'
import { createRoutes, navigationLinks } from '../src/router/routes.js'
import { createAuthGuard, safeRedirect } from '../src/router/auth-guard.js'
import { createSession, TOKEN_KEY } from '../src/auth/session.js'
import { authPayload, passwordPayload } from '../src/auth/validation.js'
import { createAuthFormController } from '../src/auth/form-controller.js'
import { createPasswordController } from '../src/auth/password-controller.js'
import { createWorkspaceContext } from '../src/workspace/context.js'
import { createRecognitionController } from '../src/recognition/controller.js'
import request from '../src/api/request.js'
import { changePassword as passwordApi } from '../src/api/auth.js'

const me = { user: { id: 'u1', username: 'ordinary', platformRole: 'USER' }, defaultWorkspaceId: 'default' }
const space = (id) => ({ id, name: id, role: 'OWNER', status: 'ACTIVE' })
function memory(cache = {}) {
  const values = new Map(Object.entries(cache))
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(overrides = {}, cache = { [TOKEN_KEY]: 'same-token' }) {
  const storage = memory(cache)
  const session = createSession({ storage, getMe: async () => me, login: async () => ({ token: 'same-token' }),
    register: async () => ({ token: 'registered-token', defaultWorkspaceId: 'untrusted' }), changePassword: async () => null, ...overrides })
  return { session, storage }
}
// Production route records and guards; replace only .vue rendering for Node's memory router.
function routerFor(session, pilot) {
  const renderless = (route) => ({ ...route, ...(route.component ? { component: {} } : {}), ...(route.children ? { children: route.children.map(renderless) } : {}) })
  const router = createRouter({ history: createMemoryHistory(), routes: createRoutes({ pilot }).map(renderless) })
  router.beforeEach(createAuthGuard({ session, pilot, resolve: (value) => router.resolve(value) }))
  return router
}
const registration = () => ({ username: 'ordinary', password: 'secret1', confirmPassword: 'secret1', nickname: 'Name', pilotCode: randomUUID() })
const passwords = () => ({ currentPassword: 'old pass', newPassword: 'newpass' })

test('public configuration defaults to W2; incomplete pilot publication is blocked, not local parsing', () => {
  assert.equal(readAppConfig().mode, 'development')
  assert.doesNotThrow(() => assertPublishable(readAppConfig()))
  assert.equal(readAppConfig({ VITE_APP_MODE: 'pilot' }).operator, '')
  assert.throws(() => assertPublishable(readAppConfig({ VITE_APP_MODE: 'pilot' })), /VITE_PILOT_OPERATOR/)
  assert.throws(() => readAppConfig({ VITE_APP_MODE: 'unknown' }), /development 或 pilot/)
  const env = { VITE_APP_MODE: 'pilot', VITE_PILOT_OPERATOR: '维护者', VITE_PILOT_CONTACT: '人工联系渠道', VITE_PILOT_PRIVACY_VERSION: 'local-test' }
  assert.doesNotThrow(() => assertPublishable(readAppConfig(env)))
  for (const key of ['VITE_PILOT_OPERATOR', 'VITE_PILOT_CONTACT', 'VITE_PILOT_PRIVACY_VERSION']) {
    assert.throws(() => assertPublishable(readAppConfig({ ...env, [key]: ' ' })))
  }
  assert.deepEqual(Object.keys(readAppConfig(env)).sort(), ['contact', 'mode', 'operator', 'pilot', 'privacyVersion'])
})

test('pilot production routes block every hidden direct URL even for verified platform operators', async () => {
  for (const role of ['USER', 'SUPER_ADMIN']) {
    const { session } = fixture({ getMe: async () => ({ ...me, user: { ...me.user, platformRole: role } }) })
    const router = routerFor(session, true)
    for (const path of ['/home', '/assets', '/usage', '/training', '/platform', '/app', '/home?create=1', '/PLATFORM', '/assets/']) {
      await router.push(path)
      assert.equal(router.currentRoute.value.path, '/recognize', path)
    }
    for (const path of ['/account', '/help', '/privacy', '/recognize']) {
      await router.push(path)
      assert.equal(router.currentRoute.value.path, path)
    }
    assert.deepEqual(navigationLinks({ pilot: true, superAdmin: role === 'SUPER_ADMIN' }).map(([path]) => path), ['/recognize', '/account', '/help', '/privacy'])
  }
})

test('pilot public routes remain anonymous, protected routes verify cache with /me and always postlogin to drawing', async () => {
  const server = deferred()
  let calls = 0
  const { session } = fixture({ getMe: () => { calls += 1; return server.promise } }, { [TOKEN_KEY]: 'cached', hdr_v2_user: '{"platformRole":"SUPER_ADMIN"}' })
  const router = routerFor(session, true)
  for (const path of ['/', '/help', '/privacy', '/login', '/register']) await router.push(path)
  assert.equal(calls, 0)
  assert.equal(session.isAuthenticated, false)
  const navigation = router.push('/account')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(router.currentRoute.value.path, '/register')
  server.reject({ status: 401 })
  await navigation
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(router.currentRoute.value.query.redirect, '/recognize')
  for (const value of ['/account', '/home', '/platform', '//evil.test', '/%2f%2fevil.test', undefined]) {
    assert.equal(safeRedirect(value, (target) => router.resolve(target), { pilot: true }), '/recognize')
  }
})

test('development production routes, redirects and SUPER_ADMIN views retain W2 behavior', async () => {
  const { session } = fixture({ getMe: async () => ({ ...me, user: { ...me.user, platformRole: 'SUPER_ADMIN' } }) })
  const router = routerFor(session, false)
  await router.push('/app')
  assert.equal(router.currentRoute.value.path, '/home')
  for (const path of ['/home', '/assets', '/usage', '/training', '/platform', '/recognize']) {
    await router.push(path)
    assert.equal(router.currentRoute.value.path, path)
  }
  assert.equal(safeRedirect('/assets', (target) => router.resolve(target)), '/assets')
  assert.deepEqual(navigationLinks({ superAdmin: true }).map(([path]) => path), ['/home', '/recognize', '/assets', '/usage', '/training', '/platform'])
})

test('registration and new passwords reject the exact contract whitespace set without trimming', () => {
  const forbidden = [...Array.from({ length: 5 }, (_, i) => i + 9), 0x20, 0x85, 0xa0, 0x1680,
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
  for (const point of forbidden) {
    const char = String.fromCodePoint(point)
    for (const key of ['username', 'password']) {
      const form = { ...registration(), [key]: `aaa${char}bbb` }
      form.confirmPassword = form.password
      assert.throws(() => authPayload(form, { registering: true, pilot: true }), /空白字符/)
    }
    assert.throws(() => passwordPayload({ ...passwords(), newPassword: `aaa${char}bbb` }), /空白字符/)
    assert.equal(authPayload({ username: `abc${char}def`, password: `abc${char}def` }).password, `abc${char}def`)
    assert.equal(passwordPayload({ currentPassword: `abc${char}def`, newPassword: 'secret1' }).currentPassword, `abc${char}def`)
  }
  // U+200B is not in the contract; do not silently broaden the restriction.
  assert.equal(passwordPayload({ ...passwords(), newPassword: `aaa${String.fromCodePoint(0x200b)}bbb` }).newPassword.length, 7)
  assert.throws(() => authPayload({ username: '   ', password: '      ' }), /不能为空/)
  assert.throws(() => passwordPayload({ currentPassword: 'short', newPassword: 'secret1' }), /长度/)
  assert.throws(() => authPayload({ ...registration(), nickname: 'n'.repeat(65) }, { registering: true }), /64/)
})

test('pilot registration requires confirmation and user code; neither confirmation nor extra fields are sent', () => {
  const form = registration()
  const payload = authPayload({ ...form, role: 'SUPER_ADMIN' }, { registering: true, pilot: true })
  assert.deepEqual(Object.keys(payload).sort(), ['nickname', 'password', 'pilotCode', 'username'])
  assert.equal(payload.pilotCode, form.pilotCode)
  assert.throws(() => authPayload({ ...form, confirmPassword: 'different' }, { registering: true, pilot: true }), /不一致/)
  assert.throws(() => authPayload({ ...form, pilotCode: '' }, { registering: true, pilot: true }), /体验码/)
  assert.deepEqual(Object.keys(authPayload(form, { registering: true })).sort(), ['nickname', 'password', 'username'])
})

test('production auth controller permits old whitespace login unchanged and navigates only after /me', async () => {
  const server = deferred()
  let received, navigations = 0
  const { session } = fixture({ login: async (form) => { received = form; return { token: 'new' } }, getMe: () => server.promise }, {})
  const controller = createAuthFormController({ session, registering: () => false, pilot: true, onAuthenticated: () => { navigations += 1 } })
  Object.assign(controller.state.form, { username: ' old name ', password: ' old pass ' })
  const operation = controller.run()
  assert.deepEqual(received, { username: ' old name ', password: ' old pass ' })
  assert.equal(controller.state.form.password, '')
  assert.equal(navigations, 0)
  server.resolve(me)
  await operation
  assert.equal(navigations, 1)
  controller.dispose()
})

test('production registration controller never caches code; clears sensitive inputs on submit, hide and reset', async () => {
  const server = deferred()
  let received, navigations = 0
  const { session, storage } = fixture({ register: (form) => { received = form; return server.promise } }, {})
  const controller = createAuthFormController({ session, registering: () => true, pilot: true, onAuthenticated: () => { navigations += 1 } })
  const form = registration()
  Object.assign(controller.state.form, form)
  const operation = controller.run()
  await controller.run() // no duplicate POST
  assert.equal(received.pilotCode, form.pilotCode)
  for (const key of ['password', 'confirmPassword', 'pilotCode']) assert.equal(controller.state.form[key], '')
  assert.equal(storage.values.size, 0)
  server.resolve({ token: 'new', defaultWorkspaceId: 'forged' })
  await operation
  assert.equal(session.state.defaultWorkspaceId, 'default')
  assert.deepEqual([...storage.values.keys()], [TOKEN_KEY])
  assert.equal(navigations, 1)
  for (const action of ['clearSensitive', 'reset', 'dispose']) {
    Object.assign(controller.state.form, form)
    controller[action]()
    for (const key of ['password', 'confirmPassword', 'pilotCode']) assert.equal(controller.state.form[key], '')
  }
})

test('late auth form success, failure and finally cannot navigate or overwrite a switched form', async () => {
  for (const fail of [false, true]) {
    const old = deferred(), next = deferred()
    let calls = 0, navigations = 0
    const { session } = fixture({ login: () => ++calls === 1 ? old.promise : next.promise }, {})
    const controller = createAuthFormController({ session, registering: () => false, onAuthenticated: () => { navigations += 1 } })
    Object.assign(controller.state.form, registration())
    const previous = controller.run()
    controller.reset()
    Object.assign(controller.state.form, registration())
    const current = controller.run()
    if (fail) old.reject({ status: 400 }); else old.resolve({ token: 'old' })
    await previous
    assert.equal(controller.state.loading, true)
    assert.equal(controller.state.error, '')
    assert.equal(navigations, 0)
    next.resolve({ token: 'new' })
    await current
    assert.equal(navigations, 1)
    controller.dispose()
  }
})

test('pilot auto-selects verified server default only, not first, cached or preferred space', async () => {
  const detail = deferred()
  const { session } = fixture()
  await session.refresh()
  let fetched, creations = 0
  const workspace = createWorkspaceContext({ session, defaultOnly: true, list: async () => [space('other'), space('default')],
    get: (id) => { fetched = id; return detail.promise }, create: async () => { creations += 1 } })
  const loading = workspace.load('other')
  await Promise.resolve()
  assert.equal(fetched, 'default')
  assert.equal(workspace.state.active, null)
  detail.resolve(space('default'))
  await loading
  assert.equal(workspace.state.active.id, 'default')
  await workspace.createSpace('new')
  assert.equal(creations, 0)
  await workspace.select('other')
  assert.equal(workspace.state.active, null)
  assert.equal(fetched, 'default')
  workspace.dispose()
})

test('pilot default absence or failed membership never falls back or grants authority', async () => {
  for (const missing of [true, false]) {
    const { session } = fixture()
    await session.refresh()
    let gets = 0
    const workspace = createWorkspaceContext({ session, defaultOnly: true, list: async () => missing ? [space('other')] : [space('default')], get: async () => { gets += 1; throw { status: 404 } } })
    await workspace.load()
    assert.equal(workspace.state.active, null)
    assert.equal(session.isAuthenticated, true)
    assert.equal(gets, missing ? 0 : 1)
    assert.ok(workspace.state.error)
    workspace.dispose()
  }
})

test('pilot pending default membership response retains session-generation isolation', async () => {
  for (const fail of [false, true]) {
    const old = deferred()
    const { session } = fixture()
    await session.refresh()
    const workspace = createWorkspaceContext({ session, defaultOnly: true, list: async () => [space('default')], get: () => old.promise })
    const operation = workspace.load()
    await Promise.resolve()
    await session.login({}) // even with an identical token
    if (fail) old.reject({ status: 404 }); else old.resolve(space('default'))
    await operation
    assert.equal(workspace.state.active, null)
    assert.equal(workspace.state.error, '')
    assert.equal(workspace.state.loading, false)
    workspace.dispose()
  }
})

async function renderTemplate(file, state) {
  const { descriptor } = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'))
  const app = createSSRApp({ data: () => state, render: compile(descriptor.template.content) })
  app.component('router-link', { props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })
  return renderToString(app)
}

test('production result template collapses technical details only in pilot and keeps digit, confidence and time visible', async () => {
  const state = { loading: false, error: '', hasInk: true, result: { digit: 7, confidence: 0.97, processingMs: 18,
    modelId: '1', modelVersion: 'real-version', preprocessVersion: 'real-preprocessing', source: 'WEB', recognitionId: 'r1', requestId: 'request1', createdAt: '2026-11-04' } }
  const renderState = { state, boardError: '', canSubmit: true, canvas: null, board: null, controller: {} }
  const pilot = await renderTemplate('views/Recognize.vue', { ...renderState, pilot: true })
  const development = await renderTemplate('views/Recognize.vue', { ...renderState, pilot: false })
  const visible = pilot.replace(/<details\b[\s\S]*?<\/details>/g, '')
  assert.match(visible, /data-testid="recognized-digit">7</)
  assert.match(visible, /97.00%/)
  assert.match(visible, /18 ms/)
  assert.doesNotMatch(visible, /real-version|request1/)
  assert.match(pilot, /<details><summary>/)
  assert.doesNotMatch(pilot, /<details[^>]*\bopen/)
  assert.doesNotMatch(development, /<details[ >]/)
  assert.match(development, /real-version/)
})

test('production pilot navigation and public privacy template show only supported routes and honest unconfigured/manual retention text', async () => {
  const pilotLinks = navigationLinks({ pilot: true })
  const portal = await renderTemplate('views/Portal.vue', { appConfig: readAppConfig({ VITE_APP_MODE: 'pilot' }), pilotLinks, user: {} })
  for (const hidden of ['/home', '/assets', '/usage', '/training', '/platform']) assert.doesNotMatch(portal, new RegExp(`href="${hidden}"`))
  for (const path of ['/recognize', '/account', '/help', '/privacy']) assert.ok(portal.includes(`href="${path}"`))
  const privacy = await renderTemplate('views/Support.vue', { privacy: true, appConfig: readAppConfig({ VITE_APP_MODE: 'pilot' }), links: pilotLinks })
  for (const text of ['未配置', '30 天', '7 天', '不是已实现的自动清理承诺', '人工办理', '临时文件', '不长期保存原图', '不用于训练', '不收集手机号', '退出登录不等于删除账号']) assert.ok(privacy.includes(text), text)
})

async function passwordFixture(api) {
  const { session, storage } = fixture({ changePassword: api })
  await session.refresh()
  const redirects = []
  const controller = createPasswordController({ session, onReauthenticate: (reason) => { redirects.push(reason) } })
  Object.assign(controller.state.form, passwords())
  return { session, storage, controller, redirects }
}

test('password success sends one exact payload and captured session, waits for server then clears all local scopes', async () => {
  const server = deferred()
  let calls = 0, auth, payload
  const { session, storage, controller, redirects } = await passwordFixture((form, snapshot) => { calls += 1; payload = form; auth = snapshot; return server.promise })
  const workspace = createWorkspaceContext({ session, defaultOnly: true, list: async () => [space('default')], get: async () => space('default') })
  await workspace.load()
  const recognition = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']), send: async () => {} })
  recognition.drawingChanged({ hasInk: true })
  const before = session.getSnapshot()
  const operation = controller.submit()
  await controller.submit()
  assert.equal(calls, 1)
  assert.deepEqual(payload, passwords())
  assert.deepEqual(auth, before)
  assert.equal(controller.state.form.currentPassword, '')
  assert.equal(controller.state.form.newPassword, '')
  assert.equal(session.isAuthenticated, true)
  assert.equal(workspace.state.active.id, 'default')
  server.resolve(null)
  await operation
  assert.equal(session.isAuthenticated, false)
  assert.equal(storage.getItem(TOKEN_KEY), null)
  assert.equal(workspace.state.active, null)
  assert.equal(recognition.canSubmit(), false)
  assert.deepEqual(redirects, ['password-changed'])
  controller.dispose(); recognition.dispose(); workspace.dispose()
})

test('password wrong current password, rate limits and uncertain network errors preserve current session without retry', async () => {
  for (const error of [{ status: 400, message: '原密码错误' }, { status: 429, retryAfter: '10' }, new Error('Network Error')]) {
    let calls = 0
    const { session, controller, redirects } = await passwordFixture(async () => { calls += 1; throw error })
    await controller.submit()
    assert.equal(calls, 1)
    assert.equal(session.isAuthenticated, true)
    assert.equal(controller.state.loading, false)
    assert.ok(controller.state.error)
    assert.deepEqual(redirects, [])
    assert.equal(controller.state.form.currentPassword, '')
    assert.equal(controller.state.form.newPassword, '')
    controller.dispose()
  }
})

test('password validation errors never dispatch and do not pretend a request was sent', async () => {
  let calls = 0
  const { session, controller } = await passwordFixture(async () => { calls += 1; return null })
  controller.state.form.newPassword = 'bad pass'
  await controller.submit()
  assert.equal(calls, 0)
  assert.equal(session.isAuthenticated, true)
  assert.match(controller.state.error, /空白字符/)
  assert.doesNotMatch(controller.state.error, /结果可能未确认/)
  controller.dispose()
})

test('password HTTP and business 401 clear only the owning current session and reauthenticate', async () => {
  for (const error of [{ status: 401 }, { code: 401 }]) {
    const { session, controller, redirects } = await passwordFixture(async () => { throw error })
    await controller.submit()
    assert.equal(session.isAuthenticated, false)
    assert.deepEqual(redirects, ['expired'])
    controller.dispose()
  }
})

test('late password success, 401 and 400 never clear or redirect a newer same-token login or overwrite newer form state', async () => {
  for (const outcome of ['success', 401, 400]) {
    const old = deferred(), next = deferred()
    let calls = 0
    const { session, controller, redirects } = await passwordFixture(() => ++calls === 1 ? old.promise : next.promise)
    const previous = controller.submit()
    await session.login({})
    Object.assign(controller.state.form, passwords())
    const current = controller.submit()
    if (outcome === 'success') old.resolve(null); else old.reject({ status: outcome })
    await previous
    assert.equal(session.isAuthenticated, true)
    assert.deepEqual(redirects, [])
    assert.equal(controller.state.loading, true)
    assert.equal(controller.state.error, '')
    next.reject({ status: 400, message: '当前请求的错误' })
    await current
    assert.equal(controller.state.error, '当前请求的错误')
    controller.dispose()
  }
})

test('leaving the password view does not cancel confirmed server revocation, but suppresses a late page error', async () => {
  for (const fail of [false, true]) {
    const server = deferred()
    const { session, controller, redirects } = await passwordFixture(() => server.promise)
    const operation = controller.submit()
    controller.dispose()
    if (fail) server.reject({ status: 400 }); else server.resolve(null)
    await operation
    assert.equal(controller.state.error, '')
    assert.equal(session.isAuthenticated, fail)
    assert.deepEqual(redirects, fail ? [] : ['password-changed'])
  }
})

test('production password API uses v2 envelope, exact JSON and captured Bearer; no automatic 429 retry', async () => {
  const original = request.defaults.adapter
  let calls = 0
  try {
    request.defaults.adapter = async (config) => {
      calls += 1
      assert.equal(config.baseURL, '/api/v2')
      assert.equal(config.url, '/auth/password')
      assert.equal(config.method, 'post')
      assert.deepEqual(JSON.parse(config.data), passwords())
      assert.equal(config.headers.Authorization, 'Bearer captured-token')
      assert.equal(config.sessionValidation, true)
      assert.equal(config.silent, true)
      return { config, status: 200, headers: {}, statusText: 'OK', data: { code: 0, data: null } }
    }
    assert.equal(await passwordApi(passwords(), { token: 'captured-token', generation: 3 }), null)
    request.defaults.adapter = async (config) => { calls += 1; return { config, status: 429, headers: { 'retry-after': '10' }, data: { code: 429, message: '请求受限' } } }
    await assert.rejects(passwordApi(passwords(), { token: 'captured-token', generation: 3 }), (error) => error.status === 429 && error.retryAfter === '10')
    assert.equal(calls, 2)
  } finally { request.defaults.adapter = original }
})
