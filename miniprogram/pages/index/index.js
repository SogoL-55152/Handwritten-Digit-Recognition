const { getRuntime } = require('../../config/runtime')
const { request, upload } = require('../../utils/request')
const {
  readSession, clearSession, verifySession, snapshot, isSessionCurrent,
  isWorkspaceCurrent, selectWorkspace, subscribe
} = require('../../utils/session')
const { createRequestId, validWorkspace, validateResult, multiQuery, validateMultiResult } = require('../../utils/recognition')
const { chooseAlbumImage, validateImage } = require('../../utils/image-import')

Page({
  data: {
    user: null, authorized: false, loading: false, error: '',
    pilot: false, configurationError: '',
    workspaces: [], workspaceIndex: -1, workspace: null, workspaceReady: false, spaceLoading: false,
    hasInk: false, recognizing: false, recognitionError: '', result: null,
    inputKind: 'drawing', imagePath: '', imageInfo: null, imageBusy: false, imageError: '',
    multiEnabled: false, multiDigits: 3, multiBusy: false, multiResult: null, multiError: ''
  },

  async onShow() {
    if (this._disposed) return
    this._active = true
    const life = this._life = (this._life || 0) + 1
    this._cancelRecognition()
    this._cancelLoads()
    if (!this._intentCurrent(this._pickerIntent)) this._invalidateImage()
    else this._pickerIntent.verifiedLife = null
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = subscribe(() => {
      this._life += 1
      this._cancelRecognition()
      this._cancelLoads()
      this._invalidateImage()
      this._clearBoard()
      if (this._active) this.setData({
        authorized: false, user: null, loading: false, workspaces: [],
        workspace: null, workspaceReady: false, spaceLoading: false, hasInk: false
      })
    })
    const runtime = getRuntime()
    this.setData({ authorized: false, user: null, workspaces: [], workspace: null, workspaceReady: false, error: '', loading: true,
      pilot: runtime.mode === 'pilot', configurationError: runtime.error })
    const candidate = readSession()
    if (!runtime.networkAllowed) { this.setData({ loading: false }); return }
    if (!candidate) {
      this.setData({ loading: false })
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const saved = snapshot()
    const current = () => this._active && life === this._life && isSessionCurrent(saved)
    try {
      this._verification = verifySession()
      const identity = await this._verification
      if (!current()) return
      this._loadRequest = request({ url: '/api/v2/workspaces', snapshot: saved, isCurrent: current })
      const workspaces = await this._loadRequest
      if (!current()) return
      if (!Array.isArray(workspaces) || workspaces.some((space) => !validWorkspace(space))) {
        throw new Error('空间列表响应格式错误')
      }
      this.setData({ user: identity.user, authorized: true, workspaces })
      if (this._pickerIntent && this._pickerIntent.userId !== identity.user.id) this._invalidateImage()
      if (!workspaces.length) {
        selectWorkspace('')
        this.setData({ error: runtime.mode === 'pilot' ? '暂无可用个人空间，请联系维护者核验账号。' : '暂无可用空间，请在 PC 端检查账号空间。' })
        return
      }
      const defaultWorkspace = workspaces.find((space) => space.id === identity.defaultWorkspaceId)
      const preferred = runtime.mode === 'pilot' ? defaultWorkspace :
        workspaces.find((space) => space.id === saved.workspaceId) || defaultWorkspace || workspaces[0]
      if (!preferred) {
        selectWorkspace('')
        this.setData({ error: '默认个人空间不可访问，请联系维护者；不会自动切换到其他空间。' })
        return
      }
      const intent = this._pickerIntent
      await this._chooseWorkspace(preferred.id, intent)
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (current()) {
        this._loadRequest = null
        if (!this.data.workspaceReady) this._invalidateImage()
        this.setData({ loading: false })
      }
    }
  },

  onHide() {
    const intent = this._pickerIntent
    // A picker may cause one hide/show round-trip. No recognition/auth exemption.
    const preserve = this._intentCurrent(intent) && !intent.hideSeen
    if (preserve) { intent.hideSeen = true; intent.verifiedLife = null }
    this._stop(preserve)
  },
  onUnload() { this._stop(); this._disposed = true },
  _cancelLoads() {
    if (this._verification) this._verification.abort()
    if (this._loadRequest) this._loadRequest.abort()
    if (this._workspaceRequest) this._workspaceRequest.abort()
    this._verification = this._loadRequest = this._workspaceRequest = null
  },
  _stop(preservePicker = false) {
    this._cancelRecognition()
    if (!preservePicker) this._invalidateImage()
    else {
      this._image = null
      if (this._active) this.setData({ imagePath: '', imageInfo: null })
    }
    this._clearBoard()
    this._active = false
    this._life = (this._life || 0) + 1
    this._cancelLoads()
    // Keep observing session revocation while an album candidate is in flight.
    if (!preservePicker && this._unsubscribe) this._unsubscribe()
    if (!preservePicker) this._unsubscribe = null
  },

  async _chooseWorkspace(id, pickerIntent) {
    if (!this._active || !this.data.authorized || !this.data.workspaces.some((space) => space.id === id)) return
    const runtime = getRuntime()
    if (!runtime.networkAllowed || (runtime.mode === 'pilot' && id !== getApp().globalData.defaultWorkspaceId)) return
    const preserve = this._intentCurrent(pickerIntent) && pickerIntent.scope.workspaceId === id &&
      pickerIntent.userId === this.data.user.id
    this._cancelRecognition()
    if (!preserve) this._invalidateImage()
    this._clearBoard()
    if (this._workspaceRequest) this._workspaceRequest.abort()
    const saved = selectWorkspace(id)
    if (preserve) { pickerIntent.scope = saved; pickerIntent.verifiedLife = null }
    const life = this._life
    const current = () => this._active && life === this._life && isWorkspaceCurrent(saved)
    this.setData({
      workspaceIndex: this.data.workspaces.findIndex((space) => space.id === id),
      workspaceReady: false, workspace: null, hasInk: false, spaceLoading: true, error: ''
    })
    try {
      this._workspaceRequest = request({
        url: `/api/v2/workspaces/${encodeURIComponent(id)}`, snapshot: saved, isCurrent: current
      })
      const workspace = await this._workspaceRequest
      if (!current()) return
      if (!validWorkspace(workspace) || workspace.id !== id) throw new Error('空间核验响应格式错误')
      this.setData({ workspace, workspaceReady: true })
      if (preserve && this._intentCurrent(pickerIntent)) {
        pickerIntent.verifiedLife = life
        this._promoteImage(pickerIntent)
      }
    } catch (error) {
      // 403/404 are scoped failures, not a reason to log out an ordinary member.
      if (current() && !error.stale && !error.aborted) {
        this._invalidateImage()
        this.setData({ error: error.message })
      }
    } finally {
      if (current()) { this._workspaceRequest = null; this.setData({ spaceLoading: false }) }
    }
  },

  onWorkspaceChange(event) {
    if (getRuntime().mode === 'pilot') return
    const space = this.data.workspaces[Number(event.detail.value)]
    if (space) return this._chooseWorkspace(space.id)
  },

  onDrawingChange(event) {
    if (!this._active || this.data.inputKind !== 'drawing') return
    this._cancelRecognition()
    this.setData({ hasInk: !!event.detail.hasInk })
  },

  onInputKindChange(event) {
    const kind = event.currentTarget.dataset.kind
    if (!this._active || !['drawing', 'image'].includes(kind) || kind === this.data.inputKind) return
    this._cancelRecognition()
    this._invalidateImage()
    const board = this.selectComponent('#business-board')
    const life = this._life
    this.setData({ inputKind: kind, hasInk: !!(board && board.getSnapshot().hasInk) }, () => {
      // A board mounted while the album panel was visible may have measured zero size.
      if (!this._active || life !== this._life || this.data.inputKind !== 'drawing') return
      const visibleBoard = this.selectComponent('#business-board')
      if (visibleBoard && !visibleBoard.getSnapshot().ready) visibleBoard.initCanvas()
    })
  },

  _invalidateImage() {
    this._imageGeneration = (this._imageGeneration || 0) + 1
    this._pickerIntent = null
    this._image = null
    if (this._imageTask) this._imageTask.abort()
    this._imageTask = null
    if (this._active) this.setData({ imagePath: '', imageInfo: null, imageBusy: false, imageError: '' })
  },

  _intentCurrent(intent) {
    return !!intent && !this._disposed && intent === this._pickerIntent &&
      intent.generation === this._imageGeneration && this.data.inputKind === 'image' && isWorkspaceCurrent(intent.scope)
  },

  _promoteImage(intent) {
    if (!this._intentCurrent(intent) || !intent.done || !this._active || intent.verifiedLife !== this._life ||
        !this.data.authorized || !this.data.workspaceReady || !getApp().globalData.verified ||
        this.data.user.id !== intent.userId || this.data.workspace.id !== intent.scope.workspaceId) return
    const image = intent.candidate
    this._image = image ? { ...image, scope: intent.scope, userId: intent.userId } : null
    this._pickerIntent = null
    this._imageTask = null
    this.setData({ imageBusy: false, imagePath: image ? image.filePath : '',
      imageInfo: image ? { type: image.type.toUpperCase(), width: image.width, height: image.height,
        sizeKiB: (image.size / 1024).toFixed(1) } : null,
      imageError: intent.error || '' })
  },

  async chooseImage() {
    if (!this._active || this.data.inputKind !== 'image' || !this.data.authorized ||
        !this.data.workspaceReady || !getApp().globalData.verified) return
    this._cancelRecognition()
    this._invalidateImage()
    const intent = this._pickerIntent = {
      generation: this._imageGeneration, scope: snapshot(), userId: this.data.user.id,
      verifiedLife: this._life, hideSeen: false, done: false, candidate: null
    }
    this.setData({ imageBusy: true })
    try {
      this._imageTask = chooseAlbumImage()
      const path = await this._imageTask
      if (!this._intentCurrent(intent)) return
      this._imageTask = validateImage(path)
      intent.candidate = await this._imageTask
    } catch (error) {
      if (!this._intentCurrent(intent)) return
      intent.error = error.aborted ? '' : error.message
    } finally {
      if (this._intentCurrent(intent)) {
        intent.done = true
        this._promoteImage(intent)
      } else if (this._pickerIntent === intent) this._invalidateImage()
    }
  },

  removeImage() {
    if (!this._active) return
    this._cancelRecognition()
    this._invalidateImage()
  },

  _clearBoard() {
    const board = this.selectComponent('#business-board')
    if (board && board.getSnapshot().ready) board.clear()
  },

  _cancelRecognition() {
    this._recognitionOperation = (this._recognitionOperation || 0) + 1
    if (this._requestIdTask) this._requestIdTask.abort()
    this._requestIdTask = null
    if (this._upload) this._upload.abort()
    this._upload = null
    if (this._active) this.setData({ recognizing: false, result: null, recognitionError: '',
      multiBusy: false, multiResult: null, multiError: '' })
  },

  async recognize() {
    if (!this._active || !this.data.authorized || !this.data.workspaceReady ||
        this.data.recognizing || !getApp().globalData.verified) return
    const kind = this.data.inputKind
    const imported = this._image
    const board = kind === 'drawing' ? this.selectComponent('#business-board') : null
    const drawing = board && board.getSnapshot()
    if (kind === 'image') {
      if (!imported || this.data.imageBusy || !isWorkspaceCurrent(imported.scope) ||
          imported.userId !== this.data.user.id) return
    } else if (!drawing || !this.data.hasInk || !drawing.hasInk || !drawing.ready || drawing.drawing) return
    const saved = snapshot()
    const life = this._life
    const operation = this._recognitionOperation = (this._recognitionOperation || 0) + 1
    const current = () => this._active && life === this._life && operation === this._recognitionOperation &&
      isWorkspaceCurrent(saved) && kind === this.data.inputKind && (kind === 'image'
        ? imported === this._image && !this.data.imageBusy
        : board.getSnapshot().ready && board.getSnapshot().revision === drawing.revision)
    this.setData({ recognizing: true, result: null, recognitionError: '' })
    try {
      const image = kind === 'image' ? imported : await board.exportSnapshot()
      if (!current() || (kind === 'drawing' && image.revision !== drawing.revision)) return
      this._requestIdTask = createRequestId({
        isCurrent: current,
        fallback: () => request({
          url: `/api/v2/workspaces/${encodeURIComponent(saved.workspaceId)}/recognitions/request-id`,
          snapshot: saved, isCurrent: current
        })
      })
      const requestId = await this._requestIdTask
      if (!current()) return
      this._upload = upload({
        url: `/api/v2/workspaces/${encodeURIComponent(saved.workspaceId)}/recognitions`,
        filePath: image.filePath, formData: { source: 'MINIPROGRAM' },
        header: { 'Idempotency-Key': requestId }, snapshot: saved, isCurrent: current
      })
      const result = await this._upload
      if (current()) this.setData({ result: validateResult(result, requestId) })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ recognitionError:
        error.code === 422 ? '无法可靠识别该输入，请更换图片或重新书写单个数字。' :
          error.code === 413 ? '图片过大（单图最多 5 MiB），请更换图片或重新书写。' : error.message })
    } finally {
      if (current()) { this._upload = null; this._requestIdTask = null; this.setData({ recognizing: false }) }
    }
  },

  onMultiToggle(event) {
    if (!this._active) return
    const enabled = !!event.detail.value
    this._cancelRecognition()
    this.setData({ multiEnabled: enabled, multiResult: null, multiError: '' })
  },

  onDigitsChange(event) {
    if (!this._active) return
    this._cancelRecognition()
    this.setData({ multiDigits: Number(event.detail.value) + 1, multiResult: null, multiError: '' })
  },

  async recognizeMulti() {
    if (!this._active || !this.data.authorized || !this.data.workspaceReady ||
        this.data.multiBusy || !getApp().globalData.verified) return
    const kind = this.data.inputKind
    const imported = this._image
    const board = kind === 'drawing' ? this.selectComponent('#business-board') : null
    const drawing = board && board.getSnapshot()
    if (kind === 'image') {
      if (!imported || this.data.imageBusy || !isWorkspaceCurrent(imported.scope) ||
          imported.userId !== this.data.user.id) return
    } else if (!drawing || !this.data.hasInk || !drawing.hasInk || !drawing.ready || drawing.drawing) return
    const saved = snapshot()
    const life = this._life
    const operation = this._recognitionOperation = (this._recognitionOperation || 0) + 1
    const current = () => this._active && life === this._life && operation === this._recognitionOperation &&
      isWorkspaceCurrent(saved) && kind === this.data.inputKind && (kind === 'image'
        ? imported === this._image && !this.data.imageBusy
        : board.getSnapshot().ready && board.getSnapshot().revision === drawing.revision)
    this.setData({ multiBusy: true, multiResult: null, multiError: '' })
    try {
      const image = kind === 'image' ? imported : await board.exportSnapshot()
      if (!current() || (kind === 'drawing' && image.revision !== drawing.revision)) return
      this._requestIdTask = createRequestId({
        isCurrent: current,
        fallback: () => request({
          url: `/api/v2/workspaces/${encodeURIComponent(saved.workspaceId)}/recognitions/request-id`,
          snapshot: saved, isCurrent: current
        })
      })
      const requestId = await this._requestIdTask
      if (!current()) return
      this._upload = upload({
        url: `/api/v2/workspaces/${encodeURIComponent(saved.workspaceId)}/recognitions/multi` +
          multiQuery(this.data.multiDigits, kind === 'image'),
        filePath: image.filePath, formData: { source: 'MINIPROGRAM' },
        header: { 'Idempotency-Key': requestId }, snapshot: saved, isCurrent: current
      })
      const result = await this._upload
      if (current()) this.setData({ multiResult: validateMultiResult(result, requestId) })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ multiError:
        error.code === 422 ? '无法可靠识别这串数字，请减少位数后重试。' :
          error.code === 413 ? '图片过大（单图最多 5 MiB），请更换图片。' : error.message })
    } finally {
      if (current()) { this._upload = null; this._requestIdTask = null; this.setData({ multiBusy: false }) }
    }
  },

  openAccount() { wx.navigateTo({ url: '/pages/account/account' }) },
  openHelp() { wx.navigateTo({ url: '/pages/help/help' }) },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },

  logout() {
    const saved = snapshot()
    // Dispatch revocation with the old token before clearing local state. Never retry POST.
    const revocation = saved.token ? request({ url: '/api/v2/auth/logout', method: 'POST', snapshot: saved }) : null
    clearSession()
    this._stop()
    if (revocation) revocation.catch(() => {})
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
