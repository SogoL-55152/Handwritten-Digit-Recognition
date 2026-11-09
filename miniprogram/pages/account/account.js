const { getRuntime } = require('../../config/runtime')
const { request } = require('../../utils/request')
const { passwordError } = require('../../utils/credentials')
const { readSession, clearSession, verifySession, snapshot, isSessionCurrent, subscribe } = require('../../utils/session')

Page({
  data: {
    user: null, authorized: false, verifying: false, loading: false, error: '', configurationError: '',
    currentPassword: '', newPassword: '', confirmation: ''
  },
  async onShow() {
    this._active = true
    const operation = this._operation = (this._operation || 0) + 1
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = subscribe(() => {
      this._operation += 1
      if (this._request) this._request.abort()
      if (this._active) {
        this._clearSensitive()
        this.setData({ authorized: false, user: null, verifying: false, loading: false })
      }
    })
    this._clearSensitive()
    const runtime = getRuntime()
    this.setData({ authorized: false, user: null, error: '', configurationError: runtime.error, verifying: false, loading: false })
    if (!runtime.networkAllowed) { readSession(); return }
    if (!readSession()) { wx.reLaunch({ url: '/pages/login/login' }); return }
    const saved = snapshot()
    const current = () => this._active && operation === this._operation && isSessionCurrent(saved)
    this.setData({ verifying: true })
    try {
      this._verification = verifySession()
      const identity = await this._verification
      if (current()) this.setData({ authorized: true, user: identity.user })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (current()) this.setData({ verifying: false })
    }
  },
  _clearSensitive() { this.setData({ currentPassword: '', newPassword: '', confirmation: '' }) },
  onHide() { this._stop() },
  onUnload() { this._stop() },
  _stop() {
    this._active = false
    this._operation = (this._operation || 0) + 1
    if (this._request) this._request.abort()
    if (this._verification) this._verification.abort()
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = null
    this._request = null
    this._verification = null
    this._clearSensitive()
    this.setData({ loading: false, verifying: false, authorized: false, user: null })
  },
  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (!this.data.loading && ['currentPassword', 'newPassword', 'confirmation'].includes(field)) this.setData({ [field]: event.detail.value })
  },
  openDrawing() { wx.reLaunch({ url: '/pages/index/index' }) },
  openHelp() { wx.navigateTo({ url: '/pages/help/help' }) },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },
  async submit() {
    if (!this._active || !this.data.authorized || this.data.loading) return
    const runtime = getRuntime()
    if (!runtime.networkAllowed) { this.setData({ configurationError: runtime.error }); this._clearSensitive(); return }
    const error = passwordError(this.data)
    if (error) { this.setData({ error }); this._clearSensitive(); return }
    const { currentPassword, newPassword } = this.data
    const operation = ++this._operation
    const saved = snapshot()
    const current = () => this._active && operation === this._operation && isSessionCurrent(saved)
    this.setData({ loading: true, error: '' })
    try {
      this._request = request({ url: '/api/v2/auth/password', method: 'POST', data: { currentPassword, newPassword }, snapshot: saved, isCurrent: current })
      const response = await this._request
      if (!current()) return
      if (response !== null) throw new Error('改密响应格式错误，请返回登录页使用新密码核验；不会自动重试')
      // Server revokes all user sessions; clear only the local session that submitted this request.
      if (clearSession(getApp(), saved)) wx.reLaunch({ url: '/pages/login/login' })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (this._active && operation === this._operation) {
        this._request = null
        this._clearSensitive()
        this.setData({ loading: false })
      }
    }
  },
  logout() {
    const saved = snapshot()
    const revocation = saved.token ? request({ url: '/api/v2/auth/logout', method: 'POST', snapshot: saved }) : null
    if (revocation) revocation.catch(() => {})
    if (clearSession(getApp(), saved)) {
      this._stop()
      wx.reLaunch({ url: '/pages/login/login' })
    }
  }
})
