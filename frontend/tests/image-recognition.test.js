import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { computed, reactive, compile, createSSRApp } from 'vue'
import { parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { createSession, TOKEN_KEY } from '../src/auth/session.js'
import { createWorkspaceContext } from '../src/workspace/context.js'
import { createRecognitionController } from '../src/recognition/controller.js'
import { createDrawingBoard } from '../src/recognition/drawing-board.js'
import request, { configureRequest, createRequest } from '../src/api/request.js'
import { recognize, errorMessage } from '../src/api/workspaces.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const result = (requestId, digit = 7) => ({ requestId, digit, recognitionId: 'r1', confidence: 0.97,
  modelId: '1', modelVersion: 'v1', preprocessVersion: 'v1', source: 'WEB', processingMs: 3, createdAt: '2026-11-05' })
function prepared(name = 'image') {
  let disposed = 0
  return { file: new Blob([name], { type: 'image/png' }), previewUrl: `blob:${name}`, mime: 'image/png', width: 28, height: 28, size: name.length,
    dispose() { disposed += 1 }, get disposed() { return disposed } }
}
async function fixture(overrides = {}) {
  const values = new Map([[TOKEN_KEY, 'same-token']])
  const session = createSession({ storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    getMe: async () => ({ user: { id: 'u1', username: 'user', platformRole: 'USER' }, defaultWorkspaceId: 'A' }), login: async () => ({ token: 'same-token' }) })
  await session.refresh()
  const space = (id) => ({ id, name: id, role: 'OWNER', status: 'ACTIVE' })
  const workspace = createWorkspaceContext({ session, list: async () => [space('A'), space('B')], get: async (id) => space(id) })
  await workspace.load()
  let uuids = 0, posts = 0, exports = 0
  const controller = createRecognitionController({ session, workspace, reactive,
    randomUUID: () => { uuids += 1; return randomUUID() },
    exportPng: async () => { exports += 1; return new Blob(['drawing'], { type: 'image/png' }) },
    prepareImage: async (file) => prepared(file.name),
    send: async (_snapshot, _file, id) => { posts += 1; return result(id) }, ...overrides })
  const counts = () => ({ uuids, posts, exports })
  return { session, workspace, controller, counts }
}
const image = (name = 'image.png') => new File(['bytes'], name)
const choose = async (controller, name) => { controller.setInputKind('image'); await controller.selectImage(image(name)) }
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('selection, preview, cancellation and removal never submit or allocate a UUID; only explicit clicks do', async () => {
  const { controller, counts } = await fixture()
  const enabled = computed(() => controller.canSubmit())
  controller.setInputKind('image')
  assert.equal(enabled.value, false)
  await controller.submit(); await controller.selectImage(null)
  assert.deepEqual(counts(), { uuids: 0, posts: 0, exports: 0 })
  await choose(controller)
  assert.equal(enabled.value, true)
  assert.deepEqual(counts(), { uuids: 0, posts: 0, exports: 0 })
  const preview = controller.state.image.previewUrl
  await controller.selectImage(null)
  assert.equal(controller.state.image.previewUrl, preview)
  await controller.submit()
  const id = controller.state.requestId
  assert.equal(controller.state.result.digit, 7)
  await controller.submit()
  assert.notEqual(controller.state.requestId, id)
  assert.deepEqual(counts(), { uuids: 2, posts: 2, exports: 0 })
  controller.removeImage()
  assert.equal(enabled.value, false, 'reactive submit state updates on removal')
  assert.equal(controller.state.result, null)
  await controller.submit()
  assert.deepEqual(counts(), { uuids: 2, posts: 2, exports: 0 })
  controller.dispose()
})

test('validation blocks submit, invalid selection drops old input, and duplicate explicit submit sends only once', async () => {
  const validation = deferred(), response = deferred()
  let posts = 0
  const selected = prepared()
  const { controller, counts } = await fixture({ prepareImage: () => validation.promise,
    send: (_snapshot, file, id, options) => { posts += 1; assert.equal(file, selected.file); assert.equal(options.inputCurrent(), true); return response.promise.then(() => result(id)) } })
  controller.setInputKind('image')
  const selection = controller.selectImage(image())
  assert.equal(controller.state.validating, true)
  await controller.submit()
  assert.equal(counts().uuids, 0)
  validation.resolve(selected); await selection
  const pending = controller.submit()
  await controller.submit()
  assert.equal(posts, 1); assert.equal(counts().exports, 0)
  response.resolve(); await pending
  controller.removeImage()
  assert.equal(selected.disposed, 1)
  controller.dispose()
  const invalid = await fixture({ prepareImage: async () => { throw new Error('图片已损坏') } })
  await choose(invalid.controller)
  assert.match(invalid.controller.state.error, /损坏/)
  assert.equal(invalid.controller.canSubmit(), false)
  assert.equal(invalid.controller.state.validating, false)
  invalid.controller.dispose()
})

