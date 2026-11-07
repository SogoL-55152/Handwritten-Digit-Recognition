const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const root = join(__dirname, '..')
const read = path => readFileSync(join(root, path), 'utf8')

test('app has only account business and support pages, never anonymous drawing', () => {
  const pages = JSON.parse(read('app.json')).pages
  assert.deepEqual(pages, ['pages/login/login', 'pages/index/index', 'pages/register/register', 'pages/account/account', 'pages/help/help', 'pages/privacy/privacy'])
  for (const page of pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(existsSync(join(root, `${page}.${ext}`)))
  assert.ok(existsSync(join(root, 'components/drawing-board/drawing-board.js')))
  assert.equal(existsSync(join(root, 'pages/drawing-prototype/drawing-prototype.js')), false)
})

test('user-facing templates omit development and password implementation explanations', () => {
  for (const page of ['login', 'register', 'account', 'index']) {
    const text = read(`pages/${page}/${page}.wxml`)
    assert.doesNotMatch(text, /免登录|W1|W2|开发模式|原样提交|自动去空白|仅本地校验|本地缓存|请求 ID|预处理|技术详情/)
  }
  assert.match(read('pages/index/index.wxml'), /simple="\{\{true\}\}"/)
})

test('primary buttons explicitly center text and stay within page width', () => {
  for (const [file, selector] of [['pages/login/login.wxss', '.btn'], ['pages/index/index.wxss', '.recognize']]) {
    const rule = read(file).split(`${selector} {`)[1].split('}')[0]
    for (const property of ['width: 100%', 'height: 92rpx', 'min-height: 92rpx', 'display: flex', 'align-items: center', 'justify-content: center', 'line-height: 1.2']) assert.ok(rule.includes(property), property)
  }
})

test('both business headers show authenticated logout in their right-hand slot', () => {
  for (const [page, className] of [['index', 'header'], ['account', 'account-header']]) {
    const template = read(`pages/${page}/${page}.wxml`)
    assert.match(template, new RegExp(`<view class="${className}">[\\s\\S]*?<button wx:if="\\{\\{authorized\\}\\}" class="logout" bindtap="logout">退出</button>`))
    const stylesheet = read(`pages/${page}/${page}.wxss`)
    assert.match(stylesheet, /justify-content: space-between/)
    assert.match(stylesheet, /flex-shrink: 0/)
    assert.equal((template.match(/bindtap="logout"/g) || []).length, 1)
  }
})

test('image controls stay separate from drawing and require explicit recognition', () => {
  const template = read('pages/index/index.wxml')
  for (const id of ['drawing-mode', 'image-mode', 'choose-image', 'remove-image', 'import-preview', 'recognize-input']) {
    assert.match(template, new RegExp(`id="${id}"`))
  }
  assert.match(template, /hidden="\{\{inputKind !== 'drawing'\}\}"/)
  assert.match(template, /bindtap="chooseImage"/)
  assert.match(template, /bindtap="removeImage"/)
  assert.match(template, /!imagePath \|\| imageBusy/)
  assert.match(template, /PNG \/ JPEG/)
  assert.match(template, /5 MiB/)
  assert.match(template, /2048/)
  assert.match(template, /点击“识别图片”才上传/)
  assert.match(read('pages/index/index.wxss'), /\.image-button \{[^}]*justify-content: center[^}]*background: #2f54eb/)
})

test('help and privacy accurately disclose selected-image access without album scanning or camera', () => {
  for (const page of ['help', 'privacy']) {
    const template = read(`pages/${page}/${page}.wxml`)
    assert.match(template, /明确选择/)
    assert.match(template, /不扫描或批量读取相册/)
    assert.match(template, /不使用相机/)
    assert.doesNotMatch(template, /不读取相册|不收集手机号、相册|只提交本次画板/)
  }
  assert.match(read('pages/privacy/privacy.wxml'), /不代替微信平台的正式隐私配置与审核/)
})
