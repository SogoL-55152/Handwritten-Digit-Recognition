const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const { createCanvasStub } = require('./helpers/canvas-stub')

let definition
// Load the actual production component, not a copy of its drawing logic.
global.Component = (value) => { definition = value }
require('../components/drawing-board/drawing-board')
delete global.Component
afterEach(() => { delete global.wx })

function harness({ dpr = 2, initialize = true, legacy = false } = {}) {
  const raster = createCanvasStub()
  const exports = []
  const toasts = []
  const updates = []
  const queries = []
  const wx = {
    getWindowInfo: () => ({ pixelRatio: dpr }),
    getSystemInfoSync: () => ({ pixelRatio: dpr }),
    showToast: (options) => toasts.push(options),
    canvasToTempFilePath: (options, scope) => exports.push({ options, scope }),
    request: () => assert.fail('Drawing prototype must not make network requests'),
    uploadFile: () => assert.fail('Drawing prototype must not upload files')
  }
  if (legacy) delete wx.getWindowInfo
  global.wx = wx
  const board = {
    ...definition.methods,
    data: structuredClone(definition.data),
    setData(patch) {
      assert.notEqual(this._detached, true, 'No setData after detach')
      updates.push(patch)
      Object.assign(this.data, patch)
    },
    createSelectorQuery() {
      return {
        select(selector) {
          assert.equal(selector, '#drawing-canvas')
          return this
        },
        fields(options) {
          assert.deepEqual(options, { node: true, size: true })
          return this
        },
        exec(callback) { queries.push(callback) }
      }
    }
  }
  const resolveInit = (results = [{ node: raster.canvas, width: 100, height: 80 }]) => {
    assert.ok(queries.length)
    queries.shift()(results)
  }
  definition.lifetimes.attached.call(board)
  definition.lifetimes.ready.call(board)
  if (initialize) resolveInit()
  return {
    board, raster, wx, exports, toasts, updates, resolveInit,
    detach: () => definition.lifetimes.detached.call(board)
  }
}

const touch = (x, y, identifier = 1) => ({ x, y, identifier })
const start = (board, x = 20, y = 20, id = 1) => board.onTouchStart({ touches: [touch(x, y, id)] })
const move = (board, x, y, id = 1) => board.onTouchMove({ touches: [touch(x, y, id)] })
const end = (board, x = 20, y = 20, id = 1) => board.onTouchEnd({ changedTouches: [touch(x, y, id)] })
const dot = (board, x = 20, y = 20) => { start(board, x, y); end(board, x, y) }
const BLACK = 0xff000000
const WHITE = 0xffffffff

for (const dpr of [1, 2, 3, 2.625]) {
  test(`initializes opaque white Canvas 2D with DPR ${dpr}`, () => {
    const { board, raster } = harness({ dpr })
    const width = Math.round(100 * dpr)
    const height = Math.round(80 * dpr)
    assert.equal(board.data.ready, true)
    assert.equal(raster.canvas.width, width)
    assert.equal(raster.canvas.height, height)
    assert.deepEqual(raster.calls[0], ['scale', width / 100, height / 80])
    assert.equal(raster.countPixels(WHITE), width * height)
    assert.equal(raster.ctx.lineCap, 'round')
    assert.equal(raster.ctx.lineJoin, 'round')
    assert.equal(raster.ctx.strokeStyle, '#000000')
    dot(board)
    assert.equal(raster.pixelAt(Math.floor(20 * width / 100), Math.floor(20 * height / 80)), BLACK)
    assert.equal(raster.pixelAt(0, 0), WHITE)
  })
}

test('uses legacy system info and defaults invalid DPR to 1', () => {
  assert.equal(harness({ dpr: 3, legacy: true }).raster.canvas.width, 300)
  assert.equal(harness({ dpr: NaN }).raster.canvas.width, 100)
})

test('uninitialized drawing, clearing and export are guarded', () => {
  const { board, exports, toasts } = harness({ initialize: false })
  start(board)
  move(board, 30, 30)
  board.clear()
  board.exportImage()
  assert.equal(board.data.hasInk, false)
  assert.equal(exports.length, 0)
  assert.equal(toasts.length, 3)
})

