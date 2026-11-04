#!/usr/bin/env node
// Node 22+, standard library only. This prepares a local candidate; it never uploads,
// reads environment variables, imports application code, or certifies a deployment.
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_KEYS = ['mode', 'apiBaseUrl', 'operator', 'contact', 'privacyVersion']
const INPUT_KEYS = [...PUBLIC_KEYS, 'appid']
const PAGE_NAMES = ['login', 'register', 'index', 'account', 'help', 'privacy']
const PAGES = PAGE_NAMES.map((name) => `pages/${name}/${name}`)
const PROTOTYPE = 'pages/drawing-prototype/drawing-prototype'
const SOURCE_EXTENSIONS = ['.js', '.json', '.wxml', '.wxss']
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.ttf', '.woff', '.woff2']
const SOURCE_FILES = [
  'app.js', 'app.wxss', 'config/runtime.js',
  'utils/credentials.js', 'utils/request.js', 'utils/session.js', 'utils/recognition.js',
  ...SOURCE_EXTENSIONS.map((extension) => `components/drawing-board/drawing-board${extension}`),
  ...PAGES.flatMap((page) => SOURCE_EXTENSIONS.map((extension) => `${page}${extension}`))
]
const GENERATED_FILES = ['app.json', 'sitemap.json', 'config/public.js', 'project.config.json']
const UNVERIFIED = [
  'Public DNS/IP routing, server availability, TLS certificates and HTTPS/API behavior are not checked (no network calls).',
  'AppID format or operator confirmation does not prove ownership or platform authorization.',
  'WeChat legal-domain/privacy settings, developer tools, real devices, upload and trial membership remain unverified.',
  'Local functional/build tests, operator/contact authenticity, retention operations and privacy/legal review remain separate gates.',
  'A static pass or candidate directory is not a release, compliance approval or network-readiness claim.'
]
const PLACEHOLDER = /(?:example|placeholder|your[-_ .]?(?:domain|name|company|contact|appid)|change[-_ ]?me|待(?:填写|配置|确认|提供)|未配置|示例|占位|请(?:填写|替换)|你的(?:域名|姓名|联系方式)|<[^>]*>|\$\{[^}]*\})|^(?:todo|tbd|test|demo|sample|none|null|undefined|n\/?a|unknown|x+|[-_.?]+)$/i
const SECRET_NAME = /(?:^|[._-])(?:secrets?|private|local|tokens?|passwords?)(?:[._-]|$)|^\.env(?:\.|$)|^(?:credentials\.(?:json|ya?ml|ini)|id_rsa|id_ed25519)|\.(?:pem|key|p12|pfx|jks|keystore)$/i
const SECRET_KEY = /^(?:pilotCode|pilotRegistrationCode|registrationCode|PILOT_REGISTRATION_CODE|appSecret|clientSecret|secret|jwtSecret|jwtSecretKey|password|currentPassword|newPassword|token|accessToken|refreshToken|apiKey|authorization)$/i
const APP_KEYS = ['pages', 'window', 'style', 'sitemapLocation', 'lazyCodeLoading']
const WINDOW_KEYS = ['navigationBarTitleText', 'navigationBarBackgroundColor', 'navigationBarTextStyle', 'backgroundColor', 'backgroundTextStyle', 'enablePullDownRefresh', 'navigationStyle']

class ReleaseError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
function fail(code, message) { throw new ReleaseError(code, message) }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function issue(error) {
  return error instanceof ReleaseError
    ? { code: error.code, message: error.message }
    : { code: 'FILESYSTEM_ERROR', message: 'A filesystem operation failed; no input values or underlying error details are printed.' }
}
function onlyKeys(value, allowed, code) {
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code, 'Unexpected or prohibited configuration fields; provide only documented public fields.')
}
function hasTraversal(value) { return typeof value !== 'string' || value.split(/[\\/]/).includes('..') || value.includes('\0') }
function safeAbsolute(value) {
  if (hasTraversal(value)) fail('UNSAFE_PATH', 'Path traversal is not accepted.')
  return path.resolve(value)
}
function inside(root, destination) {
  const relative = path.relative(root, destination)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function noSymlinks(target, missingAllowed = false) {
  const absolute = safeAbsolute(target)
  const parsed = path.parse(absolute)
  let cursor = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (missingAllowed && error.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED', 'Symbolic links and directory junctions are not accepted.')
  }
}
function readFile(root, relative) {
  if (hasTraversal(relative) || path.isAbsolute(relative) || relative.includes('\\')) fail('UNSAFE_PATH', 'Invalid source path.')
  if (relative.split('/').some((part) => SECRET_NAME.test(part))) fail('PROHIBITED_FILENAME', 'A prohibited local/private/credential filename was found; it was not read.')
  const target = path.resolve(root, relative)
  if (!inside(root, target)) fail('UNSAFE_PATH', 'Source path escapes its root.')
  noSymlinks(target)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('SOURCE_FILE_INVALID', 'A required source file is not a regular file or exceeds the size limit.')
  return fs.readFileSync(target)
}
function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')) } catch { fail('INVALID_JSON', 'A JSON input is invalid; its contents are not printed.') }
}

