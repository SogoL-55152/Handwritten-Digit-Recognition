import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSession, TOKEN_KEY } from '../src/auth/session.js'
import { createWorkspaceContext } from '../src/workspace/context.js'
import { createScopedResource } from '../src/workspace/resource.js'
import { createRecognitionController } from '../src/recognition/controller.js'
import { createDrawingBoard } from '../src/recognition/drawing-board.js'
import { validateTraining } from '../src/training/validation.js'
import request, { createRequest } from '../src/api/request.js'
import { recognize, errorMessage } from '../src/api/workspaces.js'
import { logout as logoutApi } from '../src/api/auth.js'

const user = { id: '9007199254740993', username: 'ordinary', platformRole: 'USER' }
const space = (id = 'A', role = 'OWNER') => ({ id, role, name: `Space ${id}`, status: 'ACTIVE', defaultModelId: '1' })
const me = { user, defaultWorkspaceId: 'A' }
function memory(cache = {}) {
  const values = new Map(Object.entries(cache))
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture(options = {}) {
  const storage = memory({ [TOKEN_KEY]: 'token' })
  const session = createSession({ storage, getMe: async () => me, login: async () => ({ token: 'token' }), ...options.auth })
  await session.refresh()
  const workspace = createWorkspaceContext({ session, list: async () => [space('A'), space('B', 'MEMBER')], get: async (id) => space(id), create: async (name) => ({ ...space('C'), name }), ...options.workspace })
  await workspace.load()
  return { session, workspace, storage }
}
function result(requestId, digit = 7) {
  return { recognitionId: '9007199254740995', requestId, digit, confidence: 0.97, modelId: '1', modelVersion: 'w2-canvas-aug-3epoch', preprocessVersion: 'canvas-mnist-v1', source: 'WEB', processingMs: 18, createdAt: '2026-11-02T07:00:00Z' }
}
function drawing(controller) { controller.drawingChanged({ hasInk: true, drawing: false }) }
function response(config, data, status = 200) { return { config, data, status, headers: {}, statusText: 'OK' } }

test('v1 token/profile caches are erased and never authorize a v2 session', async () => {
  let calls = 0
  const storage = memory({ hdr_token: 'v1-token', hdr_user: '{"role":"ADMIN"}', hdr_v2_user: '{"platformRole":"SUPER_ADMIN"}' })
  const session = createSession({ storage, getMe: async () => { calls += 1; return me } })
  assert.equal((await session.refresh()).status, 'anonymous')
  assert.equal(calls, 0)
  for (const key of ['hdr_token', 'hdr_user', 'hdr_v2_user']) assert.equal(storage.getItem(key), null)
})

test('register creates a v2 session but still verifies authoritative /me identity and string IDs', async () => {
  const pendingMe = deferred()
  const payload = { username: 'ordinary', password: 'secret1', nickname: 'Name' }
  const session = createSession({ storage: memory(), register: async (form) => {
    assert.deepEqual(form, payload)
    return { token: 'registered', user: { ...user, platformRole: 'SUPER_ADMIN' }, defaultWorkspaceId: 'forged' }
  }, getMe: () => pendingMe.promise })
  const registration = session.register(payload)
  await Promise.resolve()
  assert.equal(session.isAuthenticated, false)
  pendingMe.resolve(me)
  assert.equal((await registration).status, 'authenticated')
  assert.equal(session.state.defaultWorkspaceId, 'A')
  assert.equal(session.state.user.id, '9007199254740993')
  assert.equal(session.isSuperAdmin, false)
})

test('registration and login share generation protection against an older pending registration', async () => {
  const old = deferred()
  const session = createSession({ storage: memory(), register: () => old.promise, login: async () => ({ token: 'new' }), getMe: async () => me })
  const registration = session.register({})
  await session.login({})
  old.resolve({ token: 'old' })
  assert.equal((await registration).status, 'stale')
  assert.equal(session.state.token, 'new')
})

test('invalid v2 identity shapes fail closed and retain retryable credentials', async (t) => {
  for (const data of [{ user: { ...user, id: 1 }, defaultWorkspaceId: 'A' }, { user: { ...user, platformRole: 'ADMIN' }, defaultWorkspaceId: 'A' }, { user, defaultWorkspaceId: 1 }, { user }]) {
    await t.test(JSON.stringify(data), async () => {
      const session = createSession({ storage: memory({ [TOKEN_KEY]: 'token' }), getMe: async () => data })
      assert.equal((await session.refresh()).status, 'unavailable')
      assert.equal(session.state.token, 'token')
      assert.equal(session.isAuthenticated, false)
    })
  }
})

test('logout immediately clears session AND workspace, then revokes captured server session', async () => {
  const server = deferred()
  let captured
  const { session, workspace, storage } = await fixture({ auth: { logout: (snapshot) => { captured = snapshot; return server.promise } } })
  const before = session.getSnapshot()
  const logout = session.logout()
  assert.equal(session.isAuthenticated, false)
  assert.equal(workspace.state.active, null)
  assert.deepEqual(workspace.state.items, [])
  assert.equal(storage.getItem(TOKEN_KEY), null)
  await Promise.resolve()
  assert.deepEqual(captured, before)
  await session.login({})
  server.reject(new Error('offline'))
  assert.deepEqual(await logout, { revoked: false })
  assert.equal(session.isAuthenticated, true)
  assert.equal(session.state.logoutWarning, '')
})

test('failed server revocation honestly warns the still-logged-out user', async () => {
  const { session } = await fixture({ auth: { logout: async () => { throw new Error('offline') } } })
  assert.deepEqual(await session.logout(), { revoked: false })
  assert.match(session.state.logoutWarning, /服务器撤销未确认/)
})

test('workspace default/list/detail are real and creation sends only a validated name', async () => {
  const { workspace, session } = await fixture({ workspace: { create: async (name, auth) => {
    assert.equal(name, 'new space')
    assert.equal(auth.token, 'token')
    return { ...space('C'), name }
  } } })
  assert.equal(workspace.state.active.id, 'A')
  await workspace.select('B')
  assert.equal(workspace.state.active.id, 'B')
  await workspace.createSpace('  new space  ')
  assert.equal(workspace.state.active.id, 'C')
  assert.equal(workspace.state.items.length, 3)
  assert.equal(session.isAuthenticated, true)
  await workspace.createSpace(' ')
  assert.match(workspace.state.error, /1–64/)
})

test('SUPER_ADMIN cannot select nonmember space; 404 clears space but preserves account', async () => {
  const { workspace, session } = await fixture({ auth: { getMe: async () => ({ ...me, user: { ...user, platformRole: 'SUPER_ADMIN' } }) }, workspace: { get: async (id) => {
    if (id === 'private') throw { status: 404 }
    return space(id)
  } } })
  assert.equal(session.isSuperAdmin, true)
  const previous = workspace.getSnapshot()
  await workspace.select('private')
  assert.equal(workspace.state.active, null)
  assert.equal(workspace.isCurrent(previous), false)
  assert.equal(session.isAuthenticated, true)
  assert.match(workspace.state.error, /成员资格/)
})

test('late workspace verification success/error/finally cannot replace newer selection', async (t) => {
  for (const fail of [false, true]) await t.test(fail ? 'late error' : 'late success', async () => {
    const old = deferred(), next = deferred()
    const { workspace } = await fixture({ workspace: { get: (id) => id === 'old' ? old.promise : id === 'new' ? next.promise : Promise.resolve(space(id)) } })
    const previous = workspace.select('old')
    const current = workspace.select('new')
    assert.equal(workspace.state.active, null)
    if (fail) old.reject({ status: 404 }); else old.resolve(space('old'))
    await previous
    assert.equal(workspace.state.selecting, true)
    assert.equal(workspace.state.error, '')
    next.resolve(space('new'))
    await current
    assert.equal(workspace.state.active.id, 'new')
    assert.equal(workspace.state.selecting, false)
  })
})

test('pending list and create responses do not leak across logout/new identical-token login', async (t) => {
  for (const method of ['list', 'create']) await t.test(method, async () => {
    const pending = deferred()
    let hold = false
    const { session, workspace } = await fixture({ workspace: {
      list: () => hold && method === 'list' ? pending.promise : Promise.resolve([space()]),
      create: () => pending.promise
    } })
    hold = true
    const old = method === 'list' ? workspace.load() : workspace.createSpace('new')
    await session.login({})
    pending.resolve(method === 'list' ? [space('old')] : space('old'))
    await old
    assert.deepEqual(workspace.state.items, [])
    assert.equal(workspace.state.active, null)
    assert.equal(workspace.state.loading, false)
    assert.equal(workspace.state.creating, false)
  })
})

test('public asset/usage resource old success, error and finally cannot pollute new workspace', async (t) => {
  for (const fail of [false, true]) await t.test(fail ? 'old error' : 'old success', async () => {
    const { workspace } = await fixture()
    const old = deferred(), next = deferred()
    let calls = 0
    const resource = createScopedResource({ scope: workspace, fetch: () => ++calls === 1 ? old.promise : next.promise })
    const previous = resource.load()
    await workspace.select('B')
    assert.equal(resource.state.data, null)
    const current = resource.load()
    if (fail) old.reject(new Error('old failure')); else old.resolve(['old asset'])
    await previous
    assert.equal(resource.state.loading, true)
    assert.equal(resource.state.error, '')
    assert.equal(resource.state.data, null)
    next.resolve(['new asset'])
    await current
    assert.deepEqual(resource.state.data, ['new asset'])
    resource.dispose()
  })
})

test('recognition blocks blank, drawing and duplicate submit; displays only true returned fields', async () => {
  const { session, workspace } = await fixture()
  const pending = deferred()
  let calls = 0, sentId
  const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']), send: (snapshot, _image, id) => {
    calls += 1; sentId = id
    assert.equal(snapshot.workspaceId, 'A')
    return pending.promise
  } })
  await controller.submit()
  assert.equal(calls, 0)
  controller.drawingChanged({ hasInk: true, drawing: true })
  await controller.submit()
  assert.equal(calls, 0)
  drawing(controller)
  const active = controller.submit()
  await Promise.resolve()
  await controller.submit()
  assert.equal(calls, 1)
  assert.match(sentId, /^[0-9a-f-]{36}$/)
  pending.resolve(result(sentId))
  await active
  assert.equal(controller.state.result.digit, 7)
  assert.equal(controller.state.result.confidence, 0.97)
  assert.equal(controller.state.loading, false)
})

