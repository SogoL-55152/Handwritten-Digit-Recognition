import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareImage, imageHeader, MAX_IMAGE_BYTES } from '../src/recognition/image-import.js'

// Encoded header fixtures; decoding is an explicit browser boundary, not simulated accuracy.
function png(width = 28, height = 28) {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width); view.setUint32(20, height)
  return bytes
}
function jpeg(width = 28, height = 28, marker = 0xc0) {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, marker, 0, 11, 8,
    height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9])
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function environment(overrides = {}) {
  const urls = [], revoked = [], decoded = [], closed = []
  return { urls, revoked, decoded, closed, options: {
    createObjectURL: (blob) => { urls.push(blob); return `blob:local/${urls.length}` },
    revokeObjectURL: (url) => revoked.push(url),
    decode: async (blob) => {
      decoded.push(blob)
      return { ...imageHeader(new Uint8Array(await blob.arrayBuffer())), close: () => closed.push(blob) }
    }, ...overrides
  } }
}

test('production import preserves every byte, canonicalizes MIME and owns local PNG/JPEG previews', async (t) => {
  for (const [bytes, mime] of [[png(), 'image/png'], [jpeg(), 'image/jpeg'], [jpeg(28, 28, 0xc2), 'image/jpeg']]) {
    await t.test(mime, async () => {
      const env = environment()
      const file = new File([bytes], 'wrong-extension.txt', { type: 'text/plain' })
      const selected = await prepareImage(file, env.options)
      assert.equal(selected.file.type, mime)
      assert.equal(selected.mime, mime)
      assert.deepEqual(new Uint8Array(await selected.file.arrayBuffer()), bytes)
      assert.equal(selected.width, 28); assert.equal(selected.height, 28)
      assert.equal(env.urls.length, 1); assert.equal(env.decoded.length, 1)
      assert.equal(env.closed.length, 1, 'decoded bitmap is closed, not retained as the preview')
      assert.deepEqual(env.revoked, [])
      selected.dispose(); selected.dispose()
      assert.deepEqual(env.revoked, ['blob:local/1'])
    })
  }
})

test('empty, oversize, unsupported and corrupt encoded headers are rejected before URL or decode', async (t) => {
  const badPng = png(); badPng[12] = 0
  const badJpeg = jpeg(); badJpeg[11] = 255
  const cases = [new Blob(), new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)]),
    new File(['not png'], 'fake.png', { type: 'image/png' }), new Blob([badPng]), new Blob([png().slice(0, 24)]),
    new Blob([badJpeg]), new Blob([jpeg().slice(0, 18)]), new Blob([[0xff, 0xd8]]),
    new Blob([png(0, 28)]), new Blob([jpeg(0, 28)]),
    new Blob([png(2049, 1)]), new Blob([png(1, 2049)]), new Blob([png(65535, 65535)]),
    new Blob([jpeg(2049, 1)]), new Blob([jpeg(1, 2049)])]
  for (const [i, file] of cases.entries()) await t.test(String(i), async () => {
    const env = environment()
    await assert.rejects(prepareImage(file, env.options))
    assert.equal(env.urls.length, 0); assert.equal(env.decoded.length, 0)
  })
})

test('size checks precede byte reads; truncated reads fail closed and exact limits are accepted', async () => {
  let reads = 0
  await assert.rejects(prepareImage({ size: MAX_IMAGE_BYTES + 1, arrayBuffer: () => { reads += 1 } }), /5 MiB/)
  assert.equal(reads, 0)
  await assert.rejects(prepareImage({ size: 33, arrayBuffer: async () => new ArrayBuffer(32) }), /读取不完整/)
  const bytes = new Uint8Array(MAX_IMAGE_BYTES); bytes.set(png(2048, 2048))
  const env = environment()
  const selected = await prepareImage(new Blob([bytes]), env.options)
  assert.equal(selected.size, MAX_IMAGE_BYTES)
  assert.equal(selected.width * selected.height, 4194304)
  selected.dispose()
})

