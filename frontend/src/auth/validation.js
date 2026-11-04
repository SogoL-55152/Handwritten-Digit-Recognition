// Exact contract set; JavaScript \s alone omits U+0085. Do not normalize credentials.
export const registrationWhitespace = /[\u{0009}-\u{000d}\u{0020}\u{0085}\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}-\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]/u

function credential(value, min, label, strict) {
  if (typeof value !== 'string' || value.length < min || value.length > 32) throw new Error(`${label}长度需为 ${min}–32 个字符`)
  if (strict ? registrationWhitespace.test(value) : /^\s*$/.test(value)) {
    throw new Error(strict ? `${label}不能包含空白字符` : `${label}不能为空`)
  }
  return value
}

export function authPayload(form, { registering = false, pilot = false } = {}) {
  const payload = {
    username: credential(form.username, 3, '用户名', registering),
    password: credential(form.password, 6, '密码', registering)
  }
  if (!registering) return payload
  if ((form.nickname || '').length > 64) throw new Error('昵称最长 64 个字符')
  if (form.nickname?.trim()) payload.nickname = form.nickname.trim()
  if (pilot) {
    if (form.confirmPassword !== form.password) throw new Error('两次输入的密码不一致')
    if (typeof form.pilotCode !== 'string' || !form.pilotCode.trim()) throw new Error('请输入维护者提供的体验码')
    payload.pilotCode = form.pilotCode // Opaque user input, never trim, persist or log.
  }
  return payload
}

export function passwordPayload(form) {
  return {
    currentPassword: credential(form.currentPassword, 6, '原密码', false),
    newPassword: credential(form.newPassword, 6, '新密码', true)
  }
}
