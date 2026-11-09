const { readSession } = require('./utils/session')

App({
  globalData: {
    // Resolved from config/public.js and wx envVersion; invalid environments stay offline.
    baseUrl: '',
    token: '',
    user: null,
    verified: false,
    workspaceId: ''
  },

  onLaunch() {
    // Restore a candidate only; pages verify identity before business requests.
    readSession(this)
  },

  onShow() {
    // Re-check environment/origin without contacting the service.
    readSession(this)
  }
})