// Parse just an object of string literals. In particular, do not require(), eval()
// or use a VM to read public.js: even a development config must not execute here.
export function parsePublicModule(text) {
  let offset = 0
  const bad = () => fail('PUBLIC_MODULE_INVALID', 'public.js must contain only module.exports with public string-literal fields.')
  function skip() {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) { offset++; continue }
      if (text.startsWith('//', offset)) { const end = text.indexOf('\n', offset); offset = end < 0 ? text.length : end + 1; continue }
      if (text.startsWith('/*', offset)) { const end = text.indexOf('*/', offset + 2); if (end < 0) bad(); offset = end + 2; continue }
      break
    }
  }
  function take(value) { skip(); if (!text.startsWith(value, offset)) bad(); offset += value.length }
  function string() {
    skip()
    const quote = text[offset++]
    if (quote !== '"' && quote !== "'") bad()
    let value = ''
    while (offset < text.length) {
      const character = text[offset++]
      if (character === quote) return value
      if (character.charCodeAt(0) < 32) bad()
      if (character !== '\\') { value += character; continue }
      const escaped = text[offset++]
      const escapes = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (escaped === 'u') {
        const digits = text.slice(offset, offset + 4)
        if (!/^[0-9a-f]{4}$/i.test(digits)) bad()
        value += String.fromCharCode(parseInt(digits, 16)); offset += 4
      } else if (Object.hasOwn(escapes, escaped)) value += escapes[escaped]
      else bad()
    }
    bad()
  }
  take('module'); take('.'); take('exports'); take('='); take('{')
  const result = {}
  while (true) {
    skip()
    if (text[offset] === '}') { offset++; break }
    let key
    if (text[offset] === '"' || text[offset] === "'") key = string()
    else { const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(offset)); if (!match) bad(); key = match[0]; offset += key.length }
    if (!PUBLIC_KEYS.includes(key) || Object.hasOwn(result, key)) bad()
    take(':'); result[key] = string(); skip()
    if (text[offset] === ',') { offset++; continue }
    if (text[offset] !== '}') bad()
  }
  skip(); if (text[offset] === ';') offset++; skip()
  if (offset !== text.length || PUBLIC_KEYS.some((key) => !Object.hasOwn(result, key))) bad()
  return result
}

function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 300 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/i.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  const host = url.hostname.toLowerCase()
  const labels = host.split('.')
  if (isIP(host) || labels.length < 2 || host.length > 253 || !/^[a-z]{2,63}$/.test(labels.at(-1))) return null
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  if (/(?:^|\.)(?:localhost|localdomain|local|lan|home|internal|intranet|corp|private|onion|test|invalid|example|arpa)$/.test(host) || /(?:^|[.-])(?:todo|tbd|demo|sample)(?:[.-]|$)/i.test(host) || PLACEHOLDER.test(host)) return null
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port === '0') return null
  return url.origin
}

