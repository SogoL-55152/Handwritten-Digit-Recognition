import { errorMessage } from '../api/workspaces.js'

function validWorkspace(value) {
  return value && typeof value.id === 'string' && value.id && typeof value.name === 'string' &&
    ['OWNER', 'ADMIN', 'MEMBER'].includes(value.role) && value.status === 'ACTIVE'
}

// A space is active only after its detail endpoint confirms current membership.
// No localStorage role/space claim and no platform-admin membership bypass.
export function createWorkspaceContext({ session, list, get, create, defaultOnly = false, reactive = (value) => value }) {
  const state = reactive({ items: [], active: null, generation: 0, loading: false, selecting: false, creating: false, error: '' })
  const listeners = new Set()
  let listSequence = 0
  let selectionSequence = 0
  const emit = () => listeners.forEach((listener) => listener())
  function clearActive() {
    state.generation += 1
    state.active = null
    selectionSequence += 1
    state.selecting = false
    emit()
  }
  function reset() {
    listSequence += 1
    clearActive()
    Object.assign(state, { items: [], loading: false, creating: false, error: '' })
  }
  const unsubscribe = session.subscribe(reset)
  const getSnapshot = () => ({ session: session.getSnapshot(), workspaceId: state.active?.id || null, generation: state.generation })
  const isCurrent = (snapshot) => session.isCurrent(snapshot?.session) && snapshot?.generation === state.generation &&
    !!snapshot.workspaceId && snapshot.workspaceId === state.active?.id && session.isAuthenticated

  const defaultId = () => session.defaultWorkspaceId || session.state?.defaultWorkspaceId
  async function select(id) {
    clearActive() // synchronous: previous content disappears before the new membership check.
    state.error = ''
    if (!id || !session.isAuthenticated) return
    if (defaultOnly && id !== defaultId()) { state.error = '体验版仅使用服务器确认的默认空间'; return }
    const auth = session.getSnapshot()
    const sequence = selectionSequence
    state.selecting = true
    const current = () => session.isCurrent(auth) && sequence === selectionSequence
    try {
      const workspace = await get(id, auth)
      if (!current()) return
      if (!validWorkspace(workspace) || workspace.id !== id) throw new Error('空间接口返回了无效信息')
      state.active = workspace
      emit()
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.selecting = false
    }
  }

  async function load(preferredId) {
    const preferred = defaultOnly ? defaultId() : preferredId || state.active?.id || defaultId()
    clearActive()
    state.items = []
    state.error = ''
    if (!session.isAuthenticated) return
    const auth = session.getSnapshot()
    const sequence = ++listSequence
    const current = () => session.isCurrent(auth) && sequence === listSequence
    state.loading = true
    try {
      const items = await list(auth)
      if (!current()) return
      if (!Array.isArray(items) || items.some((item) => !validWorkspace(item))) throw new Error('空间列表返回了无效信息')
      state.items = items
      const candidate = items.find((item) => item.id === preferred) || (!defaultOnly && items[0])
      if (defaultOnly && !candidate) throw new Error('默认空间暂不可用，请联系维护者核验；不会改用其他空间。')
      if (candidate) await select(candidate.id)
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.loading = false
    }
  }

  async function createSpace(name) {
    if (defaultOnly) { state.error = '体验版不开放创建空间'; return }
    if (state.creating || state.loading || state.selecting || !session.isAuthenticated) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 64) { state.error = '空间名称需为 1–64 个字符'; return }
    const auth = session.getSnapshot()
    const sequence = listSequence
    const generation = state.generation
    const current = () => session.isCurrent(auth) && sequence === listSequence
    state.creating = true
    state.error = ''
    try {
      const created = await create(trimmed, auth)
      if (!current()) return
      if (!validWorkspace(created)) throw new Error('创建空间返回了无效信息')
      state.items = [...state.items.filter((item) => item.id !== created.id), created]
      if (generation === state.generation) await select(created.id)
      return created
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.creating = false
    }
  }
  return { state, getSnapshot, isCurrent, load, select, createSpace, reset,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { unsubscribe(); reset(); listeners.clear() }
  }
}
