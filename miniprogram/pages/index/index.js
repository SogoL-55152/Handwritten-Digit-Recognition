const { readSession, clearSession } = require('../../utils/session')

Page({
  data: {
    user: null
  },

  onShow() {
    const session = readSession()
    if (!session) {
      this.setData({ user: null })
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ user: session.user })
  },

  openDrawingPrototype() {
    wx.navigateTo({ url: '/pages/drawing-prototype/drawing-prototype' })
  },

  logout() {
    clearSession()
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
