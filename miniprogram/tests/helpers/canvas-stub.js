// Minimal software Canvas 2D stub: records commands and rasterizes the operations
// used by drawing-board. This is not a substitute for WeChat rendering checks.
function createCanvasStub() {
  const calls = []
  let width = 0
  let height = 0
  let pixels = new Uint32Array()
  let sx = 1
  let sy = 1
  let path = []
  const reset = () => {
    pixels = new Uint32Array(width * height)
    sx = 1
    sy = 1
    path = []
  }
  const color = (style) => style === '#ffffff' ? 0xffffffff : 0xff000000
  const paint = (contains, style) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (contains((x + 0.5) / sx, (y + 0.5) / sy)) {
          pixels[y * width + x] = color(style)
        }
      }
    }
  }
  const ctx = {
    scale(x, y) {
      calls.push(['scale', x, y])
      sx *= x
      sy *= y
    },
    fillRect(x, y, w, h) {
      calls.push(['fillRect', x, y, w, h, this.fillStyle])
      paint((px, py) => px >= x && px < x + w && py >= y && py < y + h, this.fillStyle)
    },
    beginPath() {
      calls.push(['beginPath'])
      path = []
    },
    arc(x, y, radius, start, end) {
      calls.push(['arc', x, y, radius, start, end])
      path.push({ kind: 'circle', x, y, radius })
    },
    fill() {
      calls.push(['fill', this.fillStyle])
      for (const circle of path) {
        if (circle.kind !== 'circle') continue
        paint((x, y) => (x - circle.x) ** 2 + (y - circle.y) ** 2 <= circle.radius ** 2, this.fillStyle)
      }
    },
    moveTo(x, y) {
      calls.push(['moveTo', x, y])
      path.push({ kind: 'move', x, y })
    },
    lineTo(x, y) {
      calls.push(['lineTo', x, y])
      path.push({ kind: 'line', x, y })
    },
    stroke() {
      calls.push(['stroke', this.strokeStyle, this.lineWidth, this.lineCap, this.lineJoin])
      const [from, to] = path
      if (!from || !to) return
      const dx = to.x - from.x
      const dy = to.y - from.y
      const lengthSquared = dx * dx + dy * dy
      paint((x, y) => {
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
          ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared))
        return (x - from.x - t * dx) ** 2 + (y - from.y - t * dy) ** 2 <= (this.lineWidth / 2) ** 2
      }, this.strokeStyle)
    }
  }
  const canvas = {
    get width() { return width },
    set width(value) { width = value; reset() },
    get height() { return height },
    set height(value) { height = value; reset() },
    getContext(type) {
      if (type !== '2d') throw new Error('Only Canvas 2D is supported')
      return ctx
    }
  }
  return {
    canvas,
    ctx,
    calls,
    pixelAt(x, y) { return pixels[y * width + x] },
    countPixels(value) { return pixels.reduce((count, pixel) => count + Number(pixel === value), 0) }
  }
}

module.exports = { createCanvasStub }
