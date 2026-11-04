import { authPayload } from './validation.js'
import { errorMessage } from '../api/workspaces.js'

export function createAuthFormController({ session, registering, pilot = false, onAuthenticated, reactive = (value) => value }) {
  const state = reactive({ form: { username: '', password: '', nickname: '', confirmPassword: '', pilotCode: '' }, loading: false, error: '' })
  let generation = 0
  let disposed = false
  function clearSensitive() {
    state.form.password = ''
    state.form.confirmPassword = ''
    state.form.pilotCode = ''
  }
  function reset() {
    generation += 1
    state.loading = false
    state.error = ''
    clearSensitive()
  }
  async function run(retry = false) {
    if (disposed || state.loading) return
    const operation = ++generation
    let auth
    state.loading = true
    state.error = ''
    try {
      let pending
      if (retry) pending = session.refresh()
      else {
        const payload = authPayload(state.form, { registering: registering(), pilot })
        pending = registering() ? session.register(payload) : session.login(payload)
      }
      auth = session.getSnapshot()
      clearSensitive()
      const result = await pending
      if (operation !== generation || result.status === 'stale') return
      if (result.status === 'authenticated' && session.getSnapshot().generation === auth.generation && session.isAuthenticated) await onAuthenticated()
    } catch (cause) {
      if (operation === generation && (!auth || auth.generation === session.getSnapshot().generation)) state.error = errorMessage(cause)
    } finally {
      if (operation === generation) { state.loading = false; clearSensitive() }
    }
  }
  return { state, run, reset, clearSensitive,
    switchAccount() { reset(); void session.logout() },
    dispose() { disposed = true; reset() }
  }
}