export function validatePublicConfig(input = {}) {
  const blockers = []
  try { onlyKeys(input, INPUT_KEYS, 'PUBLIC_FIELDS_ONLY') } catch (error) { return { blockers: [issue(error)], config: null } }
  const config = { mode: 'pilot' }
  const origin = publicOrigin(input.apiBaseUrl)
  if (!origin) blockers.push({ code: 'API_ORIGIN_REQUIRED', message: 'apiBaseUrl requires an HTTPS public DNS origin, not an IP, local/private/special-use name, placeholder, path or credential-bearing URL.' })
  else config.apiBaseUrl = origin
  if (input.mode !== undefined && input.mode !== 'pilot') blockers.push({ code: 'PILOT_MODE_REQUIRED', message: 'The supplied release mode must be pilot.' })
  for (const key of ['operator', 'contact', 'privacyVersion']) {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value) || PLACEHOLDER.test(value)) {
      blockers.push({ code: `${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_REQUIRED`, message: `${key} must be explicitly supplied, nonempty and nonplaceholder; authenticity still requires human verification.` })
    } else config[key] = value
  }
  if (typeof input.appid !== 'string' || !/^wx[0-9a-f]{16}$/.test(input.appid) || /^wx([0-9a-f])\1{15}$/.test(input.appid)) {
    blockers.push({ code: 'APPID_REQUIRED', message: 'Supply a nonplaceholder AppID in wx + 16 lowercase hexadecimal characters format. Format is not proof of ownership.' })
  } else config.appid = input.appid
  return { blockers, config: blockers.length ? null : config }
}

function inspectSecrets(relative, buffer) {
  if (relative.split('/').some((part) => SECRET_NAME.test(part))) fail('PROHIBITED_FILENAME', 'A prohibited local/private/credential filename was found.')
  if (!['.js', '.json', '.wxml', '.wxss', '.svg'].includes(path.posix.extname(relative))) return
  const text = buffer.toString('utf8')
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(text)) fail('SECRET_LITERAL', 'A credential-like literal was detected; contents are not printed.')
  // Empty UI fields and runtime variables are legitimate; nonempty credential
  // string assignments in the package are not. This is a guard, not a secret audit.
  const assignment = /["']?\b([A-Za-z_$][\w$]*)["']?\s*(?::|=(?!=|>))\s*(["'`])((?:\\.|(?!\2)[^\\\r\n])*?)\2/g
  for (const match of text.matchAll(assignment)) {
    const normalized = match[1].replace(/_/g, '')
    const runtimeHeader = /^authorization$/i.test(match[1]) && (match[3] === 'Bearer ' || (match[2] === '`' && /^Bearer \$\{(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\}$/.test(match[3])))
    if ((SECRET_KEY.test(match[1]) || SECRET_KEY.test(normalized)) && match[3].length > 0 && !runtimeHeader) fail('SECRET_LITERAL', 'A nonempty credential/registration-code literal was detected; contents are not printed.')
  }
  if (relative.endsWith('.json')) {
    const visit = (value) => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY.test(key) || /^(?:__proto__|constructor|prototype)$/.test(key)) fail('PROHIBITED_JSON_FIELD', 'A prohibited credential or unsafe JSON field was found.')
        visit(child)
      }
    }
    visit(parseJson(buffer))
  }
}
function jsonBuffer(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }
function publicBuffer(config) {
  return Buffer.from(`// Generated public pilot configuration. No credentials belong here.\nmodule.exports = ${JSON.stringify(Object.fromEntries(PUBLIC_KEYS.map((key) => [key, config[key]])), null, 2)}\n`)
}
function generatedProject(config) {
  return { appid: config.appid, compileType: 'miniprogram', miniprogramRoot: './', projectname: 'pilot-miniprogram', setting: { urlCheck: true, es6: true, enhance: true, minified: true } }
}
function generateApp(source) {
  onlyKeys(source, APP_KEYS, 'APP_CONFIG_UNSUPPORTED')
  if (!Array.isArray(source.pages) || source.pages.some((page) => typeof page !== 'string' || (!PAGES.includes(page) && page !== PROTOTYPE)) || new Set(source.pages).size !== source.pages.length || PAGES.some((page) => !source.pages.includes(page))) fail('PAGE_MANIFEST_INVALID', 'app.json must declare the pilot login/register/index/account/help/privacy pages and no unknown pages.')
  onlyKeys(source.window, WINDOW_KEYS, 'WINDOW_CONFIG_UNSUPPORTED')
  if (Object.values(source.window).some((value) => typeof value !== 'string' && typeof value !== 'boolean')) fail('WINDOW_CONFIG_UNSUPPORTED', 'Only simple supported window settings are accepted.')
  if (source.style !== 'v2' || source.sitemapLocation !== 'sitemap.json' || (source.lazyCodeLoading !== undefined && source.lazyCodeLoading !== 'requiredComponents')) fail('APP_CONFIG_UNSUPPORTED', 'Unsupported style, sitemap path or lazy loading setting.')
  return { ...source, pages: source.pages.filter((page) => page !== PROTOTYPE), window: { ...source.window } }
}
function generateSitemap(source) {
  onlyKeys(source, ['desc', 'rules'], 'SITEMAP_UNSUPPORTED')
  if (!Array.isArray(source.rules) || (source.desc !== undefined && typeof source.desc !== 'string')) fail('SITEMAP_UNSUPPORTED', 'Unsupported sitemap structure.')
  for (const rule of source.rules) {
    onlyKeys(rule, ['action', 'page'], 'SITEMAP_UNSUPPORTED')
    if (!['allow', 'disallow'].includes(rule.action) || !['*', PROTOTYPE, ...PAGES].includes(rule.page)) fail('SITEMAP_UNSUPPORTED', 'Unsupported sitemap rule.')
  }
  return { ...source, rules: source.rules.filter((rule) => rule.page !== PROTOTYPE) }
}