test('triple recognition guard protects success, errors and finally after redraw/clear/space/session change', async (t) => {
  for (const change of ['redraw', 'clear', 'workspace', 'logout', 'same-token-login']) for (const fail of [false, true]) {
    await t.test(`${change} / ${fail ? 'late error' : 'late success'}`, async () => {
      const { session, workspace } = await fixture()
      const old = deferred(), next = deferred()
      let calls = 0, oldId, newId
      const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']), send: (_snapshot, _image, id) => {
        if (++calls === 1) { oldId = id; return old.promise }
        newId = id; return next.promise
      } })
      drawing(controller)
      const previous = controller.submit()
      await Promise.resolve()
      if (change === 'redraw') drawing(controller)
      if (change === 'clear') controller.drawingChanged({ hasInk: false })
      if (change === 'workspace') await workspace.select('B')
      if (change === 'logout') { await session.logout(); await session.login({}); await workspace.load() }
      if (change === 'same-token-login') { await session.login({}); await workspace.load() }
      assert.equal(controller.state.result, null)
      assert.equal(controller.state.error, '')
      drawing(controller)
      const current = controller.submit()
      await Promise.resolve()
      assert.notEqual(oldId, newId)
      if (fail) old.reject(new Error('late failure')); else old.resolve(result(oldId, 9))
      await previous
      assert.equal(controller.state.loading, true, 'old finally must not clear the newer request spinner')
      assert.equal(controller.state.result, null)
      assert.equal(controller.state.error, '')
      next.resolve(result(newId, 3))
      await current
      assert.equal(controller.state.result.digit, 3)
      assert.equal(controller.state.loading, false)
    })
  }
})

