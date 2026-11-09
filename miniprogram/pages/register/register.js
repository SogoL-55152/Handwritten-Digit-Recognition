const { getRuntime } = require('../../config/runtime')
const { request } = require('../../utils/request')
const { registrationError } = require('../../utils/credentials')
const { clearSession, saveSession, verifySession, snapshot, isSessionCurrent } = require('../../utils/session')

Page({
  data: {
    username: '', password: '', confirmation: '', nickname: '', pilotCode: '',
    loading: false, error: '', configurationError: '', pilot: false
  },
  onShow() {
    this._active = true
    this._operation = (this._operation || 0) + 1
    const runtime = getRuntime()
    this.setData({ loading: false, error: '', pilot: runtime.mode === 'pilot', configurationError: runtime.error })
    this._clearSensitive()
  },
  onHide() { this._stop() },
  onUnload() { this._stop() },
  _clearSensitive() { this.setData({ password: '', confirmation: '', pilotCode: '' }) },
  _stop() {
    this._active = false
    this._operation = (this._operation || 0) + 1
    if (this._request) this._request.abort()
    if (this._verification) this._verification.abort()
    this._request = null
    this._verification = null
    this._clearSensitive()
    this.setData({ loading: false })
  },
  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (!this.data.loading && ['username', 'password', 'confirmation', 'nickname', 'pilotCode'].includes(field)) {
      this.setData({ [field]: event.detail.value })
    }
  },
  openLogin() { wx.reLaunch({ url: '/pages/login/login' }) },
  openHelp() { wx.navigateTo({ url: '/pages/help/help' }) },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },
  async submit() {
    if (!this._active || this.data.loading) return
    const runtime = getRuntime()
    if (!runtime.networkAllowed) { this.setData({ configurationError: runtime.error }); this._clearSensitive(); return }
    const error = registrationError(this.data, runtime.mode === 'pilot')
    if (error) { this.setData({ error }); this._clearSensitive(); return }
    const { username, password, nickname, pilotCode } = this.data
    // Confirmation is local only. The invite code exists only in this attempt, never storage/config/logs.
    const payload = { username, password, ...(nickname ? { nickname } : {}), ...(pilotCode ? { pilotCode } : {}) }
    clearSession()
    const operation = ++this._operation
    let saved = snapshot()
    const current = () => this._active && operation === this._operation && isSessionCurrent(saved)
    this.setData({ loading: true, error: '' })
    try {
      this._request = request({ url: '/api/v2/auth/register', method: 'POST', auth: false,
        data: payload, snapshot: saved, isCurrent: current })
      const response = await this._request
      if (!current()) return
      this._clearSensitive()
      if (!saveSession(response, getApp(), saved)) {
        saved = snapshot()
        throw new Error('注册响应不完整，请返回登录页核验账号后再试')
      }
      saved = snapshot()
      this._verification = verifySession()
      await this._verification
      if (current()) wx.reLaunch({ url: '/pages/index/index' })
    } catch (error) {
      if (current() && !error.stale && !error.aborted) this.setData({ error: error.message })
    } finally {
      if (this._active && operation === this._operation) {
        this._request = null
        this._clearSensitive()
        this.setData({ loading: false })
      }
    }
  }
})
