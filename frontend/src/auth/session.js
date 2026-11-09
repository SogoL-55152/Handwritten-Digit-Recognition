export const TOKEN_KEY = 'hdr_v2_token'
export const SESSION_MESSAGES = {
  expired: '登录已失效，请重新登录。',
  'password-changed': '密码已修改，所有设备会话已撤销，请使用新密码重新登录。',
  forbidden: '当前账号没有此操作权限，会话仍然有效。',
  unavailable: '暂时无法校验会话。凭证已保留，请检查网络后重试。',
  credentials: '用户名或密码错误，请重试。',
  'login-failed': '登录失败，请检查网络或服务状态后重试。'
}

export function isUnauthorized(error) {
  return error?.status === 401 || error?.code === 401 || error?.response?.status === 401
}

function validToken(token) {
  return typeof token === 'string' && token.length > 0 &&
    !/\s/.test(token) && !['undefined', 'null', '[object Object]'].includes(token)
}

// Injected state machine: cached/login profiles never authorize the application.
export function createSession({ storage, login: loginApi, register: registerApi, changePassword: passwordApi, logout: logoutApi = async () => {}, getMe, reactive = (state) => state }) {
  for (const key of ['hdr_token', 'hdr_user', 'hdr_v2_user']) storage.removeItem(key)
  const cachedToken = storage.getItem(TOKEN_KEY)
  if (!validToken(cachedToken)) storage.removeItem(TOKEN_KEY)
  const state = reactive({ token: validToken(cachedToken) ? cachedToken : '', user: null,
    defaultWorkspaceId: null, status: 'anonymous', reason: '', logoutWarning: '' })
  let generation = 0
  let pending = null
  const listeners = new Set()
  const notify = () => listeners.forEach((listener) => listener())
  const getSnapshot = () => ({ token: state.token, generation })
  const isCurrent = (snapshot) => snapshot?.generation === generation && snapshot?.token === state.token
  const result = () => ({ status: state.status, reason: state.reason })

  function clear(reason = '') {
    generation += 1
    pending = null
    Object.assign(state, { token: '', user: null, defaultWorkspaceId: null, status: 'anonymous', reason, logoutWarning: '' })
    storage.removeItem(TOKEN_KEY)
    notify()
  }

  function logout() {
    const previous = getSnapshot()
    clear() // Revoke client authority before waiting for the server (or even dispatching).
    const cleared = getSnapshot()
    if (!previous.token) return Promise.resolve({ revoked: true })
    return Promise.resolve().then(() => logoutApi(previous)).then(() => ({ revoked: true }), () => {
      if (isCurrent(cleared)) state.logoutWarning = '本地已退出，但服务器撤销未确认。请勿继续使用旧凭证。'
      return { revoked: false }
    })
  }

  function invalidate(snapshot) {
    if (!snapshot?.token || !isCurrent(snapshot)) return false
    clear('expired')
    return true
  }

  function refresh() {
    if (!state.token || state.status === 'authenticated') return Promise.resolve(result())
    if (pending) return pending.promise
    const snapshot = getSnapshot()
    state.status = 'checking'
    state.reason = ''
    const operation = { snapshot }
    pending = operation
    operation.promise = Promise.resolve().then(async () => {
      try {
        const data = await getMe(snapshot)
        if (!isCurrent(snapshot)) return { status: 'stale' }
        const user = data?.user
        if (!user || typeof user.id !== 'string' || !user.id || typeof user.username !== 'string' ||
          !['USER', 'SUPER_ADMIN'].includes(user.platformRole) || typeof data.defaultWorkspaceId !== 'string' || !data.defaultWorkspaceId) {
          throw new Error('会话接口返回了无效的用户信息')
        }
        state.user = user
        state.defaultWorkspaceId = data.defaultWorkspaceId
        state.status = 'authenticated'
        notify()
        return result()
      } catch (error) {
        if (!isCurrent(snapshot)) return { status: 'stale' }
        if (isUnauthorized(error)) clear('expired')
        else {
          state.user = null
          state.defaultWorkspaceId = null
          state.status = 'unavailable'
          state.reason = 'unavailable'
        }
        return result()
      } finally {
        if (pending === operation) pending = null
      }
    })
    return operation.promise
  }

  async function authenticate(api, form) {
    clear()
    const snapshot = getSnapshot()
    try {
      const data = await api(form)
      if (!isCurrent(snapshot)) return { status: 'stale' }
      if (!validToken(data?.token)) throw new Error('身份接口返回了无效的凭证')
      state.token = data.token
      storage.setItem(TOKEN_KEY, data.token)
      return await refresh()
    } catch (error) {
      if (snapshot.generation !== generation) return { status: 'stale' }
      state.reason = isUnauthorized(error) ? 'credentials' : 'login-failed'
      throw error
    }
  }

  async function changePassword(form) {
    if (state.status !== 'authenticated') return { status: 'stale' }
    const snapshot = getSnapshot()
    try {
      const data = await passwordApi(form, snapshot) // One POST; no automatic retry or extra logout.
      if (!isCurrent(snapshot)) return { status: 'stale' }
      if (data !== null) throw new Error('修改密码响应无效，结果未确认。请勿自动重试。')
      // The server has already changed the password and revoked ALL sessions.
      clear('password-changed')
    } catch (error) {
      if (!isCurrent(snapshot)) return { status: 'stale' }
      if (!isUnauthorized(error)) throw error
      clear('expired')
    }
    return { status: 'reauthenticate', reason: state.reason, snapshot: getSnapshot() }
  }

  return {
    state,
    get isAuthenticated() { return state.status === 'authenticated' },
    get isSuperAdmin() { return state.status === 'authenticated' && state.user?.platformRole === 'SUPER_ADMIN' },
    getSnapshot, isCurrent, refresh,
    login: (form) => authenticate(loginApi, form),
    register: (form) => authenticate(registerApi, form),
    logout, invalidate, changePassword,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  }
}
