// Local browser-scripted regression, not actual-user or WeChat evidence.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw Error('Use --driver, --url and --output option pairs')
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}

async function main() {
  if (!options.driver || !options.output) throw Error('Explicit existing Playwright driver path and new output directory required')
  const url = new URL(options.url || 'http://127.0.0.1:5173')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only local browser regression is supported')
  const api = 'http://127.0.0.1:8080/api/v2'
  const out = path.resolve(options.output)
  await fs.mkdir(out) // Exclusive directory; no historical report or screenshot overwrite.
  const { chromium } = require(path.resolve(options.driver))
  const browser = await chromium.launch({ executablePath: options.edge || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = [], checks = [], results = [], tokens = []
  let uploads = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/recognitions')) uploads++ })
  const check = name => { checks.push(name); console.log('PASS', name) }
  try {
    await page.goto(new URL('/register', url).href)
    const password = crypto.randomBytes(12).toString('hex')
    await page.locator('input[name=username]').fill('prew3_' + crypto.randomBytes(7).toString('hex'))
    await page.locator('input[name=password]').fill(password)
    await page.getByRole('button', { name: '注册并进入', exact: true }).click()
    await page.waitForURL('**/home')
    await page.getByRole('button', { name: '当前空间', exact: true }).waitFor()
    const token = await page.evaluate(() => localStorage.getItem('hdr_v2_token'))
    tokens.push(token)
    const headers = { Authorization: 'Bearer ' + token }
    const me = (await (await context.request.get(api + '/auth/me', { headers })).json()).data
    const wid = me.defaultWorkspaceId
    check('ordinary registration creates and verifies personal workspace')
    const secondSpace = await context.request.post(api + '/workspaces', { headers, data: { name: 'Pre-W3 isolated second space' } })
    assert.equal(secondSpace.status(), 201)
    const otherWid = (await secondSpace.json()).data.id
    const outsider = await context.request.post(api + '/auth/register', { data: { username: 'outside_' + crypto.randomBytes(7).toString('hex'), password } })
    assert.equal(outsider.status(), 201)
    const outsiderToken = (await outsider.json()).data.token
    tokens.push(outsiderToken)
    assert.equal((await context.request.get(api + `/workspaces/${wid}`, { headers: { Authorization: 'Bearer ' + outsiderToken } })).status(), 404)
    check('second workspace exists and other account cannot access personal space')
    await page.getByRole('link', { name: '手写识别', exact: true }).click()
    const canvas = page.locator('canvas')
    await canvas.waitFor()
    await page.waitForFunction(() => !document.body.innerText.includes('正在向服务器核验'))
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + box.width * .23, box.y + box.height * .23)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * .75, box.y + box.height * .23, { steps: 16 })
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .78, { steps: 20 })
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-testid=recognition-submit]').disabled)
    async function submit(expected) {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/recognitions') && r.request().method() === 'POST'),
        page.getByTestId('recognition-submit').click()
      ])
      const body = await response.json()
      assert.equal(response.status(), expected, body.message)
      return body
    }
    const drawn = (await submit(200)).data
    await page.getByTestId('recognized-digit').waitFor()
    assert.equal(await page.getByTestId('recognized-digit').innerText(), '7')
    results.push({ input: 'browser-scripted drawing', ...drawn })
    const png64 = await canvas.evaluate(c => c.toDataURL('image/png').split(',')[1])
    const jpeg64 = await canvas.evaluate(c => c.toDataURL('image/jpeg', .95).split(',')[1])
    const png = Buffer.from(png64, 'base64')
    await fs.writeFile(path.join(out, 'scripted-seven.png'), png)
    await page.screenshot({ path: path.join(out, 'handwriting.png'), fullPage: true })
    check('actual browser drawing reaches trusted model and renders digit')
    await page.getByTestId('input-image').click()
    for (const [mime, base64] of [['image/png', png64], ['image/jpeg', jpeg64]]) {
      const bytes = Buffer.from(base64, 'base64'), before = uploads
      await page.getByTestId('image-file').setInputFiles({ name: mime === 'image/png' ? 'selected.png' : 'selected.jpeg', mimeType: mime, buffer: bytes })
      await page.getByTestId('image-preview').waitFor()
      await page.waitForFunction(() => !document.querySelector('[data-testid=recognition-submit]').disabled)
      assert.equal(uploads, before)
      const result = (await submit(200)).data
      await page.getByTestId('recognized-digit').waitFor()
      assert.equal(await page.getByTestId('recognized-digit').innerText(), '7')
      results.push({ input: 'browser-scripted import', mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...result })
      const detail = await context.request.get(api + `/workspaces/${wid}/recognitions/${result.recognitionId}`, { headers })
      assert.deepEqual((await detail.json()).data, result)
      assert.equal((await context.request.get(api + `/workspaces/${otherWid}/recognitions/${result.recognitionId}`, { headers })).status(), 404)
      assert.equal((await context.request.get(api + `/workspaces/${wid}/recognitions/${result.recognitionId}`, { headers: { Authorization: 'Bearer ' + outsiderToken } })).status(), 404)
      if (mime === 'image/png') {
        const multipart = { image: { name: 'selected.png', mimeType: mime, buffer: bytes }, source: 'WEB' }
        const replay = await context.request.post(api + `/workspaces/${wid}/recognitions`, { headers: { ...headers, 'Idempotency-Key': result.requestId }, multipart })
        assert.equal(replay.status(), 200)
        assert.deepEqual((await replay.json()).data, result)
        const conflict = await context.request.post(api + `/workspaces/${wid}/recognitions`, { headers: { ...headers, 'Idempotency-Key': result.requestId }, multipart: { ...multipart, source: 'MINIPROGRAM' } })
        assert.equal(conflict.status(), 409)
        check('successful replay is unchanged and conflicting source is rejected')
      }
      await page.screenshot({ path: path.join(out, mime === 'image/png' ? 'import-png.png' : 'import-jpeg.png'), fullPage: true })
      check(mime + ' selection stays local, explicit inference persists and remains owner-scoped')
    }
    await page.getByTestId('image-remove').click()
    assert.equal(await page.getByTestId('image-preview').count(), 0)
    assert.equal(await page.getByTestId('recognized-digit').count(), 0)
    check('remove selected image clears prediction')
    await page.getByTestId('image-file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByTestId('recognition-submit').isDisabled(), true)
    check('corrupt image is locally rejected')
    const block64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0,0,200,200); g.fillStyle = 'black'; g.fillRect(30,30,140,140); return c.toDataURL('image/png').split(',')[1] })
    const block = Buffer.from(block64, 'base64')
    await fs.writeFile(path.join(out, 'scripted-non-digit.png'), block)
    await page.getByTestId('image-file').setInputFiles({ name: 'block.png', mimeType: 'image/png', buffer: block })
    await page.waitForFunction(() => !document.querySelector('[data-testid=recognition-submit]').disabled)
    const declined = await submit(422)
    assert.equal(declined.data.category, 'UNRECOGNIZED_INPUT')
    await page.getByRole('alert').filter({ hasText: '重新书写' }).waitFor()
    assert.equal(await page.getByTestId('recognized-digit').count(), 0)
    assert.equal((await context.request.get(api + '/auth/me', { headers })).status(), 200)
    check('422 has no guessed result and keeps valid session')
    await page.screenshot({ path: path.join(out, 'rejection.png'), fullPage: true })
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.waitForURL('**/login')
    assert.equal((await context.request.get(api + '/auth/me', { headers })).status(), 401)
    check('logout revokes server session')
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ checks, results, declined, errors,
      codeRevision: process.env.PREW3_CODE_REVISION || 'unrecorded', origin: 'browser-scripted',
      originalUserNineAvailable: false, wechatVerified: false, realDeviceVerified: false }, null, 2))
    console.log('ALL PASS', checks.length)
  } finally {
    for (const token of tokens) await context.request.post(api + '/auth/logout', { headers: { Authorization: 'Bearer ' + token } }).catch(() => {})
    await browser.close()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
