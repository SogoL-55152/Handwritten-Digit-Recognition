function isCompleteSession(token, user) {
  return typeof token === 'string' && token.trim().length > 0 &&
    user !== null && typeof user === 'object' && !Array.isArray(user)
}

function clearSession(app = getApp()) {
  app.globalData.token = ''
  app.globalData.user = null
  wx.removeStorageSync('hdr_token')
  wx.removeStorageSync('hdr_user')
}

// 登录页、业务页与启动过程共用同一判断，避免半份缓存造成相互跳转。
function readSession(app = getApp()) {
  const token = wx.getStorageSync('hdr_token')
  const user = wx.getStorageSync('hdr_user')
  if (!isCompleteSession(token, user)) {
    clearSession(app)
    return null
  }
  app.globalData.token = token
  app.globalData.user = user
  return { token, user }
}

function saveSession(session, app = getApp()) {
  if (!session || !isCompleteSession(session.token, session.user)) {
    clearSession(app)
    return false
  }
  wx.setStorageSync('hdr_token', session.token)
  wx.setStorageSync('hdr_user', session.user)
  app.globalData.token = session.token
  app.globalData.user = session.user
  return true
}

module.exports = { clearSession, readSession, saveSession }
