const { getRuntime } = require('../../config/runtime')

Page({
  data: { operator: '', contact: '', configurationError: '' },
  onShow() {
    const runtime = getRuntime()
    this.setData({ operator: runtime.operator || '未配置', contact: runtime.contact || '未配置，请向提供试用入口的维护者咨询', configurationError: runtime.error })
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },
  openLogin() { wx.reLaunch({ url: '/pages/login/login' }) }
})