test('clearing or switching during asynchronous PNG export prevents the old HTTP POST entirely', async (t) => {
  for (const change of ['clear', 'space', 'logout', 'dispose']) await t.test(change, async () => {
    const { session, workspace } = await fixture()
    const png = deferred()
    let calls = 0
    const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: () => png.promise, send: () => { calls += 1 } })
    drawing(controller)
    const previous = controller.submit()
    if (change === 'clear') controller.drawingChanged({ hasInk: false })
    if (change === 'space') await workspace.select('B')
    if (change === 'logout') await session.logout()
    if (change === 'dispose') controller.dispose()
    png.resolve(new Blob(['png']))
    await previous
    assert.equal(calls, 0)
    assert.equal(controller.state.loading, false)
  })
})

test('invalid predictions fail closed; explicit retry uses a new UUID and never auto-reposts', async () => {
  const { session, workspace } = await fixture()
  const ids = []
  const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']), send: async (_s, _i, id) => {
    ids.push(id)
    return { ...result(id), confidence: NaN }
  } })
  drawing(controller)
  await controller.submit()
  assert.equal(ids.length, 1)
  assert.equal(controller.state.result, null)
  assert.match(controller.state.error, /无效结果/)
  await controller.submit()
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
})

test('422 declines an input without displaying a guess, logging out or retrying', async () => {
  const { session, workspace } = await fixture()
  let calls = 0
  const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']),
    send: async () => { calls += 1; throw Object.assign(new Error('declined'), { status: 422, data: { category: 'UNRECOGNIZED_INPUT' } }) } })
  drawing(controller)
  await controller.submit()
  assert.equal(calls, 1)
  assert.equal(controller.state.result, null)
  assert.match(controller.state.error, /重新书写/)
  assert.equal(session.isAuthenticated, true)
  controller.dispose()
})

