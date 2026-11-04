import { errorMessage } from '../api/workspaces.js'

// scope is either a workspace context or a verified platform session.
export function createScopedResource({ scope, fetch, reactive = (value) => value }) {
  const state = reactive({ data: null, loading: false, error: '' })
  let sequence = 0
  let disposed = false
  function reset() {
    sequence += 1
    Object.assign(state, { data: null, loading: false, error: '' })
  }
  const unsubscribe = scope.subscribe(reset)
  async function load() {
    reset()
    const snapshot = scope.getSnapshot()
    if (disposed || !scope.isCurrent(snapshot)) return
    const operation = sequence
    const current = () => !disposed && operation === sequence && scope.isCurrent(snapshot)
    state.loading = true
    try {
      const data = await fetch(snapshot)
      if (current()) state.data = data
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.loading = false
    }
  }
  return { state, load, reset, dispose() { disposed = true; unsubscribe(); reset() } }
}
