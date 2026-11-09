const MAX_BYTES = 5 * 1024 * 1024
const MAX_EDGE = 2048
const MAX_PIXELS = 4194304
const HEADER_BYTES = 64 * 1024
const LOCAL_TIMEOUT_MS = 10000
const PICKER_TIMEOUT_MS = 120000

const cancelled = () => Object.assign(new Error('已取消选择'), { aborted: true })

// One settlement for callback/Promise APIs, including silent aborts and late callbacks.
function nativeCall(owner, method, options, message, timeout = LOCAL_TIMEOUT_MS) {
  let settled = false, timer, task, finish
  const promise = new Promise((resolve, reject) => {
    finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    if (!owner || typeof owner[method] !== 'function') {
      finish(new Error('当前微信版本不支持此图片操作，请更新微信后重试'))
      return
    }
    const fail = (error) => finish(/cancel/i.test(error && error.errMsg || '') ? cancelled() : new Error(message))
    timer = setTimeout(() => {
      finish(new Error('图片操作超时，请重新选择图片'))
      try { if (task && task.abort) task.abort() } catch (_) {}
    }, timeout)
    if (timer && timer.unref) timer.unref()
    try {
      task = owner[method]({ ...options, success: (value) => finish(null, value), fail })
      if (task && typeof task.then === 'function') task.then((value) => finish(null, value), fail)
    } catch (_) { finish(new Error(message)) }
  })
  promise.abort = () => {
    if (settled) return
    finish(cancelled())
    try { if (task && task.abort) task.abort() } catch (_) {}
  }
  return promise
}

function chooseAlbumImage() {
  const api = typeof wx === 'undefined' ? null : wx
  // Fallback only when chooseMedia is absent, never on cancellation or permission failure.
  const media = api && typeof api.chooseMedia === 'function'
  const task = nativeCall(api, media ? 'chooseMedia' : 'chooseImage', {
    count: 1, sourceType: ['album'], sizeType: ['original'], ...(media ? { mediaType: ['image'] } : {})
  }, '无法选择图片，请检查相册授权后重试', PICKER_TIMEOUT_MS)
  const promise = task.then((result) => {
    const files = result && (media ? result.tempFiles : result.tempFilePaths)
    const path = files && files.length === 1 && (media ? files[0].tempFilePath : files[0])
    if (typeof path !== 'string' || !path.trim()) throw new Error('未取得图片，请重新选择一张图片')
    return path
  })
  promise.abort = () => task.abort()
  return promise
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效，请更换图片')
  }
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new Error('图片尺寸过大：最长边不能超过 2048 像素，总像素不能超过 4194304')
  }
}

function parseHeader(buffer) {
  let bytes
  try {
    bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer)
  } catch (_) { throw new Error('无法读取图片内容，请更换图片') }
  if (!bytes.length || bytes.length > HEADER_BYTES) throw new Error('无法安全读取图片头，请更换图片')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = [137, 80, 78, 71, 13, 10, 26, 10]
  if (png.every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 ||
        bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
      throw new Error('PNG 图片头损坏，请更换图片')
    }
    const width = view.getUint32(16), height = view.getUint32(20)
    dimensions(width, height)
    return { type: 'png', mime: 'image/png', width, height }
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('仅支持实际内容为 PNG 或 JPEG 的图片')
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 218) break
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    if (offset + 2 > bytes.length) break
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) break
    // JPEG SOF markers excluding DHT, JPG and DAC.
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 8 || bytes[offset + 7] < 1 || length !== 8 + 3 * bytes[offset + 7]) break
      const height = view.getUint16(offset + 3), width = view.getUint16(offset + 5)
      dimensions(width, height)
      return { type: 'jpeg', mime: 'image/jpeg', width, height }
    }
    offset += length
  }
  throw new Error('JPEG 图片头损坏或过长，请更换图片')
}

function validateImage(filePath) {
  let task, aborted = false
  const promise = (async () => {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('未取得图片，请重新选择')
    const api = typeof wx === 'undefined' ? null : wx
    let fs
    try { fs = api && typeof api.getFileSystemManager === 'function' && api.getFileSystemManager() } catch (_) {}
    const call = async (owner, method, options, message) => {
      if (aborted) throw cancelled()
      task = nativeCall(owner, method, options, message)
      const value = await task
      if (aborted) throw cancelled()
      return value
    }
    const info = await call(fs && typeof fs.getFileInfo === 'function' ? fs : api, 'getFileInfo',
      { filePath }, '无法读取图片大小，请重新选择')
    const size = info && info.size
    if (!Number.isInteger(size) || size <= 0) throw new Error('图片为空或大小无效，请更换图片')
    if (size > MAX_BYTES) throw new Error('图片过大：单张图片不能超过 5 MiB')
    const length = Math.min(size, HEADER_BYTES)
    const read = await call(fs, 'readFile', { filePath, position: 0, length }, '无法读取图片内容，请重新选择')
    if (!read || !read.data || read.data.byteLength !== length) throw new Error('图片内容不完整或无法安全读取，请更换图片')
    const header = parseHeader(read.data)
    // Only decode after size, true format and bounded header dimensions pass.
    const decoded = await call(api, 'getImageInfo', { src: filePath }, '图片损坏或无法打开，请更换图片')
    const type = decoded && typeof decoded.type === 'string' ? decoded.type.toLowerCase() : ''
    dimensions(decoded && decoded.width, decoded && decoded.height)
    if ((type === 'jpg' ? 'jpeg' : type) !== header.type ||
        decoded.width !== header.width || decoded.height !== header.height) {
      throw new Error('图片格式或尺寸不一致，请更换图片')
    }
    // Keep the platform-owned original path, never decoded.path, a copy or a re-encode.
    return { filePath, size, ...header }
  })()
  promise.abort = () => { aborted = true; if (task) task.abort() }
  return promise
}

module.exports = { chooseAlbumImage, validateImage, parseHeader, MAX_BYTES, HEADER_BYTES, LOCAL_TIMEOUT_MS, PICKER_TIMEOUT_MS }
