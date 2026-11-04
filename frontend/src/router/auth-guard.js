// Only registered, protected, same-site routes are valid post-login destinations.
export function safeRedirect(value, resolve, { pilot = false } = {}) {
  if (pilot) return '/recognize'
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

export function loginLocation(redirect, reason, resolve, options) {
  return {
    path: '/login',
    query: {
      redirect: safeRedirect(redirect, resolve, options),
      ...(reason ? { reason } : {})
    },
    replace: true
  }
}

const pilotPaths = new Set(['/', '/login', '/register', '/recognize', '/account', '/help', '/privacy'])

export function createAuthGuard({ session, resolve, pilot = false }) {
  return async (to) => {
    // This allowlist is presentation-only; APIs must still enforce server permissions.
    if (pilot && !pilotPaths.has(to.path)) return { path: '/recognize', replace: true }
    // Public portal/auth pages never bounce based on cached credentials.
    const protectedRoute = to.meta?.requiresAuth || to.matched?.some((record) => record.meta?.requiresAuth)
    if (!protectedRoute) return true
    const snapshot = session.getSnapshot()
    const result = await session.refresh()
    if (result.status === 'stale' || (result.status === 'authenticated' && !session.isCurrent(snapshot))) return false
    if (result.status !== 'authenticated' || !session.isAuthenticated) return loginLocation(to.fullPath, result.reason, resolve, { pilot })
    if ((to.meta?.superAdmin || to.matched?.some((record) => record.meta?.superAdmin)) && !session.isSuperAdmin) {
      return { path: '/home', query: { denied: 'platform' }, replace: true }
    }
    return true
  }
}
