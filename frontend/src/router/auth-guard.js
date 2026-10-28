// Only registered, protected, same-site routes are valid post-login destinations.
export function safeRedirect(value, resolve) {
  const fallback = '/home'
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback
  let decoded = value
  try {
    for (let i = 0; i < 4; i += 1) {
      if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000- \u007f]/.test(decoded)) {
        return fallback
      }
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      if (i === 3) return fallback
    }
    const target = resolve(value)
    if (target.path === '/login' || !target.matched.some((record) => record.meta?.requiresAuth)) {
      return fallback
    }
    return target.fullPath
  } catch {
    return fallback
  }
}

export function loginLocation(redirect, reason, resolve) {
  return {
    path: '/login',
    query: {
      redirect: safeRedirect(redirect, resolve),
      ...(reason ? { reason } : {})
    },
    replace: true
  }
}

export function createAuthGuard({ session, resolve }) {
  return async (to) => {
    // Login remains reachable for errors, retry and account switching; no token-only bounce.
    if (to.path === '/login') return true
    const result = await session.refresh()
    if (result.status === 'stale') return false
    if (result.status === 'authenticated' && session.isAdmin) return true
    return loginLocation(to.fullPath, result.reason, resolve)
  }
}
