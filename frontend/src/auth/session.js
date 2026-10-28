export const SESSION_MESSAGES = {
  expired: '登录已失效，请重新登录。',
  forbidden: '该账号不是管理员，已清理管理端会话。请使用管理员账号登录。',
  unavailable: '暂时无法校验会话，未进入管理端。凭证已保留，请检查网络后重试。',
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

// No Vue/router/HTTP imports: production and tests use the same session state machine.
export function createSession({ storage, login: loginApi, getMe, reactive = (state) => state }) {
  const cachedToken = storage.getItem('hdr_token')
  // A cached profile (including damaged JSON) is never an authorization source.
  storage.removeItem('hdr_user')
  if (!validToken(cachedToken)) storage.removeItem('hdr_token')
  const state = reactive({
    token: validToken(cachedToken) ? cachedToken : '',
    user: null,
    status: 'anonymous',
    reason: ''
  })
  let generation = 0
  let pending = null

  function getSnapshot() {
    return { token: state.token, generation }
  }

  function isCurrent(snapshot) {
    return snapshot?.generation === generation && snapshot?.token === state.token
  }

  function result() {
    return { status: state.status, reason: state.reason }
  }

  function logout(reason = '') {
    generation += 1
    pending = null
    state.token = ''
    state.user = null
    state.status = 'anonymous'
    state.reason = reason
    storage.removeItem('hdr_token')
    storage.removeItem('hdr_user')
  }

  function invalidate(snapshot) {
    if (!snapshot?.token || !isCurrent(snapshot)) return false
    logout('expired')
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
        const user = await getMe(snapshot)
        if (!isCurrent(snapshot)) return { status: 'stale' }
        if (!user || typeof user.role !== 'string' || !user.role) {
          throw new Error('会话接口返回了无效的用户信息')
        }
        if (user.role !== 'ADMIN') {
          logout('forbidden')
          return result()
        }
        state.user = user
        state.status = 'authenticated'
        return result()
      } catch (error) {
        if (!isCurrent(snapshot)) return { status: 'stale' }
        if (isUnauthorized(error)) {
          logout('expired')
        } else {
          // An outage does not prove that the token is invalid, but must fail closed.
          state.user = null
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

  async function login(form) {
    // Invalidate earlier logins and validations even when the server reuses a token.
    logout()
    const snapshot = getSnapshot()
    try {
      const data = await loginApi(form)
      if (!isCurrent(snapshot)) return { status: 'stale' }
      if (!validToken(data?.token)) throw new Error('登录接口返回了无效的凭证')
      state.token = data.token
      storage.setItem('hdr_token', data.token)
      // Ignore login/cached role claims: /auth/me is the authority for this session.
      return await refresh()
    } catch (error) {
      if (snapshot.generation !== generation) return { status: 'stale' }
      state.reason = isUnauthorized(error) ? 'credentials' : 'login-failed'
      throw error
    }
  }

  return {
    state,
    get isAdmin() { return state.status === 'authenticated' && state.user?.role === 'ADMIN' },
    getSnapshot,
    refresh,
    login,
    logout,
    invalidate
  }
}
