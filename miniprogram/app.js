const { readSession } = require('./utils/session')

App({
  globalData: {
    // 本地调试：微信开发者工具需勾选“不校验合法域名”
    // 真机调试请改为电脑局域网 IP，例如 http://192.168.1.10:8080
    baseUrl: 'http://localhost:8080',
    token: '',
    user: null
  },

  onLaunch() {
    readSession(this)
  }
})
