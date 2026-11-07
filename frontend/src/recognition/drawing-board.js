// Pointer Events controller; logical coordinates stay normalized across DPR/size changes.
export function createDrawingBoard({ canvas, onChange = () => {}, getDpr = () => globalThis.devicePixelRatio || 1 }) {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  let strokes = []
  let activePointer = null
  let revision = 0
  let size = 320
  let disposed = false
  function changed() { revision += 1; onChange({ revision, hasInk: strokes.length > 0, drawing: activePointer !== null }) }
  function paint() {
    const scale = canvas.width / size
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = '#111111'
    ctx.fillStyle = '#111111'
    ctx.lineWidth = size * 0.055
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes) {
      const first = stroke[0]
      ctx.beginPath()
      ctx.arc(first.x * size, first.y * size, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill() // A single tap must leave visible ink.
      if (stroke.length > 1) {
        ctx.beginPath()
        ctx.moveTo(first.x * size, first.y * size)
        for (const point of stroke.slice(1)) ctx.lineTo(point.x * size, point.y * size)
        ctx.stroke()
      }
    }
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  function down(event) {
    if (disposed || activePointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.preventDefault()
    activePointer = event.pointerId
    strokes.push([point(event)])
    canvas.setPointerCapture?.(event.pointerId)
    paint()
    changed()
  }
  function move(event) {
    if (event.pointerId !== activePointer || disposed) return
    event.preventDefault()
    strokes[strokes.length - 1].push(point(event))
    paint()
    changed()
  }
  function finish(event) {
    if (event.pointerId !== activePointer || disposed) return
    if (event.type === 'pointerup') {
      strokes[strokes.length - 1].push(point(event))
      paint()
    }
    const pointer = activePointer
    activePointer = null
    if (canvas.hasPointerCapture?.(pointer)) canvas.releasePointerCapture(pointer)
    changed()
  }
  function clear() {
    const pointer = activePointer
    activePointer = null
    if (pointer !== null && canvas.hasPointerCapture?.(pointer)) canvas.releasePointerCapture(pointer)
    strokes = []
    paint()
    changed()
  }
  function resize() {
    const width = canvas.getBoundingClientRect().width
    if (disposed || !Number.isFinite(width) || width <= 0) return // v-show: never resize a hidden canvas.
    size = Math.max(1, width)
    const pixels = Math.min(2048, Math.max(1, Math.round(size * Math.min(3, Math.max(1, getDpr())))))
    if (canvas.width === pixels && canvas.height === pixels) return
    canvas.width = pixels
    canvas.height = pixels
    paint()
    changed() // Pixel-byte changes also invalidate an in-flight export/request.
  }
  function exportPng() {
    if (disposed || !strokes.length || activePointer !== null) return Promise.reject(new Error('请先完成一个数字的书写'))
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
      if (!blob) reject(new Error('无法导出画板，请重试'))
      else if (blob.size > 5 * 1024 * 1024) reject(new Error('图片超出 5 MiB 限制'))
      else resolve(blob)
    }, 'image/png'))
  }
  const handlers = { pointerdown: down, pointermove: move, pointerup: finish, pointercancel: finish, lostpointercapture: finish }
  for (const [event, handler] of Object.entries(handlers)) canvas.addEventListener(event, handler)
  resize()
  return { clear, resize, exportPng,
    dispose() {
      clear()
      disposed = true
      for (const [event, handler] of Object.entries(handlers)) canvas.removeEventListener(event, handler)
    }
  }
}
