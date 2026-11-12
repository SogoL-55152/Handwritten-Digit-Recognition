import { errorMessage } from '../api/workspaces.js'

export function validateRecognition(data, requestId) {
  return data && data.requestId === requestId && typeof data.recognitionId === 'string' && data.recognitionId &&
    Number.isInteger(data.digit) && data.digit >= 0 && data.digit <= 9 &&
    Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 1 &&
    typeof data.modelId === 'string' && data.modelId && typeof data.modelVersion === 'string' && data.modelVersion &&
    typeof data.preprocessVersion === 'string' && data.preprocessVersion && data.source === 'WEB' &&
    Number.isFinite(data.processingMs) && data.processingMs >= 0 && typeof data.createdAt === 'string'
}

export function createRecognitionController({ session, workspace, exportPng, prepareImage, send, randomUUID = () => crypto.randomUUID(), reactive = (value) => value }) {
  const state = reactive({ inputKind: 'drawing', image: null, validating: false,
    hasInk: false, drawing: false, revision: 0, loading: false, result: null, error: '', requestId: null,
    submitted: null })
  let operation = 0
  let disposed = false
  let selectedImage = null
  let validation = null
  function invalidate() {
    operation += 1
    state.revision += 1
    Object.assign(state, { loading: false, result: null, error: '', requestId: null, submitted: null })
  }
  function reset() {
    invalidate()
    validation?.abort()
    validation = null
    selectedImage?.dispose()
    selectedImage = null
    state.image = null
    state.validating = false
  }
  const offSession = session.subscribe(reset)
  const offWorkspace = workspace.subscribe(reset)
  function drawingChanged({ hasInk, drawing = false }) {
    state.hasInk = hasInk
    state.drawing = drawing
    // A background canvas resize is not a change to the selected image.
    if (state.inputKind === 'drawing') invalidate()
  }
  function setInputKind(kind) {
    if (disposed || !['drawing', 'image'].includes(kind) || state.inputKind === kind) return
    reset()
    state.inputKind = kind
  }
  const authorized = () => !disposed && session.isAuthenticated && workspace.isCurrent(workspace.getSnapshot())
  function captureCurrent() {
    const snapshot = workspace.getSnapshot()
    const auth = session.getSnapshot()
    const revision = state.revision
    const sequence = operation
    const kind = state.inputKind
    return { snapshot, current: () => !disposed && operation === sequence && state.revision === revision && state.inputKind === kind &&
      session.isCurrent(auth) && workspace.isCurrent(snapshot) }
  }
  async function selectImage(file) {
    // Native picker cancellation leaves the current input intact, with no UUID or POST.
    if (!file || state.inputKind !== 'image' || !authorized()) return
    reset()
    const { current } = captureCurrent()
    const pending = new AbortController()
    validation = pending
    state.validating = true
    try {
      const prepared = await prepareImage(file, { signal: pending.signal })
      if (!current()) { prepared.dispose(); return }
      selectedImage = prepared
      const { previewUrl, mime, width, height, size } = prepared
      state.image = { previewUrl, mime, width, height, size }
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) { state.validating = false; validation = null }
    }
  }
  const canSubmit = () => authorized() && !state.loading && !state.validating &&
    (state.inputKind === 'image' ? !!state.image && !!selectedImage : state.hasInk && !state.drawing)
  async function submit() {
    if (!canSubmit()) return
    operation += 1
    const { snapshot, current } = captureCurrent()
    const imageInput = selectedImage
    const kind = state.inputKind
    state.result = null
    state.error = ''
    state.loading = true
    try {
      const requestId = randomUUID()
      state.requestId = requestId
      const image = kind === 'image' ? imageInput.file : await exportPng()
      if (!current()) return
      state.submitted = { image, kind, requestId }
      const result = await send(snapshot, image, requestId, { inputCurrent: current, inputKind: kind })
      if (!current()) return
      if (!validateRecognition(result, requestId)) throw new Error('识别接口返回了无效结果；未展示未经验证的预测')
      state.result = result
    } catch (error) {
      if (current()) state.error = errorMessage(error)
    } finally {
      if (current()) state.loading = false
    }
  }
  return { state, drawingChanged, setInputKind, selectImage, removeImage: reset, submit, canSubmit, reset,
    dispose() { disposed = true; offSession(); offWorkspace(); reset() }
  }
}
