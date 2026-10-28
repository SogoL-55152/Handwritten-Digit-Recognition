const { request } = require('../../utils/request')
const { readSession, saveSession } = require('../../utils/session')

Page({
  data: {
    username: 'admin',
    password: 'admin123',
    loading: false
  },

  onShow() {
    if (readSession()) {
      wx.reLaunch({ url: '/pages/index/index' })
    }
  },

  openDrawingPrototype() {
    wx.navigateTo({ url: '/pages/drawing-prototype/drawing-prototype' })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [field]: event.detail.value })
  },

  submit() {
    const { username, password } = this.data
    if (!username || !password) {
      wx.showToast({ title: '请输入用户名和密码', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    request({
      url: '/api/auth/login',
      method: 'POST',
      data: { username, password }
    })
      .then((data) => {
        if (!saveSession(data)) {
          wx.showToast({ title: '登录信息不完整，请重试', icon: 'none' })
          return
        }
        wx.reLaunch({ url: '/pages/index/index' })
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }))
  }
})