function assetReferences(relative, text) {
  const result = []
  // Literal asset references in JS/JSON, WXML src and WXSS url(). Dynamic asset
  // paths are deliberately unsupported: a whitelist cannot determine their files.
  const literals = /["'`]([^"'`\r\n]+)["'`]|url\(\s*([^\s)'"`]+)\s*\)/g
  for (const match of text.matchAll(literals)) {
    const reference = match[1] || match[2]
    if (!/(?:^|\/)assets\//.test(reference)) continue
    if (/[\\%?#{}:$]/.test(reference)) fail('ASSET_REFERENCE_INVALID', 'Dynamic, external, encoded or malformed asset references are not accepted.')
    const target = reference.startsWith('/') ? reference.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference))
    if (!target.startsWith('assets/') || hasTraversal(target) || !ASSET_EXTENSIONS.includes(path.posix.extname(target)) || !/^[A-Za-z0-9_./-]+$/.test(target)) fail('ASSET_REFERENCE_INVALID', 'An asset reference is outside the approved assets tree or extension allowlist.')
    // Only ordinary parent-directory resolution to assets is allowed, never
    // traversal after entering the assets tree.
    if (reference.slice(reference.indexOf('assets/') + 7).split('/').includes('..')) fail('ASSET_REFERENCE_INVALID', 'Asset-tree path traversal is not accepted.')
    result.push(target)
  }
  return result
}
function verifyDependencies(files) {
  for (const [relative, buffer] of files) {
    const text = buffer.toString('utf8')
    if (relative.endsWith('.js')) {
      for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const reference = match[1]
        if (!reference.startsWith('.') || reference.includes('\\')) fail('DEPENDENCY_NOT_PACKAGED', 'Only relative, whitelisted JavaScript dependencies are accepted.')
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference))
        if (!files.has(resolved) && !files.has(`${resolved}.js`) && !files.has(`${resolved}.json`)) fail('DEPENDENCY_NOT_PACKAGED', 'A source dependency is not present in the package allowlist.')
      }
    }
    if (relative.endsWith('.wxss') || relative.endsWith('.wxml')) {
      const references = relative.endsWith('.wxss') ? /@import\s+['"]([^'"]+)['"]/g : /<(?:import|include)\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/g
      for (const match of text.matchAll(references)) {
        const reference = match[1]
        if (/[\\:{}%]/.test(reference)) fail('DEPENDENCY_NOT_PACKAGED', 'Only literal whitelisted style/template dependencies are accepted.')
        const resolved = reference.startsWith('/') ? reference.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference))
        if (!files.has(resolved)) fail('DEPENDENCY_NOT_PACKAGED', 'A style/template dependency is not present in the package allowlist.')
      }
    }
    if (relative.endsWith('.json') && !['app.json', 'sitemap.json', 'project.config.json'].includes(relative)) {
      const configuration = parseJson(buffer)
      if (!plainObject(configuration)) fail('PAGE_CONFIG_INVALID', 'Page/component configuration must be an object.')
      for (const key of ['permission', 'requiredPrivateInfos', 'plugins', 'workers', 'subPackages', 'subpackages', 'debug', 'appid', 'extAppid', 'setting']) {
        if (Object.hasOwn(configuration, key)) fail('PROHIBITED_CONFIG', 'A prohibited page/component configuration field was found.')
      }
      if (configuration.usingComponents !== undefined) {
        if (!plainObject(configuration.usingComponents)) fail('DEPENDENCY_NOT_PACKAGED', 'usingComponents must be an object of local component paths.')
        for (const reference of Object.values(configuration.usingComponents)) {
          if (typeof reference !== 'string' || reference.includes('\\') || reference.includes(':')) fail('DEPENDENCY_NOT_PACKAGED', 'Only whitelisted local components are accepted.')
          const resolved = reference.startsWith('/') ? reference.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference))
          if (!resolved.startsWith('components/') || SOURCE_EXTENSIONS.some((extension) => !files.has(`${resolved}${extension}`))) fail('DEPENDENCY_NOT_PACKAGED', 'A component dependency is not present in the package allowlist.')
        }
      }
    }
  }
}
function prepareSource(rootDir, config) {
  const source = path.join(rootDir, 'miniprogram')
  noSymlinks(source)
  if (!fs.lstatSync(source).isDirectory()) fail('SOURCE_MISSING', 'The miniprogram source directory is required.')
  // Excluded trees and local project configuration are never read.
  const app = generateApp(parseJson(readFile(source, 'app.json')))
  const sitemap = generateSitemap(parseJson(readFile(source, 'sitemap.json')))
  const template = parsePublicModule(readFile(source, 'config/public.js').toString('utf8'))
  if (!['development', 'pilot'].includes(template.mode)) fail('PUBLIC_MODULE_INVALID', 'Source public.js has an unsupported mode.')
  const files = new Map()
  for (const relative of SOURCE_FILES) files.set(relative, readFile(source, relative))
  files.set('app.json', jsonBuffer(app))
  files.set('sitemap.json', jsonBuffer(sitemap))
  // The source template is checked but never copied into the candidate.
  files.set('config/public.js', config ? publicBuffer(config) : publicBuffer({ mode: 'pilot', apiBaseUrl: '', operator: '', contact: '', privacyVersion: '' }))
  if (config) files.set('project.config.json', jsonBuffer(generatedProject(config)))
  for (const [relative, buffer] of [...files]) {
    inspectSecrets(relative, buffer)
    if (SOURCE_EXTENSIONS.includes(path.posix.extname(relative))) {
      for (const asset of assetReferences(relative, buffer.toString('utf8'))) {
        if (!files.has(asset)) files.set(asset, readFile(source, asset))
      }
    }
  }
  for (const [relative, buffer] of files) inspectSecrets(relative, buffer)
  verifyDependencies(files)
  return files
}
function report(command, blockers, sourceChecked) {
  return {
    command, ok: blockers.length === 0, status: blockers.length ? 'blocked' : 'static-checks-passed',
    checks: { publicConfiguration: blockers.some((item) => /REQUIRED|PUBLIC_FIELDS/.test(item.code)) ? 'blocked' : 'checked', source: sourceChecked ? 'checked' : 'blocked' },
    blockers, unverified: [...UNVERIFIED]
  }
}
function assess(options, command) {
  const rootDir = safeAbsolute(options.rootDir || DEFAULT_ROOT)
  const { blockers, config } = validatePublicConfig(options.config)
  let files = null
  try { files = prepareSource(rootDir, config) } catch (error) { blockers.push(issue(error)) }
  return { rootDir, config, files, result: report(command, blockers, files !== null) }
}
export function checkRelease(options = {}) { return assess(options, 'check').result }

