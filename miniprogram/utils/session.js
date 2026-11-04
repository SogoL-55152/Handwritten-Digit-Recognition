const STORAGE_KEY = 'hdr_v2_session'
const { getRuntime } = require('../config/runtime')

function validIdentity(data) {
  const user = data && data.user
  return !!(user && typeof user.id === 'string' && user.id &&
    typeof user.username === 'string' && user.username &&
    ['USER', 'SUPER_ADMIN'].includes(user.platformRole) &&
    typeof data.defaultWorkspaceId === 'string' && data.defaultWorkspaceId)
}

function state(app = getApp()) {
  readSession(app)
  return app.globalData
}

function notify(app) {
  if (app._sessionListeners) app._sessionListeners.forEach((listener) => listener())
}

// Storage is only a token candidate. Neither cached identity nor roles authorize a page.
function readSession(app = getApp()) {
  const runtime = getRuntime(app)
  const origin = runtime.networkAllowed ? runtime.apiBaseUrl : ''
  if (!app._sessionLoaded) {
    app._sessionLoaded = true
    wx.removeStorageSync('hdr_token')
    wx.removeStorageSync('hdr_user')
    const cached = wx.getStorageSync(STORAGE_KEY)
    const token = origin && cached && cached.origin === origin && typeof cached.token === 'string' ? cached.token.trim() : ''
    Object.assign(app.globalData, {
      origin, token, user: null, verified: false, defaultWorkspaceId: '', workspaceId: '',
      sessionGeneration: 0, workspaceGeneration: 0
    })
    if (!token) wx.removeStorageSync(STORAGE_KEY)
  } else if (app.globalData.origin !== origin) {
    // Invalidate before any request can build an Authorization header for a changed service.
    Object.assign(app.globalData, {
      origin, token: '', user: null, verified: false, defaultWorkspaceId: '', workspaceId: '',
      sessionGeneration: app.globalData.sessionGeneration + 1,
      workspaceGeneration: app.globalData.workspaceGeneration + 1
    })
    app._verification = null
    wx.removeStorageSync(STORAGE_KEY)
    notify(app)
  }
  return app.globalData.token ? { token: app.globalData.token } : null
}

function snapshot(app = getApp()) {
  const data = state(app)
  return {
    origin: data.origin, token: data.token, generation: data.sessionGeneration,
    workspaceId: data.workspaceId, workspaceGeneration: data.workspaceGeneration
  }
}

function isSessionCurrent(saved, app = getApp()) {
  const data = state(app)
  return !!saved && saved.origin === data.origin && saved.token === data.token && saved.generation === data.sessionGeneration
}

function isWorkspaceCurrent(saved, app = getApp()) {
  const data = state(app)
  return isSessionCurrent(saved, app) && saved.workspaceId === data.workspaceId &&
    saved.workspaceGeneration === data.workspaceGeneration
}

function clearSession(app = getApp(), expected) {
  if (expected && !isSessionCurrent(expected, app)) return false
  const data = state(app)
  Object.assign(data, {
    token: '', user: null, verified: false, defaultWorkspaceId: '', workspaceId: '',
    sessionGeneration: data.sessionGeneration + 1,
    workspaceGeneration: data.workspaceGeneration + 1
  })
  app._verification = null
  wx.removeStorageSync(STORAGE_KEY)
  wx.removeStorageSync('hdr_token')
  wx.removeStorageSync('hdr_user')
  notify(app)
  return true
}

function saveSession(session, app = getApp(), expected) {
  if (expected && !isSessionCurrent(expected, app)) return false
  if (!state(app).origin || !validIdentity(session) || typeof session.token !== 'string' || !session.token.trim()) {
    clearSession(app)
    return false
  }
  clearSession(app)
  // Login itself does not unlock business UI; /me must verify this token first.
  app.globalData.token = session.token
  wx.setStorageSync(STORAGE_KEY, { token: session.token, origin: app.globalData.origin })
  return true
}

function verifySession(app = getApp()) {
  const saved = snapshot(app)
  if (!saved.token) return Promise.reject(new Error('请先登录'))
  if (app._verification && isSessionCurrent(app._verification.snapshot, app)) {
    return app._verification.promise
  }
  app.globalData.verified = false
  const { request } = require('./request')
  let cancelled = false
  const verificationRequest = request({ url: '/api/v2/auth/me', snapshot: saved })
  const promise = verificationRequest
    .then((identity) => {
      if (cancelled) throw Object.assign(new Error('核验已取消'), { aborted: true })
      if (!isSessionCurrent(saved, app)) throw Object.assign(new Error('会话已变化'), { stale: true })
      if (!validIdentity(identity)) throw new Error('身份响应格式错误，请重新登录')
      Object.assign(app.globalData, {
        user: identity.user, defaultWorkspaceId: identity.defaultWorkspaceId, verified: true
      })
      return identity
    })
    .finally(() => {
      if (app._verification && app._verification.promise === promise) app._verification = null
    })
  promise.abort = () => {
    cancelled = true
    if (app._verification && app._verification.promise === promise) app._verification = null
    verificationRequest.abort()
  }
  app._verification = { snapshot: saved, promise }
  return promise
}

// Select only a server-listed workspace, then the page verifies GET /workspaces/{id}.
function selectWorkspace(id, app = getApp()) {
  const data = state(app)
  data.workspaceId = id
  data.workspaceGeneration += 1
  return snapshot(app)
}

function subscribe(listener, app = getApp()) {
  if (!app._sessionListeners) app._sessionListeners = new Set()
  app._sessionListeners.add(listener)
  return () => app._sessionListeners.delete(listener)
}

module.exports = {
  STORAGE_KEY, clearSession, readSession, saveSession, verifySession, validIdentity,
  snapshot, isSessionCurrent, isWorkspaceCurrent, selectWorkspace, subscribe
}
