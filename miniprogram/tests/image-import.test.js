const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const {
  chooseAlbumImage, validateImage, parseHeader, MAX_BYTES, HEADER_BYTES, LOCAL_TIMEOUT_MS, PICKER_TIMEOUT_MS
} = require('../utils/image-import')
const flush = () => new Promise(resolve => setImmediate(resolve))
const PATH = 'wxfile://selected.wrong-extension'
function png(width = 28, height = 28) {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}
function jpeg(width = 28, height = 28, marker = 192) {
  const bytes = Uint8Array.from([255, 216, 255, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 17, 0, 255, 217])
  new DataView(bytes.buffer).setUint16(7, height)
  new DataView(bytes.buffer).setUint16(9, width)
  return bytes
}
function harness({ bytes = png(), size = bytes.length, decoded, stage } = {}) {
  const calls = [], pending = []
  const invoke = (name, options, value) => {
    calls.push({ name, options })
    if (stage === name) pending.push(options)
    else options.success(value)
  }
  const fs = {
    getFileInfo: options => invoke('size', options, { size }),
    readFile: options => invoke('header', options, { data: bytes.buffer }),
    unlink: () => assert.fail('Never delete platform-owned originals'),
    copyFile: () => assert.fail('Never copy or transcode originals')
  }
  global.wx = {
    getFileSystemManager: () => fs,
    getImageInfo: options => invoke('decode', options, decoded || { width: 28, height: 28, type: 'png', path: 'wxfile://decoder-copy.png' }),
    uploadFile: () => assert.fail('No helper uploads'),
    request: () => assert.fail('No helper network'),
    getRandomValues: () => assert.fail('No ID before explicit recognition'),
    setStorageSync: () => assert.fail('No image storage'),
    compressImage: () => assert.fail('No transcode')
  }
  return { fs, calls, pending }
}
afterEach(() => { delete global.wx })

test('chooseMedia requests exactly one original album image', async () => {
  let options
  global.wx = { chooseMedia: value => { options = value; value.success({ tempFiles: [{ tempFilePath: PATH }] }) } }
  assert.equal(await chooseAlbumImage(), PATH)
  assert.deepEqual({ count: options.count, sourceType: options.sourceType, mediaType: options.mediaType, sizeType: options.sizeType },
    { count: 1, sourceType: ['album'], mediaType: ['image'], sizeType: ['original'] })
})

test('absent chooseMedia falls back to chooseImage with original album only', async () => {
  global.wx = { chooseImage(options) {
    assert.equal(options.count, 1)
    assert.deepEqual(options.sourceType, ['album'])
    assert.deepEqual(options.sizeType, ['original'])
    assert.equal(options.mediaType, undefined)
    options.success({ tempFilePaths: [PATH] })
  } }
  assert.equal(await chooseAlbumImage(), PATH)
})

for (const mode of ['cancel', 'denied', 'throw']) {
  test(`chooseMedia ${mode} never falls back or reveals native diagnostics`, async () => {
    global.wx = { chooseImage: () => assert.fail('No fallback after a native error'), chooseMedia(options) {
      if (mode === 'throw') throw new Error('sensitive')
      options.fail({ errMsg: mode === 'cancel' ? 'chooseMedia:fail cancel' : 'sensitive' })
    } }
    await assert.rejects(chooseAlbumImage(), error => {
      assert.doesNotMatch(error.message, /sensitive/)
      assert.equal(!!error.aborted, mode === 'cancel')
      return true
    })
  })
}

for (const result of [{}, { tempFiles: [] }, { tempFiles: [{}, {}] }, { tempFiles: [{}] }]) {
  test(`picker malformed response ${JSON.stringify(result)} is rejected`, async () => {
    global.wx = { chooseMedia: ({ success }) => success(result) }
    await assert.rejects(chooseAlbumImage(), /重新选择/)
  })
}

test('picker silent timeout, abort and late callbacks are bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let callback
  global.wx = { chooseMedia(options) { callback = options } }
  const task = chooseAlbumImage()
  const rejected = assert.rejects(task, /超时/)
  t.mock.timers.tick(PICKER_TIMEOUT_MS)
  callback.success({ tempFiles: [{ tempFilePath: PATH }] })
  await rejected
  const next = chooseAlbumImage()
  const aborted = assert.rejects(next, error => error.aborted)
  next.abort()
  callback.success({ tempFiles: [{ tempFilePath: PATH }] })
  await aborted
})

test('picker callback wins over duplicate callback and Promise rejection', async () => {
  global.wx = { chooseMedia(options) {
    options.success({ tempFiles: [{ tempFilePath: PATH }] })
    options.fail({ errMsg: 'late' })
    return Promise.reject(new Error('late'))
  } }
  assert.equal(await chooseAlbumImage(), PATH)
  await flush()
})

for (const type of ['png', 'jpeg', 'jpg']) {
  test(`valid ${type} checks bytes before decode, canonicalizes type and keeps original path`, async () => {
    const bytes = type === 'png' ? png() : jpeg()
    const h = harness({ bytes, decoded: { width: 28, height: 28, type, path: 'wxfile://not-the-original.png' } })
    const image = await validateImage(PATH)
    assert.equal(image.filePath, PATH)
    assert.equal(image.mime, type === 'png' ? 'image/png' : 'image/jpeg')
    assert.equal(image.type, type === 'png' ? 'png' : 'jpeg')
    assert.deepEqual(h.calls.map(call => call.name), ['size', 'header', 'decode'])
    assert.equal(h.calls[1].options.position, 0)
    assert.equal(h.calls[1].options.length, bytes.length)
    assert.equal(h.calls[2].options.src, PATH)
  })
}

