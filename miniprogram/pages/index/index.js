Page({
  data: {
    user: null
  },

  onLoad() {
    const user = wx.getStorageSync('hdr_user') || null
    if (!user) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ user })
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
