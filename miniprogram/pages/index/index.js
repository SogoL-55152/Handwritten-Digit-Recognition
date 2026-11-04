const { getRuntime } = require('../../config/runtime')
const { request, upload } = require('../../utils/request')
const {
  readSession, clearSession, verifySession, snapshot, isSessionCurrent,
  isWorkspaceCurrent, selectWorkspace, subscribe
} = require('../../utils/session')
const { createRequestId, validWorkspace, validateResult } = require('../../utils/recognition')

Page({
  data: {
    user: null, authorized: false, loading: false, error: '',
    pilot: false, configurationError: '',
    workspaces: [], workspaceIndex: -1, workspace: null, workspaceReady: false, spaceLoading: false,
    hasInk: false, recognizing: false, recognitionError: '', result: null
  },

  async onShow() {
    this._active = true
    const life = this._life = (this._life || 0) + 1
    this._cancelRecognition()
    if (this._loadRequest) this._loadRequest.abort()
    if (this._workspaceRequest) this._workspaceRequest.abort()
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = subscribe(() => {
      this._life += 1
      this._cancelRecognition()
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
      await this._chooseWorkspace(preferred.id)
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (current()) { this._loadRequest = null; this.setData({ loading: false }) }
    }
  },

  onHide() { this._stop() },
  onUnload() { this._stop() },
  _stop() {
    this._active = false
    this._life = (this._life || 0) + 1
    this._cancelRecognition()
    this._clearBoard()
    if (this._verification) this._verification.abort()
    if (this._loadRequest) this._loadRequest.abort()
    if (this._workspaceRequest) this._workspaceRequest.abort()
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = null
  },

  async _chooseWorkspace(id) {
    if (!this._active || !this.data.authorized || !this.data.workspaces.some((space) => space.id === id)) return
    const runtime = getRuntime()
    if (!runtime.networkAllowed || (runtime.mode === 'pilot' && id !== getApp().globalData.defaultWorkspaceId)) return
    this._cancelRecognition()
    this._clearBoard()
    if (this._workspaceRequest) this._workspaceRequest.abort()
    const saved = selectWorkspace(id)
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
    } catch (error) {
      // 403/404 are scoped failures, not a reason to log out an ordinary member.
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
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
    if (!this._active) return
    this._cancelRecognition()
    this.setData({ hasInk: !!event.detail.hasInk })
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
    if (this._active) this.setData({ recognizing: false, result: null, recognitionError: '' })
  },

  async recognize() {
    if (!this._active || !this.data.authorized || !this.data.workspaceReady ||
        !this.data.hasInk || this.data.recognizing || !getApp().globalData.verified) return
    const board = this.selectComponent('#business-board')
    if (!board) return
    const drawing = board.getSnapshot()
    if (!drawing.hasInk || !drawing.ready || drawing.drawing) return
    const saved = snapshot()
    const life = this._life
    const operation = this._recognitionOperation = (this._recognitionOperation || 0) + 1
    const current = () => this._active && life === this._life && operation === this._recognitionOperation &&
      isWorkspaceCurrent(saved) && board.getSnapshot().ready && board.getSnapshot().revision === drawing.revision
    this.setData({ recognizing: true, result: null, recognitionError: '' })
    try {
      const image = await board.exportSnapshot()
      if (!current() || image.revision !== drawing.revision) return
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
      if (current() && !error.stale && !error.aborted) this.setData({ recognitionError: error.message })
    } finally {
      if (current()) { this._upload = null; this._requestIdTask = null; this.setData({ recognizing: false }) }
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
