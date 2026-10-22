const { upload } = require('../../utils/request')

Page({
  data: {
    result: null,
    confidenceText: '',
    modelName: '',
    submitting: false
  },

  onReady() {
    const query = wx.createSelectorQuery()
    query
      .select('#pad')
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) {
          wx.showToast({ title: '画板初始化失败', icon: 'none' })
          return
        }

        const canvas = info.node
        const context = canvas.getContext('2d')
        const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = windowInfo.pixelRatio || 2

        canvas.width = info.width * dpr
        canvas.height = info.height * dpr
        context.scale(dpr, dpr)

        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, info.width, info.height)
        context.lineWidth = 18
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.strokeStyle = '#111111'

        this.canvas = canvas
        this.context = context
        this.canvasWidth = info.width
        this.canvasHeight = info.height
        this.hasInk = false
        this.lastPoint = null
      })
  },

  onTouchStart(event) {
    if (!this.context) return
    const touch = event.touches[0]
    this.lastPoint = { x: touch.x, y: touch.y }
    this.context.beginPath()
    this.context.moveTo(touch.x, touch.y)
    this.hasInk = true
  },

  onTouchMove(event) {
    if (!this.context || !this.lastPoint) return
    const touch = event.touches[0]
    this.context.beginPath()
    this.context.moveTo(this.lastPoint.x, this.lastPoint.y)
    this.context.lineTo(touch.x, touch.y)
    this.context.stroke()
    this.lastPoint = { x: touch.x, y: touch.y }
  },

  onTouchEnd() {
    this.lastPoint = null
  },

  clearPad() {
    if (!this.context) return
    this.context.fillStyle = '#ffffff'
    this.context.fillRect(0, 0, this.canvasWidth, this.canvasHeight)
    this.hasInk = false
    this.setData({ result: null, confidenceText: '', modelName: '' })
  },

  recognize() {
    if (!this.hasInk) {
      wx.showToast({ title: '请先在画板上书写数字', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.canvasToTempFilePath({
      canvas: this.canvas,
      fileType: 'png',
      success: (res) => {
        upload({ url: '/api/recognition/predict', filePath: res.tempFilePath })
          .then((data) => {
            this.setData({
              result: data.result,
              confidenceText: `${((Number(data.confidence) || 0) * 100).toFixed(2)}%`,
              modelName: data.modelName || ''
            })
          })
          .catch(() => {})
          .finally(() => this.setData({ submitting: false }))
      },
      fail: () => {
        this.setData({ submitting: false })
        wx.showToast({ title: '画板导出失败', icon: 'none' })
      }
    })
  },

  logout() {
    const app = getApp()
    app.globalData.token = ''
    app.globalData.user = null
    wx.removeStorageSync('hdr_token')
    wx.removeStorageSync('hdr_user')
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
