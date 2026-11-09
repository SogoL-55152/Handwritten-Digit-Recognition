export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_EDGE = 2048
export const MAX_IMAGE_PIXELS = 4194304

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('图片尺寸无效或文件已损坏')
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸过大：最长边不得超过 2048 像素，总像素不得超过 4194304')
  }
  return { width, height }
}

// Read encoded dimensions before asking the browser to expand any pixels.
// Extensions, file.type and the file input accept filter are not trusted.
export function imageHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = [137, 80, 78, 71, 13, 10, 26, 10]
  if (png.every((byte, i) => bytes[i] === byte)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('PNG 文件头损坏')
    return { mime: 'image/png', ...dimensions(view.getUint32(16), view.getUint32(20)) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset++]
      if (marker === undefined || marker === 0 || marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || length !== 8 + 3 * bytes[offset + 7] || !bytes[offset + 7]) break
        return { mime: 'image/jpeg', ...dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)) }
      }
      offset += length
    }
    throw new Error('JPEG 文件头损坏或缺少尺寸信息')
  }
  throw new Error('只支持真实的 PNG 或 JPEG 图片，请更换文件')
}

const cancelled = () => new DOMException('图片选择已取消', 'AbortError')
function abortable(promise, signal, closeLate = () => {}) {
  return new Promise((resolve, reject) => {
    let finished = false
    const abort = () => { finished = true; signal?.removeEventListener('abort', abort); reject(cancelled()) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then((value) => {
      if (finished) { closeLate(value); return }
      finished = true
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }, (error) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

function decodeImage(file, url, signal) {
  if (typeof globalThis.createImageBitmap === 'function') return globalThis.createImageBitmap(file, { imageOrientation: 'none' })
  // Older browsers: still decode off-canvas, with explicit load/cancel cleanup.
  return new Promise((resolve, reject) => {
    const image = new Image()
    const close = () => { image.onload = null; image.onerror = null; image.src = ''; signal?.removeEventListener('abort', abort) }
    const abort = () => { close(); reject(cancelled()) }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      signal?.removeEventListener('abort', abort)
      resolve({ width: image.naturalWidth, height: image.naturalHeight, close })
    }
    image.onerror = () => { close(); reject(new Error('图片已损坏或浏览器无法解码，请更换图片')) }
    image.src = url
  })
}

// Returns an owned local preview plus the original encoded bytes, never a canvas
// export. The caller must dispose the preview on replacement, reset or unmount.
export async function prepareImage(file, {
  signal, decode = decodeImage,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url)
} = {}) {
  if (signal?.aborted) throw cancelled()
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('图片为空，请选择 PNG 或 JPEG 文件')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片过大，单张图片不得超过 5 MiB')
  const bytes = new Uint8Array(await abortable(file.arrayBuffer(), signal))
  if (bytes.length !== file.size) throw new Error('图片读取不完整，请重新选择')
  const header = imageHeader(bytes)
  // Only canonicalize MIME. No resizing, recompression or metadata stripping.
  const image = file.slice(0, file.size, header.mime)
  const previewUrl = createObjectURL(image)
  let released = false
  const dispose = () => { if (!released) { released = true; revokeObjectURL(previewUrl) } }
  let decoded
  try {
    decoded = await abortable(Promise.resolve().then(() => {
      if (signal?.aborted) throw cancelled()
      return decode(image, previewUrl, signal)
    }), signal, (late) => late?.close?.())
    dimensions(decoded.width, decoded.height)
    const sameSize = decoded.width === header.width && decoded.height === header.height
    const orientedJpeg = header.mime === 'image/jpeg' && decoded.width === header.height && decoded.height === header.width
    if (!sameSize && !orientedJpeg) throw new Error('图片尺寸与文件头不一致，请更换图片')
    if (signal?.aborted) throw cancelled()
    return { file: image, previewUrl, mime: header.mime, width: decoded.width, height: decoded.height, size: image.size, dispose }
  } catch (error) {
    dispose()
    if (error?.name === 'AbortError') throw error
    throw new Error(error?.message?.includes('尺寸') ? error.message : '图片已损坏或浏览器无法解码，请更换图片')
  } finally { decoded?.close?.() }
}