function walkOutput(root, relative = '') {
  const files = new Map()
  noSymlinks(path.join(root, relative))
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) fail('SYMLINK_REFUSED', 'Symbolic links and directory junctions are not accepted.')
    if (name.split('/').some((part) => SECRET_NAME.test(part) || ['node_modules', 'tests', 'dist', 'build', 'coverage', 'drawing-prototype'].includes(part) || part.startsWith('.'))) fail('PROHIBITED_FILENAME', 'The candidate contains an excluded development/private/generated path.')
    if (entry.isDirectory()) {
      if (!['assets', 'components', 'components/drawing-board', 'config', 'utils', 'pages', ...PAGE_NAMES.map((page) => `pages/${page}`)].includes(name) && !name.startsWith('assets/')) fail('OUTPUT_ALLOWLIST', 'The candidate contains a directory outside the allowlist.')
      for (const [child, buffer] of walkOutput(root, name)) files.set(child, buffer)
    } else {
      if (![...SOURCE_FILES, ...GENERATED_FILES].includes(name) && !(name.startsWith('assets/') && ASSET_EXTENSIONS.includes(path.posix.extname(name)))) fail('OUTPUT_ALLOWLIST', 'The candidate contains a file outside the allowlist.')
      files.set(name, readFile(root, name))
    }
  }
  return files
}
export function validatePackage(outputDir, input) {
  const { blockers, config } = validatePublicConfig(input)
  if (blockers.length) fail('OUTPUT_CONFIG_INVALID', 'Candidate validation requires complete public configuration.')
  const files = walkOutput(safeAbsolute(outputDir))
  for (const relative of [...SOURCE_FILES, ...GENERATED_FILES]) if (!files.has(relative)) fail('OUTPUT_INCOMPLETE', 'The candidate is missing a required file.')
  for (const [relative, buffer] of files) inspectSecrets(relative, buffer)
  const app = parseJson(files.get('app.json'))
  generateApp(app)
  if (app.pages.includes(PROTOTYPE)) fail('PROTOTYPE_INCLUDED', 'The candidate must not declare the drawing prototype.')
  generateSitemap(parseJson(files.get('sitemap.json')))
  if (parseJson(files.get('sitemap.json')).rules.some((rule) => rule.page === PROTOTYPE)) fail('PROTOTYPE_INCLUDED', 'The candidate sitemap must not include the drawing prototype.')
  const actualPublic = parsePublicModule(files.get('config/public.js').toString('utf8'))
  if (PUBLIC_KEYS.some((key) => actualPublic[key] !== config[key])) fail('OUTPUT_CONFIG_MISMATCH', 'Generated public configuration does not match the validated pilot inputs.')
  const project = parseJson(files.get('project.config.json'))
  const expected = generatedProject(config)
  onlyKeys(project, Object.keys(expected), 'PROHIBITED_PROJECT_CONFIG')
  onlyKeys(project.setting, Object.keys(expected.setting), 'PROHIBITED_PROJECT_CONFIG')
  if (Object.keys(expected).some((key) => key !== 'setting' && project[key] !== expected[key]) || Object.keys(expected.setting).some((key) => project.setting[key] !== expected.setting[key])) fail('PROHIBITED_PROJECT_CONFIG', 'Project settings must match the generated nonprivate configuration, with urlCheck enabled.')
  const referencedAssets = new Set()
  for (const [relative, buffer] of files) if (SOURCE_EXTENSIONS.includes(path.posix.extname(relative))) for (const asset of assetReferences(relative, buffer.toString('utf8'))) referencedAssets.add(asset)
  if ([...referencedAssets].some((asset) => !files.has(asset)) || [...files.keys()].some((name) => name.startsWith('assets/') && !referencedAssets.has(name))) fail('OUTPUT_ASSETS', 'Assets must be referenced by packaged source and present in the candidate.')
  verifyDependencies(files)
  return { files: files.size }
}

