const { getRuntime } = require('../../config/runtime')
const { request } = require('../../utils/request')
const { readSession, saveSession, clearSession, verifySession, snapshot, isSessionCurrent } = require('../../utils/session')

Page({
  data: { username: '', password: '', loading: false, error: '', hasCandidate: false, pilot: false, configurationError: '' },

  onShow() {
    this._active = true
    this._operation = (this._operation || 0) + 1
    // A cached token is only a candidate; verify on explicit user action.
    const runtime = getRuntime()
    this.setData({ loading: false, password: '', hasCandidate: !!readSession(), error: '',
      pilot: runtime.mode === 'pilot', configurationError: runtime.error })
  },

  onHide() { this._stop() },
  onUnload() { this._stop() },
  _stop() {
    this._active = false
    this._operation = (this._operation || 0) + 1
    if (this._request) this._request.abort()
    if (this._verification) this._verification.abort()
    this._request = null
    this._verification = null
    this.setData({ password: '', loading: false })
  },

  openRegister() { wx.navigateTo({ url: '/pages/register/register' }) },
  openHelp() { wx.navigateTo({ url: '/pages/help/help' }) },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (!this.data.loading && (field === 'username' || field === 'password')) this.setData({ [field]: event.detail.value })
  },

  async continueSession() {
    if (!this._active || this.data.loading || !readSession()) return
    const operation = ++this._operation
    const saved = snapshot()
    const current = () => this._active && operation === this._operation && isSessionCurrent(saved)
    this.setData({ loading: true, error: '' })
    try {
      this._verification = verifySession()
      await this._verification
      if (current()) wx.reLaunch({ url: '/pages/index/index' })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (current()) this.setData({ loading: false })
    }
  },

  async submit() {
    if (!this._active || this.data.loading) return
    const runtime = getRuntime()
    if (!runtime.networkAllowed) { this.setData({ configurationError: runtime.error, password: '' }); return }
    const { username, password } = this.data
    if (!username.trim() || !password.trim()) {
      this.setData({ error: '请输入用户名和密码', password: '' })
      return
    }
    // Replacing the login intent invalidates old /me and 401 responses, even before POST returns.
    clearSession()
    const operation = ++this._operation
    let saved = snapshot()
    const current = () => this._active && operation === this._operation && isSessionCurrent(saved)
    this.setData({ loading: true, error: '', hasCandidate: false })
    try {
      this._request = request({
        url: '/api/v2/auth/login', method: 'POST', auth: false,
        data: { username, password }, snapshot: saved, isCurrent: current
      })
      const data = await this._request
      if (!current()) return
      if (!saveSession(data, getApp(), saved)) {
        saved = snapshot()
        throw new Error('登录信息不完整，请重试')
      }
      saved = snapshot()
      this.setData({ password: '', hasCandidate: true })
      this._verification = verifySession()
      await this._verification
      if (current()) wx.reLaunch({ url: '/pages/index/index' })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (this._active && operation === this._operation) {
        this._request = null
        this.setData({ loading: false, password: '' })
      }
    }
  }
})
