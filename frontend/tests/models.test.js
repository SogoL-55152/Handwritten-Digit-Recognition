import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateModelList, summarize, canActivate, canDisable, canDelete, createModelAdmin
} from '../src/models/controller.js'

const base = {
  id: '1', externalId: 'mnist-cnn-w1', version: 'w2-canvas-photo-3epoch',
  preprocessVersion: 'adaptive-mnist-v2', status: 'ACTIVE', verified: true,
  artifact: 'w2-canvas-photo/checkpoint.pt', sha256: 'a'.repeat(64), sizeBytes: 1690340,
  registryReason: ''
}

function fakeApi(overrides = {}) {
  const calls = []
  const api = {
    calls,
    listModels: async () => { calls.push(['list']); return [{ ...base }] },
    activateModel: async (id) => { calls.push(['activate', id]); return { ...base, id, status: 'ACTIVE' } },
    disableModel: async (id) => { calls.push(['disable', id]); return { ...base, id, status: 'DISABLED' } },
    deleteModel: async (id) => { calls.push(['delete', id]); return { deleted: id } },
    reloadRegistry: async () => { calls.push(['reload']); return [] },
    ...overrides
  }
  return api
}

test('validateModelList rejects malformed payloads', () => {
  assert.throws(() => validateModelList(null), /格式无效/)
  assert.throws(() => validateModelList([]), /格式无效/)
  assert.throws(() => validateModelList([{ ...base, id: '' }]), /标识/)
  assert.throws(() => validateModelList([{ ...base, version: 1 }]), /版本信息/)
  assert.throws(() => validateModelList([{ ...base, preprocessVersion: '' }]), /预处理版本/)
  assert.throws(() => validateModelList([{ ...base, status: 'LIVE' }]), /状态无法识别/)
  assert.throws(() => validateModelList([{ ...base, verified: 'yes' }]), /注册表校验/)
  assert.equal(validateModelList([base]).length, 1)
})

test('summarize renders status, digest and registry state', () => {
  const summary = summarize(base)
  assert.equal(summary.statusLabel, '生效中')
  assert.equal(summary.artifact, 'w2-canvas-photo/checkpoint.pt')
  assert.match(summary.digest, /^a{12}…$/)
  assert.match(summary.sizeLabel, /MiB$/)
  assert.match(summary.registryLabel, /摘要已校验/)
  const unverified = summarize({ ...base, verified: false, registryReason: 'RegistryInvalid' })
  assert.match(unverified.registryLabel, /RegistryInvalid/)
})

test('action availability follows status and verification', () => {
  assert.equal(canActivate({ ...base, status: 'INACTIVE', verified: true }), true)
  assert.equal(canActivate({ ...base, status: 'INACTIVE', verified: false }), false)
  assert.equal(canActivate(base), false)
  assert.equal(canDisable(base), true)
  assert.equal(canDisable({ ...base, status: 'DISABLED' }), false)
  assert.equal(canDelete({ ...base, status: 'DISABLED' }), true)
  assert.equal(canDelete(base), false)
})

test('activate sends the session and requires server confirmation', async () => {
  const api = fakeApi()
  const admin = createModelAdmin({ api, getSession: () => ({ token: 't' }) })
  const updated = await admin.activate('2')
  assert.equal(updated.status, 'ACTIVE')
  assert.deepEqual(api.calls, [['activate', '2']])

  const unconfirmed = createModelAdmin({
    api: fakeApi({ activateModel: async () => ({ ...base, status: 'INACTIVE' }) }),
    getSession: () => ({ token: 't' })
  })
  await assert.rejects(() => unconfirmed.activate('2'), /未确认/)
})

test('concurrent operations are serialized', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const api = fakeApi({ activateModel: async (id) => { await gate; return { ...base, id, status: 'ACTIVE' } } })
  const admin = createModelAdmin({ api, getSession: () => ({ token: 't' }) })
  const first = admin.activate('1')
  await assert.rejects(() => admin.activate('2'), /尚未完成/)
  release()
  assert.equal((await first).status, 'ACTIVE')
  assert.equal(admin.pending(), null)
})

test('disable, remove and registry reload delegate to the api', async () => {
  const api = fakeApi()
  const admin = createModelAdmin({ api, getSession: () => ({ token: 't' }) })
  await admin.disable('3')
  await admin.remove('4')
  await admin.reloadRegistry()
  await admin.list()
  assert.deepEqual(api.calls, [['disable', '3'], ['delete', '4'], ['reload'], ['list']])
})

test('list surfaces validation failures from the server payload', async () => {
  const admin = createModelAdmin({
    api: fakeApi({ listModels: async () => [{ ...base, status: 'LIVE' }] }),
    getSession: () => ({ token: 't' })
  })
  await assert.rejects(() => admin.list(), /状态无法识别/)
})
