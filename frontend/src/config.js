// Public, build-time settings only. Registration codes belong exclusively to user input.
export function readAppConfig(env = {}) {
  const mode = env.VITE_APP_MODE || 'development'
  if (!['development', 'pilot'].includes(mode)) throw new Error('VITE_APP_MODE 必须为 development 或 pilot')
  const config = {
    mode,
    pilot: mode === 'pilot',
    operator: (env.VITE_PILOT_OPERATOR || '').trim(),
    contact: (env.VITE_PILOT_CONTACT || '').trim(),
    privacyVersion: (env.VITE_PILOT_PRIVACY_VERSION || '').trim()
  }
  return Object.freeze(config)
}

export function assertPublishable(config) {
  if (config.pilot && (!config.operator || !config.contact || !config.privacyVersion)) {
    throw new Error('pilot 发布必须配置 VITE_PILOT_OPERATOR、VITE_PILOT_CONTACT 和 VITE_PILOT_PRIVACY_VERSION；本地预览可使用 npm run dev')
  }
}
