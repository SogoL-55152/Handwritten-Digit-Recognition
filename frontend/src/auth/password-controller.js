import { passwordPayload } from './validation.js'
import { errorMessage } from '../api/workspaces.js'

export function createPasswordController({ session, onReauthenticate, reactive = (value) => value }) {
  const state = reactive({ form: { currentPassword: '', newPassword: '' }, loading: false, error: '' })
  let generation = 0
  let disposed = false
  function clearSensitive() { state.form.currentPassword = ''; state.form.newPassword = '' }
  function reset() { generation += 1; clearSensitive(); state.loading = false; state.error = '' }
  const unsubscribe = session.subscribe(reset)
  async function submit() {
    if (disposed || state.loading || !session.isAuthenticated) return
    const operation = ++generation
    const snapshot = session.getSnapshot()
    let dispatched = false
    state.loading = true
    state.error = ''
    try {
      const payload = passwordPayload(state.form)
      clearSensitive()
      dispatched = true
      const result = await session.changePassword(payload)
      // A confirmed revocation still clears/reauthenticates if the account view was left.
      // But an old operation must never redirect or clear a newer login.
      if (result.status === 'reauthenticate' && session.isCurrent(result.snapshot)) await onReauthenticate(result.reason)
    } catch (error) {
      if (operation === generation && session.isCurrent(snapshot)) {
        state.error = errorMessage(error)
        if (dispatched && !error?.status && !error?.response?.status) state.error += ' 修改结果可能未确认；不会自动重试，请联系维护者或尝试重新登录。'
      }
    } finally {
      if (operation === generation) { state.loading = false; clearSensitive() }
    }
  }
  return { state, submit, clearSensitive,
    dispose() { disposed = true; unsubscribe(); reset() }
  }
}
