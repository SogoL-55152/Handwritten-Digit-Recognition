import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createSession } from '../src/auth/session.js'
import { createAuthGuard, safeRedirect } from '../src/router/auth-guard.js'
import { createRequest } from '../src/api/request.js'

const admin = { id: 1, username: 'admin', role: 'ADMIN' }
const regular = { id: 2, username: 'user', role: 'USER' }
const home = { path: '/home', fullPath: '/home' }

function storageFor(values = {}) {
  const valuesMap = new Map(Object.entries(values))
  return {
    getItem: (key) => valuesMap.get(key) ?? null,
    setItem: (key, value) => valuesMap.set(key, String(value)),
    removeItem: (key) => valuesMap.delete(key)
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup({ cache = {}, getMe = async () => admin, login = async () => ({ token: 'new-token', user: admin }) } = {}) {
  const storage = storageFor(cache)
  const session = createSession({ storage, login, getMe })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: {} },
      { path: '/home', component: {}, meta: { requiresAuth: true, admin: true } },
      { path: '/:pathMatch(.*)*', redirect: '/home' }
    ]
  })
  const resolve = (value) => router.resolve(value)
  const guard = createAuthGuard({ session, resolve })
  router.beforeEach(guard)
  return { storage, session, router, resolve, guard }
}

function assertCleared(session, storage) {
  assert.equal(session.state.token, '')
  assert.equal(session.state.user, null)
  assert.equal(session.isAdmin, false)
  assert.equal(storage.getItem('hdr_token'), null)
  assert.equal(storage.getItem('hdr_user'), null)
}

test('unauthenticated navigation goes to login, preserving the local destination', async () => {
  let calls = 0
  const { router, guard } = setup({ getMe: async () => { calls += 1; return admin } })
  await router.push('/home?from=bookmark#intro')
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(router.currentRoute.value.query.redirect, '/home?from=bookmark#intro')
  assert.equal(await guard({ path: '/login' }), true)
  assert.equal(calls, 0)
})

test('first protected route validates the server role, not the cached role', async () => {
  let calls = 0
  const { session, storage, router } = setup({
    cache: { hdr_token: 'valid', hdr_user: JSON.stringify(regular) },
    getMe: async (snapshot) => {
      calls += 1
      assert.equal(snapshot.token, 'valid')
      return admin
    }
  })
  assert.equal(session.state.user, null)
  assert.equal(session.isAdmin, false)
  await router.push('/home')
  assert.equal(router.currentRoute.value.path, '/home')
  assert.equal(session.state.user, admin)
  assert.equal(session.isAdmin, true)
  await router.push('/home?second=1')
  assert.equal(calls, 1)
  // A page reload creates an unverified session and calls /me again.
  const reloaded = createSession({ storage, login: async () => ({}), getMe: async () => { calls += 1; return admin } })
  assert.equal(reloaded.isAdmin, false)
  await reloaded.refresh()
  assert.equal(calls, 2)
})

test('ordinary user with a forged ADMIN cache is cleared and stays at login without a loop', async () => {
  let calls = 0
  const { router, session, storage, guard } = setup({
    cache: { hdr_token: 'regular-token', hdr_user: JSON.stringify(admin) },
    getMe: async () => { calls += 1; return regular }
  })
  await router.push('/home')
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(router.currentRoute.value.query.reason, 'forbidden')
  assertCleared(session, storage)
  assert.equal(await guard({ path: '/login' }), true)
  await router.push('/home')
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(calls, 1)
})

test('login ignores the login response role and verifies /me before allowing entry', async () => {
  const { session, storage, guard } = setup({
    login: async () => ({ token: 'regular-token', user: admin }),
    getMe: async () => regular
  })
  const outcome = await session.login({ username: 'user', password: 'not-saved' })
  assert.equal(outcome.reason, 'forbidden')
  assertCleared(session, storage)
  assert.equal((await guard(home)).path, '/login')
  assert.equal(await guard({ path: '/login' }), true)
})

test('HTTP and business 401 validation errors clear token and in-memory user', async (t) => {
  for (const error of [{ response: { status: 401 } }, { code: 401 }]) {
    await t.test(JSON.stringify(error), async () => {
      const { session, storage, guard } = setup({
        cache: { hdr_token: 'expired', hdr_user: JSON.stringify(admin) },
        getMe: async () => { throw error }
      })
      const result = await guard(home)
      assert.equal(result.path, '/login')
      assert.equal(result.query.reason, 'expired')
      assertCleared(session, storage)
    })
  }
})

test('damaged/stale user caches never grant access or prevent server validation', async (t) => {
  for (const hdr_user of ['{broken', 'null', '42', '"ADMIN"', '{"role":"ADMIN"}']) {
    await t.test(hdr_user, async () => {
      const { guard, session, storage } = setup({ cache: { hdr_token: 'valid', hdr_user } })
      assert.equal(session.isAdmin, false)
      assert.equal(storage.getItem('hdr_user'), null)
      assert.equal(await guard(home), true)
    })
  }
})