test('late 422 response cannot overwrite the next drawing operation', async () => {
  const { session, workspace } = await fixture()
  const pending = deferred()
  const controller = createRecognitionController({ session, workspace, randomUUID, exportPng: async () => new Blob(['png']), send: () => pending.promise })
  drawing(controller)
  const old = controller.submit()
  await Promise.resolve()
  controller.drawingChanged({ hasInk: false })
  pending.reject(Object.assign(new Error('declined'), { status: 422 }))
  await old
  assert.equal(controller.state.error, '')
  assert.equal(controller.state.result, null)
  assert.equal(controller.state.loading, false)
  controller.dispose()
})

test('real request adapter uses v2 Java multipart endpoint, PNG/source/UUID only and captured logout token', async () => {
  const original = request.defaults.adapter
  const id = randomUUID()
  let calls = 0
  request.defaults.adapter = async (config) => {
    calls += 1
    assert.equal(config.baseURL, '/api/v2')
    assert.equal(config.headers.Authorization, 'Bearer captured')
    if (config.url.endsWith('/recognitions')) {
      assert.equal(config.url, '/workspaces/9007199254740993/recognitions')
      assert.equal(config.headers['Idempotency-Key'], id)
      assert.deepEqual([...config.data.keys()], ['image', 'source'])
      assert.equal(config.data.get('source'), 'WEB')
      assert.equal(config.data.get('image').type, 'image/png')
      return response(config, { code: 0, data: result(id) })
    }
    assert.equal(config.url, '/auth/logout')
    assert.equal(config.sessionValidation, true)
    return response(config, { code: 0, data: null })
  }
  try {
    const snapshot = { workspaceId: '9007199254740993', session: { token: 'captured', generation: 1 } }
    assert.equal((await recognize(snapshot, new Blob(['png'], { type: 'image/png' }), id)).requestId, id)
    await logoutApi(snapshot.session)
    assert.equal(calls, 2)
  } finally { request.defaults.adapter = original }
})

test('403/404 preserve credentials; non-JSON proxy errors reject; 429 preserves category and Retry-After', async (t) => {
  for (const status of [403, 404, 429, 503]) await t.test(String(status), async () => {
    let invalidated = 0
    const client = createRequest({ hooks: { getSession: () => ({ token: 'token', generation: 0 }), onUnauthorized: () => { invalidated += 1 } }, adapter: async (config) => {
      const error = new Error('Request failed')
      error.config = config
      error.response = response(config, status === 503 ? '<html>gateway down</html>' : { code: status, message: 'rejected', data: { category: 'ACCOUNT_LIMIT', retryAfterSeconds: 15 } }, status)
      error.response.headers = { 'retry-after': '15' }
      throw error
    } })
    await assert.rejects(client.get('/test'), (error) => {
      assert.equal(error.status, status)
      if (status === 429) { assert.equal(error.retryAfter, '15'); assert.match(errorMessage(error), /ACCOUNT_LIMIT.*15/) }
      return true
    })
    assert.equal(invalidated, 0)
  })
  const client = createRequest({ adapter: async (config) => response(config, '<html>not API</html>') })
  await assert.rejects(client.get('/bad'), /无效响应/)
})

function fakeCanvas() {
  const handlers = {}, calls = [], captures = new Set()
  const ctx = { setTransform: (...args) => calls.push(['transform', ...args]), fillRect: (...args) => calls.push(['fillRect', ctx.fillStyle, ...args]), beginPath() {}, arc: (...args) => calls.push(['arc', ...args]), fill() {}, moveTo() {}, lineTo() {}, stroke: () => calls.push(['stroke']) }
  return { calls, handlers, captures, width: 0, height: 0, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 320, height: 320 }),
    addEventListener: (event, fn) => { handlers[event] = fn }, removeEventListener: (event) => { delete handlers[event] },
    setPointerCapture: (id) => captures.add(id), hasPointerCapture: (id) => captures.has(id), releasePointerCapture: (id) => captures.delete(id),
    toBlob: (callback, type) => { calls.push(['export', type]); callback(new Blob(['image'], { type })) },
    fire(type, extras = {}) { handlers[type]?.({ type, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 80, clientY: 90, preventDefault() {}, ...extras }) }
  }
}