for (const [label, results] of [
  ['missing node', []],
  ['zero size', [{ node: {}, width: 0, height: 80 }]],
  ['missing 2D context', [{ node: { getContext: () => null }, width: 100, height: 80 }]],
  ['context exception', [{ node: { getContext: () => { throw new Error('canvas unavailable') } }, width: 100, height: 80 }]]
]) {
  test(`initialization failure (${label}) is visible and retryable`, () => {
    const { board, resolveInit } = harness({ initialize: false })
    resolveInit(results)
    assert.equal(board.data.ready, false)
    assert.match(board.data.error, /初始化失败/)
    board.initCanvas()
    resolveInit()
    assert.equal(board.data.ready, true)
    assert.equal(board.data.error, '')
  })
}

test('selector exceptions are handled and stale init callbacks are ignored', () => {
  const h = harness({ initialize: false })
  h.board.initCanvas()
  h.resolveInit([]) // Earlier attempt must not mark the newer one failed.
  assert.equal(h.board.data.error, '')
  h.resolveInit()
  assert.equal(h.board.data.ready, true)
  h.board.createSelectorQuery = () => { throw new Error('not mounted') }
  h.board.initCanvas()
  assert.equal(h.board.data.ready, false)
  assert.match(h.board.data.error, /初始化失败/)
})

test('a single tap fills actual black stub pixels and is exportable', () => {
  const { board, raster, exports } = harness()
  start(board)
  assert.ok(raster.countPixels(BLACK) > 0)
  assert.equal(raster.pixelAt(40, 40), BLACK)
  assert.ok(raster.calls.some((call) => call[0] === 'arc' && call[3] > 0))
  assert.ok(raster.calls.some((call) => call[0] === 'fill' && call[1] === '#000000'))
  assert.equal(board.data.hasInk, true)
  board.exportImage()
  assert.equal(exports.length, 0, 'Active stroke must finish before export')
  end(board)
  board.exportImage()
  assert.equal(exports.length, 1)
})

test('continuous movement and end position connect with round black lines', () => {
  const { board, raster } = harness()
  start(board, 10, 10)
  move(board, 40, 10)
  end(board, 40, 40)
  assert.deepEqual(raster.calls.filter((call) => call[0] === 'moveTo'), [
    ['moveTo', 10, 10], ['moveTo', 40, 10]
  ])
  assert.deepEqual(raster.calls.filter((call) => call[0] === 'lineTo'), [
    ['lineTo', 40, 10], ['lineTo', 40, 40]
  ])
  assert.equal(raster.pixelAt(50, 20), BLACK)
  assert.equal(raster.pixelAt(80, 50), BLACK)
  assert.equal(board._lastPoint, null)
  assert.equal(board._drawing, false)
  dot(board, 80, 60)
  assert.equal(raster.pixelAt(120, 100), WHITE, 'Separate strokes must not connect')
})

test('cancel ends a stroke, ignores subsequent moves and does not connect the next stroke', () => {
  const { board, raster } = harness()
  start(board, 10, 10)
  move(board, 30, 10)
  board.onTouchCancel()
  const callCount = raster.calls.length
  move(board, 80, 60)
  assert.equal(raster.calls.length, callCount)
  assert.equal(board._lastPoint, null)
  assert.equal(board._drawing, false)
  assert.equal(board.data.hasInk, true)
  dot(board, 80, 60)
  assert.equal(raster.pixelAt(110, 70), WHITE)
})

test('tracks only the active finger and ignores invalid coordinates', () => {
  const { board, raster } = harness()
  board.onTouchStart({ touches: [touch(NaN, 20)] })
  assert.equal(board.data.hasInk, false)
  start(board, 10, 10, 1)
  start(board, 90, 60, 2)
  board.onTouchMove({ touches: [touch(90, 60, 2), touch(30, 10, 1)] })
  end(board, 90, 60, 2)
  assert.equal(board._drawing, true)
  end(board, 40, 10, 1)
  assert.equal(board._drawing, false)
  assert.equal(raster.pixelAt(180, 120), WHITE)
  assert.equal(raster.pixelAt(60, 20), BLACK)
})

test('clear resets ink, preview, pending stroke and pixels; blank export is blocked', () => {
  const { board, raster, exports, toasts } = harness()
  board.exportImage()
  assert.equal(exports.length, 0)
  assert.match(toasts.at(-1).title, /请先/)
  dot(board)
  board.exportImage()
  exports[0].options.success({ tempFilePath: 'wxfile://preview.png' })
  assert.equal(board.data.previewPath, 'wxfile://preview.png')
  board.clear()
  assert.equal(board.data.previewPath, '')
  assert.equal(board.data.hasInk, false)
  assert.equal(board.data.exporting, false)
  assert.equal(board._lastPoint, null)
  assert.equal(raster.countPixels(WHITE), raster.canvas.width * raster.canvas.height)
  start(board)
  board.clear() // Clearing in the middle of a stroke must also stop that stroke.
  move(board, 70, 70)
  assert.equal(board.data.hasInk, false)
  assert.equal(board._drawing, false)
  assert.equal(raster.countPixels(BLACK), 0)
  board.exportImage()
  assert.equal(exports.length, 1)
  dot(board, 80, 60)
  assert.equal(raster.pixelAt(100, 80), WHITE)
})