test('stale validation success/error/finally cannot replace a newer pending image and releases old previews', async (t) => {
  for (const fail of [false, true]) await t.test(String(fail), async () => {
    const old = deferred(), next = deferred(), older = prepared('old'), newer = prepared('new')
    const signals = []
    const { controller } = await fixture({ prepareImage: (_file, { signal }) => { signals.push(signal); return signals.length === 1 ? old.promise : next.promise } })
    controller.setInputKind('image')
    const previous = controller.selectImage(image('old'))
    const current = controller.selectImage(image('new'))
    assert.equal(signals[0].aborted, true)
    if (fail) old.reject(new Error('old corrupt image')); else old.resolve(older)
    await previous
    assert.equal(controller.state.validating, true)
    assert.equal(controller.state.image, null); assert.equal(controller.state.error, '')
    assert.equal(older.disposed, fail ? 0 : 1)
    next.resolve(newer); await current
    assert.equal(controller.state.image.previewUrl, 'blob:new')
    controller.dispose()
    assert.equal(newer.disposed, 1)
  })
})

test('mode, removal, reset, workspace, same-token login and disposal abort validation and clear owned files', async (t) => {
  for (const action of ['mode', 'remove', 'reset', 'workspace', 'login', 'logout', 'dispose']) await t.test(action, async () => {
    const old = deferred(), selected = prepared()
    let signal
    const { controller, workspace, session } = await fixture({ prepareImage: (_file, options) => { signal = options.signal; return old.promise } })
    controller.setInputKind('image')
    const pending = controller.selectImage(image())
    if (action === 'mode') controller.setInputKind('drawing')
    if (action === 'remove') controller.removeImage()
    if (action === 'reset') controller.reset()
    if (action === 'workspace') await workspace.select('B')
    if (action === 'login') await session.login({})
    if (action === 'logout') await session.logout()
    if (action === 'dispose') controller.dispose()
    assert.equal(signal.aborted, true)
    old.resolve(selected); await pending
    assert.equal(selected.disposed, 1)
    assert.equal(controller.state.image, null); assert.equal(controller.state.validating, false)
    assert.equal(controller.canSubmit(), false)
    controller.dispose()
  })
})

test('ready previews are disposed exactly once on replacement and every ownership boundary', async (t) => {
  for (const action of ['replace', 'mode', 'remove', 'workspace', 'login', 'logout', 'dispose']) await t.test(action, async () => {
    const selected = prepared(), replacement = prepared('replacement')
    let preparations = 0
    const { controller, session, workspace } = await fixture({ prepareImage: async () => ++preparations === 1 ? selected : replacement })
    await choose(controller)
    if (action === 'replace') await controller.selectImage(image('new'))
    if (action === 'mode') controller.setInputKind('drawing')
    if (action === 'remove') controller.removeImage()
    if (action === 'workspace') await workspace.select('B')
    if (action === 'login') await session.login({})
    if (action === 'logout') await session.logout()
    if (action === 'dispose') controller.dispose()
    assert.equal(selected.disposed, 1)
    controller.dispose()
    assert.equal(selected.disposed, 1)
    assert.equal(replacement.disposed, action === 'replace' ? 1 : 0)
  })
})

test('background canvas changes preserve selected image, pending submit and result; returning to drawing uses real ink', async () => {
  const pending = deferred()
  const { controller } = await fixture({ send: (_s, _f, id) => pending.promise.then(() => result(id)) })
  controller.drawingChanged({ hasInk: true })
  await choose(controller)
  const revision = controller.state.revision
  const submitting = controller.submit()
  controller.drawingChanged({ hasInk: false, drawing: true })
  assert.equal(controller.state.revision, revision)
  assert.equal(controller.state.loading, true)
  pending.resolve(); await submitting
  controller.drawingChanged({ hasInk: false, drawing: false })
  assert.equal(controller.state.result.digit, 7)
  assert.equal(controller.canSubmit(), true)
  controller.setInputKind('drawing')
  assert.equal(controller.state.image, null); assert.equal(controller.state.result, null)
  assert.equal(controller.canSubmit(), false, 'image never fabricates drawing strokes')
  controller.drawingChanged({ hasInk: true })
  assert.equal(controller.canSubmit(), true)
  controller.dispose()
})

test('old asynchronous drawing export never posts after image mode or selection changes', async () => {
  const exported = deferred(), sent = []
  const { controller } = await fixture({ exportPng: () => exported.promise, send: async (_s, file, id) => { sent.push(file); return result(id) } })
  controller.drawingChanged({ hasInk: true })
  const old = controller.submit()
  await choose(controller)
  await controller.submit()
  const current = controller.state.result
  exported.resolve(new Blob(['old drawing']))
  await old
  assert.equal(sent.length, 1)
  assert.equal(controller.state.result, current)
  assert.equal(controller.state.loading, false)
  controller.dispose()
})

