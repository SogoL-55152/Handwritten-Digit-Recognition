const { getRuntime } = require('../../config/runtime')

Page({
  data: { operator: '', contact: '', privacyVersion: '', configurationError: '' },
  onShow() {
    const runtime = getRuntime()
    this.setData({ operator: runtime.operator || '未配置', contact: runtime.contact || '未配置，请向提供试用入口的维护者咨询',
      privacyVersion: runtime.privacyVersion || '未配置（本地候选说明，非正式发布）', configurationError: runtime.error })
  },
  openHelp() { wx.navigateTo({ url: '/pages/help/help' }) }
})
