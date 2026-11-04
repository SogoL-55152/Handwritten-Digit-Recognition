import { errorMessage } from '../api/workspaces.js'

export function validateRecognition(data, requestId) {
  return data && data.requestId === requestId && typeof data.recognitionId === 'string' && data.recognitionId &&
    Number.isInteger(data.digit) && data.digit >= 0 && data.digit <= 9 &&
    Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 1 &&
    typeof data.modelId === 'string' && data.modelId && typeof data.modelVersion === 'string' && data.modelVersion &&
    typeof data.preprocessVersion === 'string' && data.preprocessVersion && data.source === 'WEB' &&
    Number.isFinite(data.processingMs) && data.processingMs >= 0 && typeof data.createdAt === 'string'
}

export function createRecognitionController({ session, workspace, exportPng, send, randomUUID = () => crypto.randomUUID(), reactive = (value) => value }) {
  const state = reactive({ hasInk: false, drawing: false, revision: 0, loading: false, result: null, error: '', requestId: null })
  let operation = 0
  let disposed = false
  function reset() {
    operation += 1
    Object.assign(state, { loading: false, result: null, error: '', requestId: null })
  }
  const offSession = session.subscribe(reset)
  const offWorkspace = workspace.subscribe(reset)
  function drawingChanged({ hasInk, drawing = false }) {
    state.revision += 1
    state.hasInk = hasInk
    state.drawing = drawing
    reset()
  }
  const canSubmit = () => !disposed && session.isAuthenticated && workspace.isCurrent(workspace.getSnapshot()) && state.hasInk && !state.drawing && !state.loading
  async function submit() {
    if (!canSubmit()) return
    const snapshot = workspace.getSnapshot()
    const auth = session.getSnapshot()
    const revision = state.revision
    const sequence = ++operation
    const current = () => !disposed && operation === sequence && state.revision === revision &&
      session.isCurrent(auth) && workspace.isCurrent(snapshot)
    state.result = null
    state.error = ''
    state.loading = true
    try {
      const requestId = randomUUID()
      state.requestId = requestId
      const image = await exportPng()
      if (!current()) return
      const result = await send(snapshot, image, requestId)
      if (!current()) return
      if (!validateRecognition(result, requestId)) throw new Error('识别接口返回了无效结果；未展示未经验证的预测')
      state.result = result
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.loading = false
    }
  }
  return { state, drawingChanged, submit, canSubmit, reset,
    dispose() { disposed = true; offSession(); offWorkspace(); reset() }
  }
}