test('old image success, 422 and 401 cannot overwrite new input or clear its spinner/account via real request adapter', async (t) => {
  for (const change of ['selection', 'mode', 'remove', 'workspace', 'login']) {
    for (const outcome of ['success', '422', 'http401', 'business401']) await t.test(`${change}/${outcome}`, async () => {
      const original = request.defaults.adapter
      const old = deferred(), next = deferred(), configs = []
      const { controller, session, workspace } = await fixture({ send: recognize })
      let invalidations = 0
      configureRequest({ onUnauthorized: (auth) => { invalidations += 1; session.invalidate(auth) } })
      request.defaults.adapter = (config) => { configs.push(config); return configs.length === 1 ? old.promise : next.promise }
      const response = (config, data, status = 200) => ({ config, data, status, headers: {} })
      try {
        await choose(controller)
        const previous = controller.submit(); await tick()
        if (change === 'mode') controller.setInputKind('drawing')
        if (change === 'remove') controller.removeImage()
        if (change === 'workspace') await workspace.select('B')
        if (change === 'login') { await session.login({}); await workspace.load() }
        await choose(controller, 'new')
        const current = controller.submit(); await tick()
        const config = configs[0], oldId = config.headers['Idempotency-Key']
        assert.equal(config.inputCurrent(), false)
        if (outcome === 'success') old.resolve(response(config, { code: 0, data: result(oldId, 9) }))
        else if (outcome === 'business401') old.resolve(response(config, { code: 401, message: 'old unauthorized' }))
        else {
          const status = outcome === 'http401' ? 401 : 422
          old.reject(Object.assign(new Error('old error'), { config, response: response(config, { code: status }, status) }))
        }
        await previous
        assert.equal(session.isAuthenticated, true); assert.equal(invalidations, 0)
        assert.equal(controller.state.loading, true); assert.equal(controller.state.result, null); assert.equal(controller.state.error, '')
        const newConfig = configs[1], newId = newConfig.headers['Idempotency-Key']
        assert.notEqual(oldId, newId)
        next.resolve(response(newConfig, { code: 0, data: result(newId, 3) }))
        await current
        assert.equal(controller.state.result.digit, 3); assert.equal(controller.state.loading, false)
      } finally { controller.dispose(); request.defaults.adapter = original; configureRequest({ onUnauthorized: undefined }) }
    })
  }
})

test('a failed replacement cannot leave the old validated file submittable, and UUID failure never posts', async () => {
  const selected = prepared()
  let preparations = 0
  const { controller, counts } = await fixture({ prepareImage: async () => {
    if (++preparations === 1) return selected
    throw new Error('图片已损坏')
  } })
  await choose(controller)
  await controller.submit()
  await controller.selectImage(image('corrupt'))
  assert.equal(selected.disposed, 1)
  assert.equal(controller.state.image, null); assert.equal(controller.state.result, null)
  assert.match(controller.state.error, /损坏/)
  await controller.submit()
  assert.equal(counts().posts, 1)
  controller.dispose()
  const noUuid = await fixture({ randomUUID: () => { throw new Error('安全 UUID 不可用') } })
  await choose(noUuid.controller)
  await noUuid.controller.submit()
  assert.equal(noUuid.counts().posts, 0)
  assert.match(noUuid.controller.state.error, /UUID/)
  assert.equal(noUuid.controller.state.loading, false)
  noUuid.controller.dispose()
})

test('late image success/error preserves an already displayed newer result, including same-file reselection', async (t) => {
  for (const status of [0, 401, 422]) await t.test(String(status), async () => {
    const pending = deferred()
    let calls = 0, oldId
    const { controller } = await fixture({ send: (_s, _f, id) => {
      if (++calls === 1) { oldId = id; return pending.promise }
      return Promise.resolve(result(id, 3))
    } })
    const file = image()
    controller.setInputKind('image')
    await controller.selectImage(file)
    const old = controller.submit()
    await controller.selectImage(file)
    await controller.submit()
    const current = controller.state.result
    if (status) pending.reject({ status }); else pending.resolve(result(oldId, 9))
    await old
    assert.equal(controller.state.result, current)
    assert.equal(controller.state.result.digit, 3)
    assert.equal(controller.state.error, ''); assert.equal(controller.state.loading, false)
    controller.dispose()
  })
})

