const PEN_WIDTH = 16

Component({
  properties: { simple: { type: Boolean, value: false } },
  data: {
    ready: false,
    hasInk: false,
    exporting: false,
    previewPath: '',
    error: ''
  },

  lifetimes: {
    attached() {
      this._detached = false
      this._revision = 0
      this._exportId = 0
      this._initId = 0
      this._endStroke()
    },
    ready() {
      this.initCanvas()
    },
    detached() {
      this._detached = true
      if (this._cancelExport) this._cancelExport()
      this._initId += 1
      this._exportId += 1
      this._endStroke()
      this._canvas = null
      this._ctx = null
    }
  },

  methods: {
    initCanvas() {
      if (this._detached) return
      const initId = ++this._initId
      this._canvas = null
      this._ctx = null
      this._endStroke()
      this._markChanged(false)
      this.setData({ ready: false })
      const fail = () => {
        if (this._detached || initId !== this._initId) return
        this._canvas = null
        this._ctx = null
        this.setData({ ready: false, error: '画板初始化失败，请重试或检查基础库是否支持 Canvas 2D。' })
      }

      try {
        this.createSelectorQuery()
          .select('#drawing-canvas')
          .fields({ node: true, size: true })
          .exec((results) => {
            if (this._detached || initId !== this._initId) return
            try {
              const result = results && results[0]
              if (!result || !result.node || !(result.width > 0) || !(result.height > 0)) {
                fail()
                return
              }
              const canvas = result.node
              const ctx = canvas.getContext('2d')
              if (!ctx) {
                fail()
                return
              }
              const info = typeof wx.getWindowInfo === 'function'
                ? wx.getWindowInfo() : wx.getSystemInfoSync()
              const dpr = Number.isFinite(info.pixelRatio) && info.pixelRatio > 0 ? info.pixelRatio : 1
              this._width = result.width
              this._height = result.height
              // 触摸点使用 CSS 像素，底层位图使用设备像素；重设尺寸后只缩放一次。
              canvas.width = Math.round(result.width * dpr)
              canvas.height = Math.round(result.height * dpr)
              ctx.scale(canvas.width / result.width, canvas.height / result.height)
              ctx.lineWidth = PEN_WIDTH
              ctx.lineCap = 'round'
              ctx.lineJoin = 'round'
              ctx.strokeStyle = '#000000'
              this._canvas = canvas
              this._ctx = ctx
              this._paintWhite()
              this.setData({ ready: true, error: '' })
            } catch (error) {
              fail()
            }
          })
      } catch (error) {
        fail()
      }
    },

    _paintWhite() {
      this._ctx.fillStyle = '#ffffff'
      this._ctx.fillRect(0, 0, this._width, this._height)
      this._ctx.fillStyle = '#000000'
      this._ctx.beginPath()
    },

    _markChanged(hasInk) {
      if (this._cancelExport) this._cancelExport()
      this._revision += 1
      this._exportId += 1
      // 画布发生变化后，之前的异步导出不再属于当前画面。
      const next = { hasInk, previewPath: '', exporting: false, error: '' }
      if (Object.keys(next).some((key) => this.data[key] !== next[key])) {
        this.setData(next)
      }
      this.triggerEvent('change', { revision: this._revision, hasInk })
    },

    getSnapshot() {
      return {
        revision: this._revision, hasInk: this.data.hasInk,
        ready: !this._detached && this.data.ready, drawing: this._drawing
      }
    },

    _isReady() {
      if (!this._detached && this.data.ready && this._ctx && this._canvas) return true
      if (!this._detached) wx.showToast({ title: '画板尚未就绪，请稍后或重试', icon: 'none' })
      return false
    },

    _point(touch) {
      if (!touch || !Number.isFinite(touch.x) || !Number.isFinite(touch.y)) return null
      return {
        x: Math.max(0, Math.min(this._width, touch.x)),
        y: Math.max(0, Math.min(this._height, touch.y))
      }
    },

    onTouchStart(event) {
      if (!this._isReady() || this._drawing) return
      const touch = (event.changedTouches && event.changedTouches[0]) ||
        (event.touches && event.touches[0])
      const point = this._point(touch)
      if (!point) return
      this._drawing = true
      this._activeTouchId = touch.identifier
      this._lastPoint = point
      // 零长度 stroke 不保证产生像素；按下即填充实心圆，保证单点可导出。
      this._ctx.beginPath()
      this._ctx.arc(point.x, point.y, PEN_WIDTH / 2, 0, Math.PI * 2)
      this._ctx.fill()
      this._markChanged(true)
    },

    onTouchMove(event) {
      if (!this._drawing || !this._isReady()) return
      const touch = (event.touches || []).find((item) => item.identifier === this._activeTouchId)
      this._drawTo(this._point(touch))
    },

    _drawTo(point) {
      if (!point || !this._lastPoint) return
      if (point.x === this._lastPoint.x && point.y === this._lastPoint.y) return
      this._ctx.beginPath()
      this._ctx.moveTo(this._lastPoint.x, this._lastPoint.y)
      this._ctx.lineTo(point.x, point.y)
      this._ctx.stroke()
      this._lastPoint = point
      this._markChanged(true)
    },

    onTouchEnd(event) {
      if (!this._drawing) return
      const changed = event.changedTouches || []
      const touch = changed.find((item) => item.identifier === this._activeTouchId)
      if (changed.length && !touch) return
      if (this._ctx) this._drawTo(this._point(touch))
      this._endStroke()
    },

    onTouchCancel() {
      this._endStroke()
    },

    _endStroke() {
      this._drawing = false
      this._activeTouchId = null
      this._lastPoint = null
    },

    clear() {
      if (!this._isReady()) return
      this._endStroke()
      this._paintWhite()
      this._markChanged(false)
    },

    exportImage() {
      // The original local-preview button consumes errors; business callers await the narrow API.
      this.exportSnapshot(true).catch(() => {})
    },

    exportSnapshot(showToast = false) {
      const invalid = (message, toast = showToast) => {
        if (toast && !this._detached) wx.showToast({ title: message, icon: 'none' })
        return Promise.reject(new Error(message))
      }
      if (!this._detached && (!this.data.ready || !this._ctx || !this._canvas)) {
        return invalid('画板尚未就绪，请稍后或重试')
      }
      if (this._detached) return invalid('画板已离开', false)
      if (!this.data.hasInk) return invalid('请先在画板上书写')
      if (this._drawing) return invalid('请先结束当前笔画')
      if (this.data.exporting) return invalid('画板正在导出', false)
      const revision = this._revision
      const exportId = ++this._exportId
      const isCurrent = () => !this._detached && revision === this._revision && exportId === this._exportId
      this.setData({ exporting: true, error: '' })
      return new Promise((resolve, reject) => {
        let settled = false
        let timer
        const finish = (error, image) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (this._cancelExport === cancel) this._cancelExport = null
          if (error) reject(error)
          else resolve(image)
        }
        const cancel = () => finish(Object.assign(new Error('画板已变化'), { stale: true }))
        this._cancelExport = cancel
        const fail = () => {
          if (settled) return
          if (!isCurrent()) { cancel(); return }
          this.setData({ exporting: false, error: 'PNG 导出失败，请重试。' })
          if (showToast) wx.showToast({ title: 'PNG 导出失败，请重试', icon: 'none' })
          finish(new Error('PNG 导出失败，请重试'))
        }
        timer = setTimeout(fail, 10000)
        if (timer && timer.unref) timer.unref()
        try {
          wx.canvasToTempFilePath({
            canvas: this._canvas,
            fileType: 'png',
            destWidth: this._canvas.width,
            destHeight: this._canvas.height,
            success: (result) => {
              if (settled) return
              if (!isCurrent()) { cancel(); return }
              if (!result || !result.tempFilePath) { fail(); return }
              this.setData({ previewPath: result.tempFilePath, exporting: false, error: '' })
              finish(null, { filePath: result.tempFilePath, revision })
            },
            fail
          }, this)
        } catch (_) { fail() }
      })
    }
  }
})