export function packageMiniprogram(options = {}) {
  const state = assess(options, 'package-miniprogram')
  if (options.confirmAppidAuthorized !== true) state.result.blockers.push({ code: 'APPID_AUTHORIZATION_CONFIRMATION_REQUIRED', message: 'Packaging requires explicit --confirm-appid-authorized operator confirmation. The tool does not verify ownership.' })
  const name = options.name || new Date().toISOString().replace(/[-:.]/g, '')
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) state.result.blockers.push({ code: 'OUTPUT_NAME_INVALID', message: 'Use a candidate name of 1–64 ASCII letters, digits, underscores or hyphens, beginning with a letter or digit.' })
  if (state.result.blockers.length) return { ...state.result, ok: false, status: 'blocked' }
  const destination = path.join(state.rootDir, 'dist', `pilot-miniprogram-${name}`)
  let created = false
  try {
    noSymlinks(destination, true)
    fs.mkdirSync(path.join(state.rootDir, 'dist'), { recursive: true })
    // Exclusive directory creation: never overwrite/reuse an earlier candidate.
    try { fs.mkdirSync(destination) } catch (error) {
      if (error.code === 'EEXIST') fail('OUTPUT_EXISTS', 'The candidate destination already exists; choose a new name. Nothing was overwritten.')
      throw error
    }
    created = true
    for (const [relative, buffer] of state.files) {
      const target = path.join(destination, relative)
      noSymlinks(target, true)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer, { flag: 'wx' })
    }
    const validation = validatePackage(destination, state.config)
    return { ...state.result, status: 'candidate-created', output: path.relative(state.rootDir, destination).split(path.sep).join('/'), fileCount: validation.files }
  } catch (error) {
    return { ...state.result, ok: false, status: 'blocked', blockers: [issue(error)], ...(created ? { incompleteCandidate: true, note: 'A newly created incomplete candidate was left in place. It must not be uploaded; choose a new destination on retry.' } : {}) }
  }
}