test('current 401 still invalidates; other API callers without inputCurrent retain existing behavior', async () => {
  let invalidations = 0, errors = 0
  const client = createRequest({ hooks: { onUnauthorized: () => { invalidations += 1 }, onError: () => { errors += 1 } },
    adapter: async (config) => ({ config, status: 200, headers: {}, data: { code: 401, message: 'expired' } }) })
  await assert.rejects(client.get('/recognition', { inputCurrent: () => false }))
  assert.equal(invalidations, 0); assert.equal(errors, 0)
  await assert.rejects(client.get('/recognition', { inputCurrent: () => true }))
  await assert.rejects(client.get('/other'))
  assert.equal(invalidations, 2); assert.equal(errors, 2)
})

test('multipart adapter preserves canonical JPEG/PNG original bytes with safe filename and no extra fields/retries', async () => {
  const original = request.defaults.adapter
  let calls = 0
  try {
    for (const [mime, filename] of [['image/png', 'drawing.png'], ['image/jpeg', 'drawing.jpeg']]) {
      const file = new File(['original bytes'], '../../private-name.secret', { type: mime }), id = randomUUID()
      const inputCurrent = () => true
      request.defaults.adapter = async (config) => {
        calls += 1
        assert.equal(config.url, '/workspaces/A/recognitions')
        assert.equal(config.headers.Authorization, 'Bearer captured')
        assert.equal(config.headers['Idempotency-Key'], id)
        assert.equal(config.inputCurrent, inputCurrent)
        assert.deepEqual([...config.data.keys()], ['image', 'source'])
        assert.equal(config.data.get('source'), 'WEB')
        const sent = config.data.get('image')
        assert.equal(sent.name, filename); assert.equal(sent.type, mime)
        assert.equal(await sent.text(), 'original bytes')
        return { config, status: 200, headers: {}, data: { code: 0, data: result(id) } }
      }
      await recognize({ workspaceId: 'A', session: { token: 'captured' } }, file, id, { inputCurrent })
    }
    assert.equal(calls, 2)
    for (const status of [413, 422]) assert.match(errorMessage({ status }), /更换图片或重新书写/)
  } finally { request.defaults.adapter = original }
})

test('hidden canvas resize is a no-op and visible resize repaints preserved strokes', () => {
  let width = 320, changes = 0, paints = 0
  const handlers = {}
  const canvas = { width: 0, height: 0, getContext: () => ({ setTransform() {}, fillRect() { paints += 1 }, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {} }),
    getBoundingClientRect: () => ({ width, height: width, left: 0, top: 0 }), addEventListener: (name, fn) => { handlers[name] = fn }, removeEventListener() {} }
  const board = createDrawingBoard({ canvas, getDpr: () => 2, onChange: () => { changes += 1 } })
  const event = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 30, clientY: 30, preventDefault() {} }
  handlers.pointerdown(event); handlers.pointerup({ ...event, type: 'pointerup' })
  const previous = { changes, paints }
  width = 0; board.resize()
  assert.equal(canvas.width, 640); assert.deepEqual({ changes, paints }, previous)
  width = 400; board.resize()
  assert.equal(canvas.width, 800); assert.equal(changes, previous.changes + 1)
  assert.equal(paints, previous.paints + 1)
  board.dispose()
})

test('production image template keeps canvas mounted, preview separate, and submit independent of canvas support', async () => {
  const source = readFileSync(new URL('../src/views/Recognize.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const state = { inputKind: 'image', image: { previewUrl: 'blob:local/1', mime: 'image/jpeg', width: 28, height: 28, size: 100 }, loading: false, validating: false }
  const app = createSSRApp({ data: () => ({ state, pilot: false, controller: {}, boardError: 'no canvas', canSubmit: true, canvas: null, board: null, selectFile() {}, multi: { enabled: false, maxDigits: 3, loading: false, result: null, error: '' }, MAX_DIGITS_OPTIONS: [1, 2, 3, 4], multiReady: false, submitPrimary() {}, consentGiven: false, setConsent() {}, feedback: { submitting: false, message: '', error: '', sentFor: null, wrongOpen: false }, feedbackErrors: {}, feedbackDone: true, FEEDBACK_LABELS: [0,1,2,3,4,5,6,7,8,9], confirmCorrect() {}, pickCorrect() {}, sendFeedback() {}, skipFeedback() {} }), render: compile(descriptor.template.content) })
  const html = await renderToString(app)
  assert.match(html, /display:none[^]*?<canvas/)
  assert.match(html, /data-testid="image-preview" src="blob:local\/1"/)
  assert.match(html, /type="file" accept="image\/png,image\/jpeg"/)
  assert.doesNotMatch(html, /data-testid="recognition-submit"[^>]*disabled/)
  assert.match(source, /state.inputKind === 'image' \|\| !boardError.value/)
  assert.match(source, /flush: 'post'/)
  assert.match(html, /识别图片/)
})