test('missing and malformed token caches are removed without requesting /me', async (t) => {
  for (const token of [null, '', 'null', 'undefined', ' ', ' abc ', '[object Object]']) {
    await t.test(String(token), async () => {
      let calls = 0
      const { session, storage, guard } = setup({
        cache: { ...(token === null ? {} : { hdr_token: token }), hdr_user: JSON.stringify(admin) },
        getMe: async () => { calls += 1; return admin }
      })
      assert.equal((await guard(home)).path, '/login')
      assertCleared(session, storage)
      assert.equal(calls, 0)
    })
  }
})

test('network failure keeps the token, blocks navigation and supports retry', async () => {
  let online = false
  const { session, storage, router, guard } = setup({
    cache: { hdr_token: 'valid' },
    getMe: async () => {
      if (!online) throw new Error('Network Error')
      return admin
    }
  })
  await router.push('/home')
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(router.currentRoute.value.query.reason, 'unavailable')
  assert.equal(session.state.status, 'unavailable')
  assert.equal(session.isAdmin, false)
  assert.equal(session.state.user, null)
  assert.equal(storage.getItem('hdr_token'), 'valid')
  assert.equal(await guard({ path: '/login' }), true)
  online = true
  assert.equal((await session.refresh()).status, 'authenticated')
  await router.replace('/home')
  assert.equal(router.currentRoute.value.path, '/home')
})

test('a login followed by a /me outage retains its new token for retry', async () => {
  const { session, storage } = setup({ getMe: async () => { throw new Error('offline') } })
  assert.equal((await session.login({})).status, 'unavailable')
  assert.equal(storage.getItem('hdr_token'), 'new-token')
  assert.equal(session.isAdmin, false)
})

test('invalid /me response fails closed without destroying credentials', async () => {
  const { session, storage, guard } = setup({ cache: { hdr_token: 'valid' }, getMe: async () => ({}) })
  assert.equal((await guard(home)).query.reason, 'unavailable')
  assert.equal(storage.getItem('hdr_token'), 'valid')
  assert.equal(session.isAdmin, false)
})

test('concurrent validation and guards share one request and do not enter early', async () => {
  const request = deferred()
  let calls = 0
  const { session, guard } = setup({
    cache: { hdr_token: 'valid' },
    getMe: () => { calls += 1; return request.promise }
  })
  const first = session.refresh()
  assert.equal(first, session.refresh())
  const navigation = guard(home)
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(session.state.status, 'checking')
  assert.equal(session.isAdmin, false)
  request.resolve(admin)
  assert.equal((await first).status, 'authenticated')
  assert.equal(await navigation, true)
})

test('logout cancels pending validation; its late success cannot restore user/token', async () => {
  const request = deferred()
  const { session, storage, guard } = setup({ cache: { hdr_token: 'valid' }, getMe: () => request.promise })
  const navigation = guard(home)
  await Promise.resolve()
  session.logout()
  request.resolve(admin)
  assert.equal(await navigation, false)
  assertCleared(session, storage)
  assert.equal((await guard(home)).path, '/login')
})

test('logout removes an already verified session and blocks browser-back navigation', async () => {
  const { session, storage, router } = setup({ cache: { hdr_token: 'valid' } })
  await router.push('/home')
  assert.equal(session.isAdmin, true)
  session.logout()
  await router.replace('/login')
  await router.push('/home')
  assert.equal(router.currentRoute.value.path, '/login')
  assertCleared(session, storage)
})

test('old validation success/401 cannot replace or clear a new login, even with a reused token', async (t) => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'late 401' : 'late success', async () => {
      const old = deferred()
      let calls = 0
      const { session, storage } = setup({
        cache: { hdr_token: 'same-token' },
        login: async () => ({ token: 'same-token', user: regular }),
        getMe: () => ++calls === 1 ? old.promise : Promise.resolve(admin)
      })
      const previous = session.refresh()
      await Promise.resolve()
      assert.equal((await session.login({})).status, 'authenticated')
      if (fails) old.reject({ response: { status: 401 } })
      else old.resolve(regular)
      assert.equal((await previous).status, 'stale')
      assert.equal(session.state.user, admin)
      assert.equal(storage.getItem('hdr_token'), 'same-token')
    })
  }
})

test('a pending login cannot restore a logged-out session or overwrite a newer login', async (t) => {
  for (const newerLogin of [false, true]) {
    await t.test(newerLogin ? 'new login' : 'logout', async () => {
      const old = deferred()
      let calls = 0
      const { session, storage } = setup({
        login: () => ++calls === 1 ? old.promise : Promise.resolve({ token: 'newer' })
      })
      const previous = session.login({})
      if (newerLogin) await session.login({})
      else session.logout()
      old.resolve({ token: 'old', user: regular })
      assert.equal((await previous).status, 'stale')
      if (newerLogin) {
        assert.equal(session.state.token, 'newer')
        assert.equal(session.state.user, admin)
      } else assertCleared(session, storage)
    })
  }
})

