// 验证采集页内置 ZIP 写出器：抽出 index.html 里 //#zip-begin 段，生成 zip 交给 Python 校验。
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const html = readFileSync('tools/sample-collector/index.html', 'utf8')
const begin = html.indexOf('//#zip-begin')
const end = html.indexOf('//#zip-end')
if (begin < 0 || end < 0) throw new Error('标记缺失')
const code = html.slice(begin, end)

const factory = new Function(`${code}; return { makeZip, crc32, dataUrlToBytes };`)
const { makeZip, crc32 } = factory()

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const manifest = new TextEncoder().encode(JSON.stringify({
  samples: [{ id: 't-7-001', file: 't-7-001.png', label: 7, origin: 'actual-user-board',
              writerId: 'test', captureSessionId: 'c1', consent: true }]
}, null, 1))
const blob = makeZip([
  { name: 't-7-001.png', bytes: png },
  { name: 'manifest.json', bytes: manifest }
])
const buffer = new Uint8Array(await blob.arrayBuffer())
writeFileSync('D:/Temp/collector-zip-test.zip', buffer)
console.log(JSON.stringify({ zipBytes: buffer.length, crcPng: crc32(png).toString(16), magic: [...buffer.slice(0, 4)] }))