export function loadPublicConfig(filename) {
  const absolute = safeAbsolute(filename)
  if (path.extname(absolute).toLowerCase() !== '.json' || SECRET_NAME.test(path.basename(absolute))) fail('PUBLIC_CONFIG_FILE_ONLY', 'Use an explicitly supplied public JSON config file, never an environment/private/credential file.')
  noSymlinks(absolute)
  const value = parseJson(readFile(path.dirname(absolute), path.basename(absolute)))
  onlyKeys(value, INPUT_KEYS, 'PUBLIC_FIELDS_ONLY')
  return value
}
const HELP = `Usage (Node 22+, no dependencies or network calls):
  node scripts/pilot-release.mjs check [public options]
  node scripts/pilot-release.mjs package-miniprogram --name <new-name> --confirm-appid-authorized [public options]

Public options:
  --config <public.json>       Explicit JSON with apiBaseUrl, operator, contact,
                              privacyVersion, appid; optional mode must be pilot.
  --api-base-url <origin>      HTTPS public origin, without /api paths
  --operator <text> --contact <text> --privacy-version <text> --appid <wx...>
  --root <repository>          Defaults to this script's repository

CLI public fields override the JSON public fields. No environment/.env or source
project AppID is read. Omitted configuration produces blockers and exit code 1.
Output is always a NEW dist/pilot-miniprogram-<name> directory (dist/ is ignored by
this repository). No source files, AppIDs or private configuration are modified.
No upload, DNS/TLS/API check, authorization verification or compliance approval.
`
export function runCli(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { process.stdout.write(HELP); return 0 }
  try {
    const [command, ...args] = argv
    if (!['check', 'package-miniprogram'].includes(command)) fail('COMMAND_REQUIRED', 'Choose check or package-miniprogram; use --help for usage.')
    const fields = { '--api-base-url': 'apiBaseUrl', '--operator': 'operator', '--contact': 'contact', '--privacy-version': 'privacyVersion', '--appid': 'appid' }
    const options = {}, overrides = {}, seen = new Set()
    let configFile
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]
      if (seen.has(flag)) fail('CLI_OPTION_INVALID', 'Duplicate command options are not accepted.')
      seen.add(flag)
      if (flag === '--confirm-appid-authorized') { options.confirmAppidAuthorized = true; continue }
      if (![...Object.keys(fields), '--config', '--root', '--name'].includes(flag)) fail('CLI_OPTION_INVALID', 'Unknown command option; only documented public options are accepted.')
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) fail('CLI_OPTION_INVALID', 'A command option is missing its value.')
      if (fields[flag]) overrides[fields[flag]] = value
      else if (flag === '--config') configFile = value
      else if (flag === '--root') options.rootDir = value
      else options.name = value
    }
    if (command === 'check' && (options.name !== undefined || options.confirmAppidAuthorized !== undefined)) fail('CLI_OPTION_INVALID', 'Candidate name and authorization confirmation are packaging-only options.')
    options.config = { ...(configFile ? loadPublicConfig(configFile) : {}), ...overrides }
    const result = command === 'check' ? checkRelease(options) : packageMiniprogram(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'blocked', blockers: [issue(error)], unverified: UNVERIFIED }, null, 2)}\n`)
    return 1
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli()