test('failed and malformed login responses do not authenticate', async (t) => {
  for (const login of [async () => { throw { response: { status: 401 } } }, async () => ({ token: null })]) {
    await t.test('rejected login', async () => {
      const { session, storage } = setup({ login })
      await assert.rejects(session.login({}))
      assertCleared(session, storage)
    })
  }
})

test('redirect accepts registered local protected routes only', () => {
  const { resolve } = setup()
  assert.equal(safeRedirect('/home?tab=mine#section', resolve), '/home?tab=mine#section')
  for (const input of [
    undefined, ['/home'], 'https://evil.test', '//evil.test', '/\\evil.test',
    '/%2f%2fevil.test', '/%255cevil.test', '/%25252f%25252fevil.test',
    '/home\n', '/home%0a', '/home%250a', '/%', '/login', '/login?redirect=/home',
    '/%6cogin', '/unregistered', 'javascript:alert(1)'
  ]) assert.equal(safeRedirect(input, resolve), '/home', String(input))
})

function response(config, data, status = 200) {
  return { data, status, config, statusText: 'OK', headers: {} }
}

function http401(config) {
  const error = new Error('Request failed with status code 401')
  error.config = config
  error.response = response(config, { message: '登录失效' }, 401)
  return error
}

test('real response interceptors handle both 401 formats and clear only the requesting session', async (t) => {
  for (const http of [true, false]) {
    await t.test(http ? 'HTTP 401' : 'business 401', async () => {
      const { session, storage } = setup({ cache: { hdr_token: 'valid' } })
      await session.refresh()
      let invalidations = 0
      const client = createRequest({
        hooks: {
          getSession: session.getSnapshot,
          onUnauthorized: (snapshot) => { if (session.invalidate(snapshot)) invalidations += 1 }
        },
        adapter: async (config) => {
          assert.equal(config.headers.Authorization, 'Bearer valid')
          if (http) throw http401(config)
          return response(config, { code: 401, message: '登录失效' })
        }
      })
      await assert.rejects(client.get('/protected'))
      assert.equal(invalidations, 1)
      assertCleared(session, storage)
    })
  }
})

test('a late request 401 cannot invalidate a newer session with the same token', async () => {
  const old = deferred()
  const sent = deferred()
  const { session } = setup({
    cache: { hdr_token: 'same-token' },
    login: async () => ({ token: 'same-token' })
  })
  const client = createRequest({
    hooks: { getSession: session.getSnapshot, onUnauthorized: session.invalidate },
    adapter: async (config) => { sent.resolve(); await old.promise; throw http401(config) }
  })
  const request = client.get('/protected')
  const rejected = assert.rejects(request)
  await sent.promise
  await session.login({})
  old.resolve()
  await rejected
  assert.equal(session.isAdmin, true)
  assert.equal(session.state.token, 'same-token')
})

test('login and validation errors are silent and do not trigger global redirects', async () => {
  let notifications = 0
  let invalidations = 0
  const client = createRequest({
    hooks: {
      getSession: () => ({ token: 'old-token', generation: 0 }),
      onUnauthorized: () => { invalidations += 1 },
      onError: () => { notifications += 1 }
    },
    adapter: async (config) => {
      if (config.skipAuth) assert.equal(config.headers.Authorization, undefined)
      else assert.equal(config.headers.Authorization, 'Bearer validation-token')
      return response(config, { code: 401, message: '拒绝访问' })
    }
  })
  await assert.rejects(client.post('/auth/login', {}, { skipAuth: true, silent: true }))
  await assert.rejects(client.get('/auth/me', {
    authSession: { token: 'validation-token', generation: 1 }, sessionValidation: true, silent: true
  }))
  assert.equal(invalidations, 0)
  assert.equal(notifications, 0)
})

test('request failures preserve credentials unless they are unauthorized; success unwraps data', async () => {
  const { session, storage } = setup({ cache: { hdr_token: 'valid' } })
  let failures = 0
  const client = createRequest({
    hooks: { getSession: session.getSnapshot, onUnauthorized: session.invalidate, onError: () => { failures += 1 } },
    adapter: async (config) => {
      if (config.url === '/ok') return response(config, { code: 0, data: admin })
      const error = new Error('Network Error')
      error.config = config
      throw error
    }
  })
  await assert.rejects(client.get('/offline'), /Network Error/)
  assert.equal(failures, 1)
  assert.equal(storage.getItem('hdr_token'), 'valid')
  assert.deepEqual(await client.get('/ok'), admin)
})