test('exports PNG with the Canvas node, component scope and physical DPR dimensions', () => {
  const { board, raster, exports } = harness({ dpr: 3 })
  dot(board)
  board.exportImage()
  board.exportImage()
  assert.equal(exports.length, 1, 'Duplicate export while pending is blocked')
  const { options, scope } = exports[0]
  assert.equal(scope, board)
  assert.equal(options.canvas, raster.canvas)
  assert.equal(options.fileType, 'png')
  assert.equal(options.destWidth, 300)
  assert.equal(options.destHeight, 240)
  assert.equal(board.data.exporting, true)
  options.success({ tempFilePath: 'wxfile://local.png' })
  assert.equal(board.data.previewPath, 'wxfile://local.png')
  assert.equal(board.data.exporting, false)
  assert.equal(board.data.hasInk, true)
  assert.equal(board.data.error, '')
})

for (const mode of ['fail callback', 'missing path', 'throw']) {
  test(`export failure (${mode}) is reported, retains ink and permits retry`, () => {
    const { board, wx, exports, toasts } = harness()
    dot(board)
    const originalExport = wx.canvasToTempFilePath
    if (mode === 'throw') wx.canvasToTempFilePath = () => { throw new Error('export unavailable') }
    board.exportImage()
    if (mode === 'fail callback') exports[0].options.fail({ errMsg: 'failed' })
    if (mode === 'missing path') exports[0].options.success({})
    assert.equal(board.data.exporting, false)
    assert.equal(board.data.previewPath, '')
    assert.equal(board.data.hasInk, true)
    assert.match(board.data.error, /导出失败/)
    assert.equal(toasts.length, 1)
    wx.canvasToTempFilePath = originalExport
    board.exportImage()
    exports.at(-1).options.success({ tempFilePath: 'wxfile://retry.png' })
    assert.equal(board.data.previewPath, 'wxfile://retry.png')
    assert.equal(board.data.error, '')
  })
}

for (const mutation of ['clear', 'draw', 'detach']) {
  for (const callback of ['success', 'fail']) {
    test(`stale export ${callback} after ${mutation} cannot change preview or state`, () => {
      const h = harness()
      dot(h.board)
      h.board.exportImage()
      const old = h.exports[0].options
      if (mutation === 'clear') h.board.clear()
      if (mutation === 'draw') dot(h.board, 60, 40)
      if (mutation === 'detach') h.detach()
      const state = structuredClone(h.board.data)
      const updates = h.updates.length
      old[callback]({ tempFilePath: 'wxfile://stale.png' })
      assert.deepEqual(h.board.data, state)
      assert.equal(h.updates.length, updates)
      assert.equal(h.toasts.length, 0)
    })
  }
}

test('older export cannot stop a newer export or overwrite its completed preview', () => {
  const { board, exports } = harness()
  dot(board)
  board.exportImage()
  const old = exports[0].options
  board.clear()
  dot(board, 60, 40)
  board.exportImage()
  const current = exports[1].options
  old.fail({ errMsg: 'old failure' })
  assert.equal(board.data.exporting, true)
  current.success({ tempFilePath: 'wxfile://current.png' })
  old.success({ tempFilePath: 'wxfile://old.png' })
  assert.equal(board.data.previewPath, 'wxfile://current.png')
  assert.equal(board.data.exporting, false)
})

test('drawing invalidates an already displayed preview', () => {
  const { board, exports } = harness()
  dot(board)
  board.exportImage()
  exports[0].options.success({ tempFilePath: 'wxfile://old.png' })
  start(board, 70, 60)
  assert.equal(board.data.previewPath, '')
  assert.equal(board.data.hasInk, true)
})

test('detached component ignores late initialization and never exports', () => {
  const h = harness({ initialize: false })
  h.detach()
  h.resolveInit()
  h.board.exportImage()
  assert.equal(h.board.data.ready, false)
  assert.equal(h.exports.length, 0)
})
