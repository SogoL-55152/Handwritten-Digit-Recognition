// Exact shared pilot contract; JS \s alone omits U+0085. Do not apply this to legacy credentials.
const NEW_CREDENTIAL_WHITESPACE = new RegExp('[' + [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
].map((code) => String.fromCharCode(code)).join('') + ']')

function newCredential(value, minimum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= 32 &&
    !NEW_CREDENTIAL_WHITESPACE.test(value)
}
function registrationError({ username, password, confirmation, nickname, pilotCode }, pilot) {
  if (!newCredential(username, 3)) return '用户名须为 3–32 字符，不能含空白字符（不会自动去空白）'
  if (!newCredential(password, 6)) return '密码须为 6–32 字符，不能含空白字符（不会自动去空白）'
  if (confirmation !== password) return '两次输入的密码不一致'
  if (typeof nickname !== 'string' || nickname.length > 64) return '昵称最多 64 字符'
  if (typeof pilotCode !== 'string' || pilotCode.length > 256) return '试用注册码最多 256 字符'
  if (pilot && !pilotCode.trim()) return '请输入维护者提供的试用注册码'
  return ''
}
function passwordError({ currentPassword, newPassword, confirmation }) {
  // Current password follows legacy login semantics, including significant surrounding/internal spaces.
  if (typeof currentPassword !== 'string' || !currentPassword.trim() || currentPassword.length < 6 || currentPassword.length > 32) return '请输入原密码（6–32 字符，不会自动去空白）'
  if (!newCredential(newPassword, 6)) return '新密码须为 6–32 字符，不能含空白字符（不会自动去空白）'
  if (confirmation !== newPassword) return '两次输入的新密码不一致'
  return ''
}
module.exports = { NEW_CREDENTIAL_WHITESPACE, newCredential, registrationError, passwordError }
