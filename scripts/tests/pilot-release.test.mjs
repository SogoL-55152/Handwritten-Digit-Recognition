import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkRelease, packageMiniprogram, parsePublicModule, validatePublicConfig, validatePackage, loadPublicConfig } from '../pilot-release.mjs'

const SCRIPT = fileURLToPath(new URL('../pilot-release.mjs', import.meta.url))
// Entirely synthetic values: no real AppID, user config, app source or network is used.
const CONFIG = Object.freeze({ apiBaseUrl: 'https://digits.pilot-team.cn', operator: '数字试用维护组', contact: 'support@pilot-team.cn', privacyVersion: '2026-11-04-v1', appid: 'wx1234567890abcdef' })
const PAGES = ['login', 'register', 'index', 'account', 'help', 'privacy'].map((name) => `pages/${name}/${name}`)
const EXTENSIONS = ['.js', '.json', '.wxml', '.wxss']
const PROTOTYPE = 'pages/drawing-prototype/drawing-prototype'
const SECRET = 'synthetic-do-not-print-credential'

function write(root, relative, content) {
  const filename = path.join(root, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
}
function readJson(root, relative) { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-pilot-release-test-'))
  // Cleanup is strictly limited to the directory created and owned by this test.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'miniprogram')
  fs.mkdirSync(source)
  write(root, '.gitignore', 'dist/\n')
  write(source, 'app.json', JSON.stringify({ pages: PAGES, window: { navigationBarTitleText: 'Digits', navigationBarTextStyle: 'white' }, style: 'v2', sitemapLocation: 'sitemap.json' }))
  write(source, 'app.js', "const session = require('./utils/session')\nApp({ globalData: { token: '' } })\n")
  write(source, 'app.wxss', 'page { background: white; }\n')
  write(source, 'sitemap.json', JSON.stringify({ desc: 'Synthetic sitemap', rules: [{ action: 'allow', page: '*' }] }))
  write(source, 'config/public.js', "// Public template: never execute it.\nmodule.exports = {\n mode: 'development', apiBaseUrl: 'http://127.0.0.1:8080',\n operator: '', contact: '', privacyVersion: '',\n}\n")
  write(source, 'config/runtime.js', "const config = require('./public')\nmodule.exports = { config }\n")
  for (const name of ['session', 'request', 'recognition', 'credentials', 'image-import']) write(source, `utils/${name}.js`, 'module.exports = {}\n')
  write(source, 'utils/request.js', 'function headers(saved) { return { Authorization: `Bearer ${saved.token}` } }\nmodule.exports = { headers }\n')
  for (const page of PAGES) {
    for (const extension of EXTENSIONS) {
      write(source, page + extension, extension === '.json' ? '{}' : extension === '.js' ? "Page({ data: { password: '', pilotCode: '' } })\n" : extension === '.wxml' ? '<view>Test</view>\n' : 'view { color: black; }\n')
    }
  }
  for (const extension of EXTENSIONS) write(source, `components/drawing-board/drawing-board${extension}`, extension === '.json' ? '{"component":true}' : extension === '.js' ? 'Component({})\n' : '')
  write(source, 'pages/index/index.json', '{"usingComponents":{"drawing-board":"../../components/drawing-board/drawing-board"}}')
  write(source, 'pages/help/help.wxss', '@import "../index/index.wxss";\n')
  write(source, 'pages/register/register.wxss', '@import "../login/login.wxss";\n')
  // These must never be read/imported/copied by the release tool.
  write(source, 'project.config.json', `not even JSON: ${SECRET}`)
  write(source, 'project.private.config.json', SECRET)
  write(source, '.env', SECRET)
  write(source, '.env.pilot', SECRET)
  write(source, 'tests/secret.test.js', SECRET)
  write(source, 'node_modules/trap/index.js', SECRET)
  write(source, 'utils/debug.js', SECRET)
  write(source, 'config/local.js', SECRET)
  write(source, 'config/credentials.json', SECRET)
  write(source, 'assets/unreferenced.png', SECRET)
  write(source, 'dist/old.js', SECRET)
  write(source, 'pages/index/index.js.map', SECRET)
  write(source, 'README.md', SECRET)
  return { root, source, options: { rootDir: root, config: { ...CONFIG }, confirmAppidAuthorized: true, name: 'synthetic' } }
}
function candidate(t) {
  const f = fixture(t)
  const result = packageMiniprogram(f.options)
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  return { ...f, output: path.join(f.root, result.output), result }
}
function cli(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8', cwd: root, env: { ...process.env, ...extraEnv } })
}
function codes(result) { return result.blockers.map((item) => item.code) }
function listFiles(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(root, relative) : [relative]
  }).sort()
}
function snapshot(root) { return new Map(listFiles(root).map((name) => [name, fs.readFileSync(path.join(root, name)).toString('base64')])) }
function expectCode(callback, code) { assert.throws(callback, (error) => error.code === code && !error.message.includes(SECRET)) }