for (const size of [0, -1, NaN, undefined, MAX_BYTES + 1]) {
  test(`invalid/oversize size ${size} is rejected before any read or decode`, async () => {
    const h = harness({ size: size === undefined ? null : size })
    await assert.rejects(validateImage(PATH), /为空|大小无效|5 MiB/)
    assert.deepEqual(h.calls.map(call => call.name), ['size'])
  })
}

test('exact 5 MiB reads at most 64 KiB and never reads whole file', async () => {
  const bytes = new Uint8Array(HEADER_BYTES)
  bytes.set(png())
  const h = harness({ bytes, size: MAX_BYTES })
  assert.equal((await validateImage(PATH)).size, MAX_BYTES)
  assert.equal(h.calls[1].options.length, HEADER_BYTES)
})

for (const [name, bytes] of [
  ['PNG width', png(2049, 28)], ['PNG height', png(28, 2049)], ['PNG zero', png(0, 28)],
  ['PNG unsigned huge', png(0xffffffff, 28)], ['JPEG width', jpeg(2049, 28)], ['JPEG height', jpeg(28, 2049)],
  ['GIF pretending PNG', Uint8Array.from([71, 73, 70, 56, 57, 97])], ['truncated PNG', png().slice(0, 24)],
  ['truncated JPEG', jpeg().slice(0, 10)], ['JPEG without SOF', Uint8Array.from([255, 216, 255, 217])]
]) {
  test(`${name} fails before getImageInfo can allocate decoded pixels`, async () => {
    const h = harness({ bytes })
    await assert.rejects(validateImage(PATH), /尺寸|PNG|JPEG/)
    assert.deepEqual(h.calls.map(call => call.name), ['size', 'header'])
  })
}

test('2048 squared boundary is accepted; progressive JPEG and offset buffers parse correctly', () => {
  assert.equal(parseHeader(png(2048, 2048)).width, 2048)
  const bytes = new Uint8Array(100)
  bytes.set(jpeg(2048, 2048, 194), 12)
  assert.equal(parseHeader(bytes.subarray(12, 29)).mime, 'image/jpeg')
})

test('JPEG metadata segments are walked with bounds; huge metadata fails closed', () => {
  const image = jpeg()
  const bytes = Uint8Array.from([...image.slice(0, 2), 255, 225, 0, 4, 0, 0, ...image.slice(2)])
  assert.equal(parseHeader(bytes).type, 'jpeg')
  bytes[4] = 255
  assert.throws(() => parseHeader(bytes), /图片头损坏或过长/)
  assert.throws(() => parseHeader(new Uint8Array(HEADER_BYTES + 1)), /安全读取/)
})

for (const decoded of [
  { width: 28, height: 28, type: 'gif' }, { width: 29, height: 28, type: 'png' },
  { width: 2049, height: 28, type: 'png' }, { width: 0, height: 28, type: 'png' }, {}
]) {
  test(`decode metadata mismatch ${JSON.stringify(decoded)} is rejected`, async () => {
    harness({ decoded })
    await assert.rejects(validateImage(PATH), /格式|尺寸/)
  })
}

for (const stage of ['size', 'header', 'decode']) {
  for (const outcome of ['fail', 'abort', 'timeout']) {
    test(`${stage} ${outcome} settles without accepting late success`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const h = harness({ stage })
      const task = validateImage(PATH)
      const rejected = assert.rejects(task, error => {
        assert.doesNotMatch(error.message, /sensitive/)
        return outcome !== 'abort' || error.aborted
      })
      await flush()
      if (outcome === 'abort') task.abort()
      else if (outcome === 'timeout') t.mock.timers.tick(LOCAL_TIMEOUT_MS)
      else h.pending[0].fail({ errMsg: 'sensitive' })
      h.pending[0].success(stage === 'size' ? { size: 33 } : stage === 'header' ? { data: png().buffer } : { width: 28, height: 28, type: 'png' })
      await rejected
    })
  }
}

for (const api of ['picker', 'filesystem', 'readFile', 'decode']) {
  test(`missing ${api} API produces update/retry guidance`, async () => {
    const h = harness()
    if (api === 'picker') await assert.rejects(chooseAlbumImage(), /更新微信/)
    if (api === 'filesystem') { delete wx.getFileSystemManager; await assert.rejects(validateImage(PATH), /更新微信/) }
    if (api === 'readFile') { delete h.fs.readFile; await assert.rejects(validateImage(PATH), /更新微信/) }
    if (api === 'decode') { delete wx.getImageInfo; await assert.rejects(validateImage(PATH), /更新微信/) }
  })
}

test('a legacy unbounded read response is rejected rather than decoded', async () => {
  const h = harness({ size: MAX_BYTES })
  h.fs.readFile = options => options.success({ data: new ArrayBuffer(MAX_BYTES) })
  await assert.rejects(validateImage(PATH), /安全读取/)
  assert.equal(h.calls.some(call => call.name === 'decode'), false)
})