test('valid headers cannot bypass failed decode, decoded dimensions or header mismatch; resources close', async (t) => {
  for (const decoded of [null, { width: 0, height: 28 }, { width: 2049, height: 28 }, { width: 27, height: 28 }]) {
    await t.test(JSON.stringify(decoded), async () => {
      let closed = 0
      const env = environment({ decode: async () => {
        if (!decoded) throw new Error('decoder failed')
        return { ...decoded, close: () => { closed += 1 } }
      } })
      await assert.rejects(prepareImage(new Blob([png()]), env.options), /损坏|尺寸/)
      assert.deepEqual(env.revoked, ['blob:local/1'])
      assert.equal(closed, decoded ? 1 : 0)
    })
  }
})

test('JPEG browser orientation may swap dimensions but never alters uploaded bytes', async () => {
  const bytes = jpeg(40, 28)
  const env = environment({ decode: async () => ({ width: 28, height: 40, close() {} }) })
  const selected = await prepareImage(new Blob([bytes]), env.options)
  assert.equal(selected.width, 28)
  assert.deepEqual(new Uint8Array(await selected.file.arrayBuffer()), bytes)
  selected.dispose()
})

test('cancel before read or during read never creates a preview or starts decoding', async () => {
  const env = environment(), aborted = new AbortController()
  aborted.abort()
  await assert.rejects(prepareImage(new Blob([png()]), { ...env.options, signal: aborted.signal }), { name: 'AbortError' })
  const pending = deferred(), abort = new AbortController()
  const reading = prepareImage({ size: 33, arrayBuffer: () => pending.promise }, { ...env.options, signal: abort.signal })
  abort.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  pending.resolve(png().buffer)
  await Promise.resolve()
  assert.equal(env.urls.length, 0); assert.equal(env.decoded.length, 0)
})

test('cancel during bitmap decode revokes URL immediately and closes a late bitmap exactly once', async () => {
  const pending = deferred(), started = deferred(), abort = new AbortController()
  let closed = 0
  const env = environment({ decode: () => { started.resolve(); return pending.promise } })
  const loading = prepareImage(new Blob([png()]), { ...env.options, signal: abort.signal })
  await started.promise
  abort.abort()
  await assert.rejects(loading, { name: 'AbortError' })
  assert.deepEqual(env.revoked, ['blob:local/1'])
  pending.resolve({ width: 28, height: 28, close: () => { closed += 1 } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, 1)
  assert.equal(env.revoked.length, 1)
})

test('production browser bitmap adapter receives canonical original bytes and closes decoded resource', async () => {
  const previous = globalThis.createImageBitmap
  const env = environment()
  let calls = 0, closed = 0
  try {
    globalThis.createImageBitmap = async (blob, options) => {
      calls += 1
      assert.equal(blob.type, 'image/jpeg')
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), jpeg())
      assert.equal(options.imageOrientation, 'none')
      return { width: 28, height: 28, close: () => { closed += 1 } }
    }
    const { decode, ...options } = env.options
    const selected = await prepareImage(new Blob([jpeg()]), options)
    assert.equal(calls, 1); assert.equal(closed, 1)
    selected.dispose()
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previous
  }
})

test('production Image fallback detaches callbacks and source on load, error and cancellation', async (t) => {
  for (const outcome of ['load', 'error', 'abort']) await t.test(outcome, async () => {
    const previousBitmap = globalThis.createImageBitmap, previousImage = globalThis.Image
    const started = deferred(), env = environment(), abort = new AbortController()
    let image
    try {
      delete globalThis.createImageBitmap
      globalThis.Image = class {
        constructor() { image = this; this.naturalWidth = 28; this.naturalHeight = 28 }
        set src(value) { this.value = value; if (value) started.resolve() }
      }
      const { decode, ...options } = env.options
      const loading = prepareImage(new Blob([png()]), { ...options, signal: abort.signal })
      await started.promise
      if (outcome === 'load') {
        image.onload()
        const selected = await loading
        assert.deepEqual(env.revoked, [])
        selected.dispose()
      } else {
        if (outcome === 'error') image.onerror(); else abort.abort()
        await assert.rejects(loading)
      }
      assert.equal(image.value, '')
      assert.equal(image.onload, null); assert.equal(image.onerror, null)
      assert.deepEqual(env.revoked, ['blob:local/1'])
    } finally {
      if (previousBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousBitmap
      if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage
    }
  })
})