// Pure validation does not resolve DNS; the host is only a syntactic fixture.
test('public configuration accepts only a public HTTPS origin and explicit public fields', () => {
  const result = validatePublicConfig({ ...CONFIG, apiBaseUrl: 'https://DIGITS.pilot-team.cn:443/', mode: 'pilot' })
  assert.deepEqual(result.blockers, [])
  assert.equal(result.config.apiBaseUrl, CONFIG.apiBaseUrl)
  assert.equal(result.config.mode, 'pilot')
})
for (const value of [undefined, '', 'http://digits.pilot-team.cn', 'https://localhost', 'https://api.localhost', 'https://api.local', 'https://api.internal', 'https://api.lan', 'https://api.home.arpa', 'https://api.corp', 'https://127.0.0.1', 'https://10.0.0.2', 'https://192.168.1.2', 'https://172.16.0.1', 'https://8.8.8.8', 'https://[::1]', 'https://[2606:4700::1111]', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1', 'https://example.com', 'https://api.example.org', 'https://your-domain.cn', 'https://placeholder.cn', 'https://todo.cn', 'https://api.invalid', 'https://digits.pilot-team.cn/api', 'https://digits.pilot-team.cn?token=hidden', 'https://digits.pilot-team.cn#hash', 'https://user:password@digits.pilot-team.cn', ' https://digits.pilot-team.cn', 'https://digits.pilot-team.cn.', 'https://bad_label.cn', 'https://bad..cn', 'https://digits.pilot-team.cn:0', 'https://digits.pilot-team.cn:65536', 'https://digits.pilot-team.cn\\@evil.cn']) {
  test(`reject nonpublic or malformed origin ${String(value).split(/[?#]/)[0]}`, () => {
    assert.ok(codes(validatePublicConfig({ ...CONFIG, apiBaseUrl: value })).includes('API_ORIGIN_REQUIRED'))
  })
}
for (const key of ['operator', 'contact', 'privacyVersion']) {
  test(`${key} requires an explicit nonplaceholder value`, () => {
    for (const value of [undefined, '', ' ', 'TODO', 'TBD', '未配置', '待填写', 'example', '${VALUE}', '<fill-me>', 'n/a', 'value\nsecret', ' value ']) {
      assert.ok(validatePublicConfig({ ...CONFIG, [key]: value }).blockers.length, `${key}: ${value}`)
    }
  })
}
test('placeholder contact domains and AppIDs do not pass', () => {
  assert.ok(validatePublicConfig({ ...CONFIG, contact: 'support@example.com' }).blockers.length)
  for (const appid of ['', 'touristappid', 'wxYOURAPPID', 'WX1234567890abcdef', 'wx1234567890ABCDEF', 'wx1234567890abcde', 'wx1234567890abcdef0', 'wx0000000000000000', 'wx1111111111111111']) assert.ok(codes(validatePublicConfig({ ...CONFIG, appid })).includes('APPID_REQUIRED'))
})
test('unknown/sensitive fields and development mode block rather than silently pass', () => {
  for (const extra of [{ pilotCode: SECRET }, { token: SECRET }, { appSecret: SECRET }, { confirmAppidAuthorized: true }, { unexpected: SECRET }]) {
    const result = validatePublicConfig({ ...CONFIG, ...extra })
    assert.deepEqual(codes(result), ['PUBLIC_FIELDS_ONLY'])
    assert.ok(!JSON.stringify(result).includes(SECRET))
  }
  assert.ok(codes(validatePublicConfig({ ...CONFIG, mode: 'development' })).includes('PILOT_MODE_REQUIRED'))
})
test('public module parser accepts only literal public fields without executing code', () => {
  const text = `/* comment */ module /* middle */ . exports = {mode:'development',apiBaseUrl:'http://127.0.0.1:8080',operator:'A\\\'B',contact:'',privacyVersion:'\\u0031',}; // end`
  const parsed = parsePublicModule(text)
  assert.equal(parsed.operator, "A'B")
  assert.equal(parsed.privacyVersion, '1')
  for (const malicious of [
    `${text}\nprocess.exit(0)`,
    "module.exports = require('./credentials')",
    "module.exports = {mode: (() => 'pilot')()}",
    "module.exports = {mode:'pilot',pilotCode:'hidden'}",
    "module.exports = {...require('./public')}",
    "module.exports = {mode:'pilot',mode:'development'}",
    "module.exports = {mode:`pilot`}",
    "module.exports = {['mode']:'pilot'}"
  ]) expectCode(() => parsePublicModule(malicious), 'PUBLIC_MODULE_INVALID')
})
test('check with no external config lists all blockers and creates no output', (t) => {
  const f = fixture(t)
  const before = snapshot(f.root)
  const result = checkRelease({ rootDir: f.root })
  assert.equal(result.ok, false)
  assert.equal(result.checks.source, 'checked')
  assert.deepEqual(codes(result), ['API_ORIGIN_REQUIRED', 'OPERATOR_REQUIRED', 'CONTACT_REQUIRED', 'PRIVACY_VERSION_REQUIRED', 'APPID_REQUIRED'])
  assert.deepEqual(snapshot(f.root), before)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})
test('complete config passes static check, not deployment/ownership/compliance verification', (t) => {
  const f = fixture(t)
  const result = checkRelease(f.options)
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.equal(result.status, 'static-checks-passed')
  assert.ok(result.unverified.some((item) => item.includes('no network calls')))
  assert.ok(result.unverified.some((item) => item.includes('not prove ownership')))
  assert.ok(result.unverified.some((item) => item.includes('compliance')))
  assert.equal(fs.existsSync(path.join(f.root, 'dist')), false)
})
test('packaging requires explicit boolean authorization confirmation', (t) => {
  const f = fixture(t)
  for (const confirmation of [undefined, false, 'true', 1]) {
    const result = packageMiniprogram({ ...f.options, confirmAppidAuthorized: confirmation })
    assert.equal(result.ok, false)
    assert.ok(codes(result).includes('APPID_AUTHORIZATION_CONFIRMATION_REQUIRED'))
  }
  assert.equal(fs.existsSync(path.join(f.root, 'dist')), false)
})
test('package is a new allowlisted source-only candidate; source AppID/private data untouched', (t) => {
  const f = fixture(t)
  const before = snapshot(f.source)
  const result = packageMiniprogram(f.options)
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.equal(result.status, 'candidate-created')
  assert.equal(result.output, 'dist/pilot-miniprogram-synthetic')
  const output = path.join(f.root, result.output)
  assert.deepEqual(snapshot(f.source), before)
  const files = listFiles(output)
  assert.equal(files.length, result.fileCount)
  assert.equal(files.length, 40)
  assert.equal(files.some((name) => /prototype|private|tests|node_modules|debug|local|\.env|README|\.map/.test(name)), false)
  for (const name of files) assert.ok(!fs.readFileSync(path.join(output, name)).includes(SECRET))
  assert.deepEqual(readJson(output, 'app.json').pages, PAGES)
  assert.deepEqual(readJson(output, 'sitemap.json').rules, [{ action: 'allow', page: '*' }])
  const project = readJson(output, 'project.config.json')
  assert.equal(project.appid, CONFIG.appid)
  assert.equal(project.miniprogramRoot, './')
  assert.equal(project.compileType, 'miniprogram')
  assert.equal(project.setting.urlCheck, true)
  assert.equal(Object.hasOwn(project, 'private'), false)
  const { appid, ...publicFields } = { ...CONFIG, mode: 'pilot' }
  assert.deepEqual(parsePublicModule(fs.readFileSync(path.join(output, 'config/public.js'), 'utf8')), publicFields)
  assert.deepEqual(validatePackage(output, CONFIG), { files: files.length })
})
test('public string generation uses escaped JSON literals, not interpolation into code', (t) => {
  const f = fixture(t)
  const operator = '维护组 "甲" \\ B; globalThis.malicious = true'
  const result = packageMiniprogram({ ...f.options, config: { ...CONFIG, operator } })
  assert.equal(result.ok, true)
  const config = parsePublicModule(fs.readFileSync(path.join(f.root, result.output, 'config/public.js'), 'utf8'))
  assert.equal(config.operator, operator)
  assert.equal(globalThis.malicious, undefined)
})
test('existing destination is refused without changes or cleanup', (t) => {
  const f = candidate(t)
  write(f.output, 'keep.txt', SECRET)
  const before = snapshot(f.output)
  const result = packageMiniprogram(f.options)
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['OUTPUT_EXISTS'])
  assert.deepEqual(snapshot(f.output), before)
})
test('even an empty destination or existing file cannot be reused', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'dist/pilot-miniprogram-empty'), { recursive: true })
  write(f.root, 'dist/pilot-miniprogram-file', 'keep')
  for (const name of ['empty', 'file']) assert.deepEqual(codes(packageMiniprogram({ ...f.options, name })), ['OUTPUT_EXISTS'])
})
test('destination names cannot traverse, escape dist or inject separators', (t) => {
  const f = fixture(t)
  for (const name of ['..', '../escape', '..\\escape', '/absolute', 'C:\\escape', 'a/b', 'a\\b', '.hidden', 'bad name', 'x'.repeat(65)]) {
    assert.ok(codes(packageMiniprogram({ ...f.options, name })).includes('OUTPUT_NAME_INVALID'))
  }
  assert.equal(fs.existsSync(path.join(f.root, 'dist')), false)
  expectCode(() => checkRelease({ rootDir: `${f.root}/../other`, config: CONFIG }), 'UNSAFE_PATH')
})
test('all required pilot pages and their source quartets must exist', (t) => {
  const f = fixture(t)
  const app = readJson(f.source, 'app.json')
  write(f.source, 'app.json', JSON.stringify({ ...app, pages: app.pages.filter((page) => !page.includes('privacy')) }))
  assert.ok(codes(checkRelease(f.options)).includes('PAGE_MANIFEST_INVALID'))
  write(f.source, 'app.json', JSON.stringify(app))
  fs.unlinkSync(path.join(f.source, 'pages/account/account.wxml'))
  assert.equal(checkRelease(f.options).ok, false)
  assert.equal(packageMiniprogram(f.options).ok, false)
  assert.equal(fs.existsSync(path.join(f.root, 'dist')), false)
})
for (const mutation of [
  { pages: [...PAGES, '../escape'] }, { pages: [...PAGES, 'pages/unknown/unknown'] },
  { pages: [...PAGES, PAGES[0]] }, { debug: true }, { permission: {} }, { requiredPrivateInfos: ['getLocation'] },
  { plugins: {} }, { subPackages: [] }, { sitemapLocation: '../outside.json' }, { workers: 'workers' }
]) {
  test(`source app rejects unsupported config ${Object.keys(mutation)[0]} ${JSON.stringify(mutation).slice(0, 60)}`, (t) => {
    const f = fixture(t)
    write(f.source, 'app.json', JSON.stringify({ ...readJson(f.source, 'app.json'), ...mutation }))
    assert.equal(checkRelease(f.options).ok, false)
  })
}
test('source config cannot execute or carry extra secret fields', (t) => {
  const f = fixture(t)
  for (const text of ["throw new Error('should never execute')", `module.exports = {mode:'development', pilotCode:'${SECRET}'}`]) {
    write(f.source, 'config/public.js', text)
    const result = checkRelease(f.options)
    assert.ok(codes(result).includes('PUBLIC_MODULE_INVALID'))
    assert.ok(!JSON.stringify(result).includes(SECRET))
  }
})
for (const content of [
  `const PILOT_REGISTRATION_CODE = '${SECRET}'`, `const pilotCode = '${SECRET}'`,
  `const token = '${SECRET}'`, `const appSecret = '${SECRET}'`, `Page({ data: { password: '${SECRET}' } })`,
  `const header = { Authorization: 'Bearer ${SECRET}' }`,
  'const key = "-----BEGIN PRIVATE KEY-----"',
  'const value = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature12345"'
]) {
  test(`known credential literal blocked without printing it (${content.split('=')[0].slice(0, 30)})`, (t) => {
    const f = fixture(t)
    write(f.source, 'utils/request.js', content)
    const result = checkRelease(f.options)
    assert.ok(codes(result).includes('SECRET_LITERAL'), JSON.stringify(result))
    assert.ok(!JSON.stringify(result).includes(SECRET))
  })
}
test('legitimate empty UI fields and runtime-derived authorization remain allowed', (t) => {
  const f = fixture(t)
  write(f.source, 'utils/request.js', "const token = ''; const pilotCode = ''; const password = ''; function auth(saved) { return { Authorization: `Bearer ${saved.token}` } }\n")
  assert.equal(checkRelease(f.options).ok, true)
})
test('local module, component, template and stylesheet references must be packaged', (t) => {
  const f = fixture(t)
  for (const reference of ["require('./debug')", "require('../project.private.config.json')", "require('../../outside')", "require('external-dependency')", "require('../pages/drawing-prototype/drawing-prototype')"]) {
    write(f.source, 'utils/recognition.js', reference)
    assert.ok(codes(checkRelease(f.options)).includes('DEPENDENCY_NOT_PACKAGED'))
  }
  write(f.source, 'utils/recognition.js', 'module.exports = {}')
  write(f.source, 'pages/help/help.wxss', '@import "../../outside.wxss";')
  assert.ok(codes(checkRelease(f.options)).includes('DEPENDENCY_NOT_PACKAGED'))
  write(f.source, 'pages/help/help.wxss', '@import "../index/index.wxss";')
  write(f.source, 'pages/help/help.wxml', '<include src="../../outside.wxml"/>')
  assert.ok(codes(checkRelease(f.options)).includes('DEPENDENCY_NOT_PACKAGED'))
  write(f.source, 'pages/help/help.wxml', '<view>ok</view>')
  write(f.source, 'pages/index/index.json', '{"usingComponents":{"unsafe":"../../outside/component"}}')
  assert.ok(codes(checkRelease(f.options)).includes('DEPENDENCY_NOT_PACKAGED'))
})
test('only explicitly referenced approved assets are copied', (t) => {
  const f = fixture(t)
  const icon = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  write(f.source, 'assets/icons/digit.png', icon)
  write(f.source, 'assets/background.webp', Buffer.from([82, 73, 70, 70]))
  write(f.source, 'pages/index/index.wxml', '<image src="/assets/icons/digit.png"/>')
  write(f.source, 'pages/index/index.wxss', 'view { background-image: url(../../assets/background.webp); }')
  const result = packageMiniprogram(f.options)
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  const output = path.join(f.root, result.output)
  assert.deepEqual(fs.readFileSync(path.join(output, 'assets/icons/digit.png')), icon)
  assert.equal(fs.existsSync(path.join(output, 'assets/background.webp')), true)
  assert.equal(fs.existsSync(path.join(output, 'assets/unreferenced.png')), false)
  assert.equal(validatePackage(output, CONFIG).files, 42)
})
for (const asset of ['/assets/../project.private.config.json', '/assets/icon.js', '/assets/token.png', '/assets/%2e%2e/picture.png', '/assets/{{name}}.png', 'https://digits.pilot-team.cn/assets/icon.png', '/assets/missing.png']) {
  test(`unsafe, secret-named or missing asset blocks ${asset}`, (t) => {
    const f = fixture(t)
    write(f.source, 'pages/index/index.wxml', `<image src="${asset}"/>`)
    write(f.source, 'assets/token.png', SECRET)
    assert.equal(packageMiniprogram(f.options).ok, false)
    assert.equal(fs.existsSync(path.join(f.root, 'dist')), false)
  })
}
test('symlinked source directories and destination ancestors are refused without following them', (t) => {
  const f = fixture(t)
  const outside = path.join(f.root, 'owned-link-target')
  fs.mkdirSync(outside)
  write(outside, 'keep.txt', SECRET)
  const originalUtils = path.join(f.source, 'utils-original')
  fs.renameSync(path.join(f.source, 'utils'), originalUtils)
  fs.symlinkSync(originalUtils, path.join(f.source, 'utils'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(codes(checkRelease(f.options)).includes('SYMLINK_REFUSED'))
  fs.unlinkSync(path.join(f.source, 'utils'))
  fs.renameSync(originalUtils, path.join(f.source, 'utils'))
  fs.symlinkSync(outside, path.join(f.root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(codes(packageMiniprogram(f.options)).includes('SYMLINK_REFUSED'))
  assert.deepEqual(listFiles(outside), ['keep.txt'])
})
test('symlink at the candidate destination is refused, even if dangling', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'dist'))
  fs.symlinkSync(path.join(f.root, 'absent-owned-target'), path.join(f.root, 'dist/pilot-miniprogram-synthetic'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(codes(packageMiniprogram(f.options)).includes('SYMLINK_REFUSED'))
})
for (const [name, mutate, code] of [
  ['prototype route', (f) => write(f.output, 'app.json', JSON.stringify({ ...readJson(f.output, 'app.json'), pages: [...PAGES, PROTOTYPE] })), 'PROTOTYPE_INCLUDED'],
  ['development public config', (f) => write(f.output, 'config/public.js', fs.readFileSync(path.join(f.source, 'config/public.js'))), 'OUTPUT_CONFIG_MISMATCH'],
  ['extra public token', (f) => write(f.output, 'config/public.js', `module.exports = {mode:'pilot',token:'${SECRET}'}`), 'SECRET_LITERAL'],
  ['urlCheck disabled', (f) => { const p = readJson(f.output, 'project.config.json'); p.setting.urlCheck = false; write(f.output, 'project.config.json', JSON.stringify(p)) }, 'PROHIBITED_PROJECT_CONFIG'],
  ['project private override', (f) => { const p = readJson(f.output, 'project.config.json'); p.setting.ignoreDevUnusedFiles = true; write(f.output, 'project.config.json', JSON.stringify(p)) }, 'PROHIBITED_PROJECT_CONFIG'],
  ['wrong AppID', (f) => { const p = readJson(f.output, 'project.config.json'); p.appid = 'wxabcdef1234567890'; write(f.output, 'project.config.json', JSON.stringify(p)) }, 'PROHIBITED_PROJECT_CONFIG'],
  ['root escape', (f) => { const p = readJson(f.output, 'project.config.json'); p.miniprogramRoot = '../'; write(f.output, 'project.config.json', JSON.stringify(p)) }, 'PROHIBITED_PROJECT_CONFIG'],
  ['missing source', (f) => fs.unlinkSync(path.join(f.output, 'app.js')), 'OUTPUT_INCOMPLETE'],
  ['private config', (f) => write(f.output, 'project.private.config.json', SECRET), 'PROHIBITED_FILENAME'],
  ['env', (f) => write(f.output, '.env', SECRET), 'PROHIBITED_FILENAME'],
  ['test files', (f) => write(f.output, 'tests/test.js', SECRET), 'PROHIBITED_FILENAME'],
  ['node dependencies', (f) => write(f.output, 'node_modules/library.js', SECRET), 'PROHIBITED_FILENAME'],
  ['unknown source', (f) => write(f.output, 'utils/extra.js', SECRET), 'OUTPUT_ALLOWLIST'],
  ['unreferenced asset', (f) => write(f.output, 'assets/extra.png', 'synthetic'), 'OUTPUT_ASSETS'],
  ['page permission', (f) => write(f.output, 'pages/help/help.json', '{"permission":{}}'), 'PROHIBITED_CONFIG'],
  ['JSON credential key', (f) => write(f.output, 'pages/help/help.json', '{"token":null}'), 'PROHIBITED_JSON_FIELD'],
  ['JS credential', (f) => write(f.output, 'app.js', `const token = '${SECRET}'`), 'SECRET_LITERAL']
]) {
  test(`output validation detects tampering: ${name}`, (t) => {
    const f = candidate(t)
    mutate(f)
    expectCode(() => validatePackage(f.output, CONFIG), code)
  })
}
test('output validation refuses symlinks to a test-owned directory', (t) => {
  const f = candidate(t)
  fs.symlinkSync(f.source, path.join(f.output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expectCode(() => validatePackage(f.output, CONFIG), 'SYMLINK_REFUSED')
})
test('explicit JSON loader permits only public JSON, not env/private credential files', (t) => {
  const f = fixture(t)
  write(f.root, 'public-input.json', JSON.stringify(CONFIG))
  assert.deepEqual(loadPublicConfig(path.join(f.root, 'public-input.json')), CONFIG)
  for (const name of ['.env', '.env.json', 'credentials.json', 'project.private.config.json', 'secrets.json', 'local.json', 'token.json']) {
    write(f.root, name, JSON.stringify(CONFIG))
    expectCode(() => loadPublicConfig(path.join(f.root, name)), 'PUBLIC_CONFIG_FILE_ONLY')
  }
  write(f.root, 'public-input.json', JSON.stringify({ ...CONFIG, token: SECRET }))
  expectCode(() => loadPublicConfig(path.join(f.root, 'public-input.json')), 'PUBLIC_FIELDS_ONLY')
  write(f.root, 'public-input.json', `invalid JSON ${SECRET}`)
  expectCode(() => loadPublicConfig(path.join(f.root, 'public-input.json')), 'INVALID_JSON')
})
test('CLI check with no config ignores environment and .env secrets and exits nonzero', (t) => {
  const f = fixture(t)
  write(f.root, '.env', `PILOT_REGISTRATION_CODE=${SECRET}\nAPPID=${CONFIG.appid}\n`)
  const run = cli(f.root, ['check'], { PILOT_REGISTRATION_CODE: SECRET, VITE_PILOT_OPERATOR: CONFIG.operator, API_BASE_URL: CONFIG.apiBaseUrl, APPID: CONFIG.appid })
  assert.equal(run.status, 1, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.blockers.length, 5)
  assert.equal(result.status, 'blocked')
  assert.ok(!run.stdout.includes(SECRET))
  assert.equal(run.stderr, '')
})
test('CLI supports public JSON plus explicit public overrides; package stays local', (t) => {
  const f = fixture(t)
  write(f.root, 'public-input.json', JSON.stringify({ ...CONFIG, apiBaseUrl: 'http://localhost' }))
  const args = ['--config', path.join(f.root, 'public-input.json'), '--api-base-url', CONFIG.apiBaseUrl]
  const checked = cli(f.root, ['check', ...args])
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  const packaged = cli(f.root, ['package-miniprogram', '--name', 'cli', '--confirm-appid-authorized', ...args])
  assert.equal(packaged.status, 0, packaged.stdout + packaged.stderr)
  const result = JSON.parse(packaged.stdout)
  assert.equal(result.output, 'dist/pilot-miniprogram-cli')
  assert.ok(result.unverified.length)
  assert.equal(validatePackage(path.join(f.root, result.output), CONFIG).files, 40)
})
test('CLI accepts all public fields directly and does not print their values', (t) => {
  const f = fixture(t)
  const run = cli(f.root, ['check', '--api-base-url', CONFIG.apiBaseUrl, '--operator', CONFIG.operator, '--contact', CONFIG.contact, '--privacy-version', CONFIG.privacyVersion, '--appid', CONFIG.appid])
  assert.equal(run.status, 0, run.stdout + run.stderr)
  for (const value of Object.values(CONFIG)) assert.equal(run.stdout.includes(value), false)
})
test('CLI errors never echo unknown argument values or malformed JSON contents', (t) => {
  const f = fixture(t)
  write(f.root, 'public-input.json', `{malformed-${SECRET}`)
  for (const args of [['check', '--token', SECRET], ['check', `--${SECRET}`], ['check', '--operator'], ['check', '--appid', 'one', '--appid', 'two'], ['check', '--confirm-appid-authorized'], ['check', '--config', path.join(f.root, 'public-input.json')], ['upload', '--token', SECRET]]) {
    const run = cli(f.root, args)
    assert.equal(run.status, 1)
    assert.equal(run.stdout.includes(SECRET), false)
    assert.equal(run.stderr.includes(SECRET), false)
    assert.equal(JSON.parse(run.stdout).ok, false)
  }
})
test('CLI help explains scope and missing arguments are nonzero', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /No upload/)
  assert.match(help.stdout, /--confirm-appid-authorized/)
  const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stdout).blockers[0].code, 'COMMAND_REQUIRED')
})