test('unchanged canvas resize does not invalidate a displayed or pending recognition', () => {
  const canvas = fakeCanvas(), changes = []
  let dpr = 1
  const board = createDrawingBoard({ canvas, onChange: (state) => changes.push(state), getDpr: () => dpr })
  canvas.fire('pointerdown')
  canvas.fire('pointerup')
  const revision = changes.at(-1).revision
  const paints = canvas.calls.length
  board.resize()
  board.resize()
  assert.equal(changes.at(-1).revision, revision)
  assert.equal(canvas.calls.length, paints)
  dpr = 2
  board.resize()
  assert.equal(canvas.width, 640)
  assert.equal(changes.at(-1).revision, revision + 1)
  assert.equal(changes.at(-1).hasInk, true)
  board.dispose()
})

test('pointer canvas supports DPR, opaque white PNG, taps, strokes, pointer capture/cancel, clear and disposal', async () => {
  const canvas = fakeCanvas(), changes = []
  const board = createDrawingBoard({ canvas, onChange: (state) => changes.push(state), getDpr: () => 2 })
  assert.equal(canvas.width, 640)
  assert.equal(canvas.height, 640)
  assert.equal(canvas.calls[1][1], '#ffffff')
  await assert.rejects(board.exportPng(), /书写/)
  canvas.fire('pointerdown')
  assert.equal(canvas.captures.has(1), true)
  assert.equal(changes.at(-1).drawing, true)
  assert.equal(canvas.calls.some((call) => call[0] === 'arc'), true)
  await assert.rejects(board.exportPng(), /书写/)
  canvas.fire('pointerup')
  assert.equal(changes.at(-1).hasInk, true)
  assert.equal(changes.at(-1).drawing, false)
  assert.equal(canvas.captures.size, 0)
  assert.equal((await board.exportPng()).type, 'image/png')
  canvas.fire('pointerdown', { pointerType: 'touch', pointerId: 4 })
  const revision = changes.at(-1).revision
  canvas.fire('pointerdown', { pointerType: 'touch', pointerId: 5 })
  canvas.fire('pointermove', { pointerId: 5 })
  assert.equal(changes.at(-1).revision, revision)
  canvas.fire('pointermove', { pointerId: 4, clientX: 150 })
  canvas.fire('pointercancel', { pointerId: 4 })
  assert.equal(changes.at(-1).drawing, false)
  assert.equal(canvas.calls.some((call) => call[0] === 'stroke'), true)
  board.resize()
  assert.equal(changes.at(-1).hasInk, true)
  board.clear()
  assert.equal(changes.at(-1).hasInk, false)
  await assert.rejects(board.exportPng())
  board.dispose()
  assert.deepEqual(canvas.handlers, {})
})

test('right-click creates no ink; lost capture finishes current pen stroke', () => {
  const canvas = fakeCanvas(), changes = []
  const board = createDrawingBoard({ canvas, onChange: (value) => changes.push(value) })
  canvas.fire('pointerdown', { button: 2 })
  assert.equal(changes.at(-1).hasInk, false)
  canvas.fire('pointerdown', { pointerType: 'pen' })
  canvas.fire('lostpointercapture')
  assert.equal(changes.at(-1).drawing, false)
  assert.equal(changes.at(-1).hasInk, true)
  board.dispose()
})

test('training prototype enforces frozen limits and never accepts non-finite numbers', () => {
  const valid = { modelName: 'Experiment', architecture: 'DigitCNN', epoch: 3, batchSize: 64, learningRate: 0.001, seed: 42 }
  assert.deepEqual(validateTraining(valid), {})
  for (const [key, values] of Object.entries({ modelName: ['', ' ', 'x'.repeat(65)], architecture: ['ResNet'], epoch: [0, 6, 1.5, '3'], batchSize: [0, 16, '64'], learningRate: [0, -1, 0.11, NaN, Infinity, ''], seed: [-1, 4294967296, 1.5, NaN] })) {
    for (const value of values) assert.ok(validateTraining({ ...valid, [key]: value })[key], `${key}=${value}`)
  }
  assert.deepEqual(validateTraining({ ...valid, epoch: 1, batchSize: 32, learningRate: 0.1, seed: 4294967295 }), {})
})
