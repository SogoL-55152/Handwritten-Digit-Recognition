const { request } = require('../../utils/request')

Page({
  data: {
    username: 'admin',
    password: 'admin123',
    loading: false
  },

  onLoad() {
    if (wx.getStorageSync('hdr_token')) {
      wx.reLaunch({ url: '/pages/index/index' })
    }
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
        const app = getApp()
        app.globalData.token = data.token
        app.globalData.user = data.user
        wx.setStorageSync('hdr_token', data.token)
        wx.setStorageSync('hdr_user', data.user)
        wx.reLaunch({ url: '/pages/index/index' })
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }))
  }
})
