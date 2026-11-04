const publicConfig = require('./public')
const PUBLIC_KEYS = ['mode', 'apiBaseUrl', 'operator', 'contact', 'privacyVersion']
const PLACEHOLDER = /(?:example|placeholder|your[-_ .]?(?:domain|name|company|contact|appid)|change[-_ ]?me|待(?:填写|配置|确认|提供)|未配置|示例|占位|请(?:填写|替换)|你的(?:域名|姓名|联系方式)|<[^>]*>|\$\{[^}]*\})|^(?:todo|tbd|test|demo|sample|none|null|undefined|n\/?a|unknown|x+|[-_.?]+)$/i

// Keep this parser platform-independent: the mini-program does not require a global URL API.
function parseOrigin(value) {
  if (typeof value !== 'string') return null
  const match = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([0-9]{1,5}))?\/?$/i.exec(value)
  if (!match) return null
  const scheme = match[1].toLowerCase(), host = match[2].toLowerCase()
  const port = match[3] ? Number(match[3]) : null
  if (port !== null && (port < 1 || port > 65535)) return null
  if (host !== '[::1]' && host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63)) return null
  if (host.length > 253) return null
  const suffix = port && !((scheme === 'http' && port === 80) || (scheme === 'https' && port === 443)) ? `:${port}` : ''
  return { scheme, host, origin: `${scheme}://${host}${suffix}` }
}

function isPublicHost(host) {
  // Literal IPs, special-use names and obvious placeholders are not deployment domains.
  return host.includes('.') && /^[a-z]{2,63}$/.test(host.split('.').pop()) &&
    !/(^|\.)(localhost|localdomain|local|lan|home|internal|intranet|corp|private|onion|test|invalid|example|arpa)$/.test(host) &&
    !/(^|[.-])(todo|tbd|demo|sample)([.-]|$)/i.test(host) && !PLACEHOLDER.test(host)
}

// envVersion/publicConfig are explicitly injectable for Node stubs; no storage/query-string overrides.
function resolveRuntime(options = {}) {
  const config = Object.prototype.hasOwnProperty.call(options, 'publicConfig') ? options.publicConfig : publicConfig
  let envVersion = options.envVersion
  if (!Object.prototype.hasOwnProperty.call(options, 'envVersion')) {
    try {
      const platform = options.wx || (typeof wx === 'undefined' ? null : wx)
      envVersion = platform.getAccountInfoSync().miniProgram.envVersion
    } catch (_) { envVersion = '' }
  }
  const source = config && typeof config === 'object' ? config : {}
  const runtime = {
    envVersion, mode: source.mode, apiBaseUrl: '', networkAllowed: false,
    operator: typeof source.operator === 'string' ? source.operator : '',
    contact: typeof source.contact === 'string' ? source.contact : '',
    privacyVersion: typeof source.privacyVersion === 'string' ? source.privacyVersion : '', error: ''
  }
  const fail = (reason) => ({ ...runtime, error: `服务未配置：${reason}。请联系维护者；帮助和隐私说明仍可离线阅读。` })
  if (!['develop', 'trial', 'release'].includes(envVersion)) return fail('无法确认微信运行环境')
  if (Object.keys(source).some((key) => !PUBLIC_KEYS.includes(key)) || PUBLIC_KEYS.some((key) => typeof source[key] !== 'string')) return fail('公开配置字段缺失或不符合约定')
  if (!['development', 'pilot'].includes(source.mode)) return fail('运行模式缺失或无效')
  if (envVersion !== 'develop' && source.mode !== 'pilot') return fail('体验版和正式版必须使用 pilot 配置')
  const parsed = parseOrigin(source.apiBaseUrl)
  if (!parsed) return fail('服务地址必须为不含路径、凭据或参数的 origin')
  if (source.mode === 'pilot') {
    if (parsed.scheme !== 'https' || !isPublicHost(parsed.host)) return fail('需要真实配置的 HTTPS 域名，不能使用示例地址或本机地址')
    if (![runtime.operator, runtime.contact, runtime.privacyVersion].every((value) => value.trim() && value === value.trim() && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value) && !PLACEHOLDER.test(value))) return fail('维护者、联系方式和隐私版本尚未填写有效值')
  }
  return {
    ...runtime, apiBaseUrl: parsed.origin, networkAllowed: true
  }
}

function getRuntime(app = getApp()) {
  const runtime = resolveRuntime(app._runtimeOptions)
  app.globalData.runtime = runtime
  app.globalData.baseUrl = runtime.apiBaseUrl
  return runtime
}

module.exports = { resolveRuntime, getRuntime, parseOrigin }
