import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARCH_PRESETS, configHash, estimateMemory, estimateStepMs, estimateTiming,
  formatDuration, inferShapes, normalizeConfig, validateConfig
} from '../src/wizard/estimate.js'
import { defaultConfig, isVisible, PARAM_SCHEMA } from '../src/wizard/schema.js'

const cnn2 = ARCH_PRESETS.find((item) => item.id === 'cnn2')

test('cnn2 preset matches the production model parameter count', () => {
  const shapes = inferShapes(cnn2.layers)
  assert.equal(shapes.errors.length, 0)
  assert.equal(shapes.totalParams, 421642)
  assert.deepEqual(shapes.output, { h: 1, w: 1, c: 10 })
})

test('output shapes follow conv/pool arithmetic', () => {
  const shapes = inferShapes(cnn2.layers)
  const conv1 = shapes.rows.find((row) => row.index === 1)
  const pool1 = shapes.rows.find((row) => row.index === 2)
  const conv2 = shapes.rows.find((row) => row.index === 3)
  assert.deepEqual(conv1.shape, { h: 28, w: 28, c: 32 })
  assert.deepEqual(pool1.shape, { h: 14, w: 14, c: 32 })
  assert.deepEqual(conv2.shape, { h: 14, w: 14, c: 64 })
  assert.equal(conv1.params, 320)
  assert.equal(conv2.params, 18496)
})

test('impossible layers surface a readable error', () => {
  const shapes = inferShapes([
    { type: 'conv', filters: 8, kernel: 5, stride: 1, padding: 0 },
    { type: 'conv', filters: 8, kernel: 25, stride: 1, padding: 0 }
  ])
  assert.ok(shapes.errors.length >= 1)
  assert.match(shapes.errors[0], /无法做 25×25 卷积/)
})

test('memory grows with batch and shrinks with AMP', () => {
  const shapes = inferShapes(cnn2.layers)
  const small = estimateMemory(shapes.totalParams, shapes.activationsPerSample, 32, false)
  const large = estimateMemory(shapes.totalParams, shapes.activationsPerSample, 128, false)
  const amp = estimateMemory(shapes.totalParams, shapes.activationsPerSample, 128, true)
  assert.ok(large > small)
  assert.ok(amp < large)
  assert.ok(small > 0)
})

test('step time scales with parameters, batch and device', () => {
  const cpu = estimateStepMs(421642, 64, 'cpu')
  const gpu = estimateStepMs(421642, 64, 'gpu')
  assert.ok(cpu > gpu * 5)
  assert.ok(estimateStepMs(421642, 128, 'cpu') > cpu)
  assert.ok(estimateStepMs(421642 * 2, 64, 'cpu') > cpu)
})

test('timing converts samples into steps and total duration', () => {
  const timing = estimateTiming({ totalParams: 421642, trainSamples: 60000, batch: 64, epochs: 10, device: 'cpu' })
  assert.equal(timing.steps, 938)
  assert.ok(timing.totalSeconds > 0)
  assert.equal(timing.totalSeconds, timing.epochSeconds * 10)
})

test('validation reports ok, warn and error levels', () => {
  const shapes = inferShapes(cnn2.layers)
  const timing = estimateTiming({ totalParams: shapes.totalParams, trainSamples: 60000, batch: 64, epochs: 10, device: 'cpu' })
  const base = {
    config: { ...defaultConfig(), batchSize: 64 },
    shapes, timing, gpuMemoryGb: 4
  }
  const okChecks = validateConfig({ ...base, memoryGb: 1 })
  assert.ok(okChecks.some((item) => item.level === 'ok'))
  assert.ok(okChecks.some((item) => item.level === 'warn' && item.text.includes('CPU')))

  const over = validateConfig({ ...base, memoryGb: 9 })
  assert.ok(over.some((item) => item.level === 'warn' && item.text.includes('超过可用')))

  const broken = inferShapes([{ type: 'conv', filters: 4, kernel: 7, stride: 1, padding: 0 }, { type: 'conv', filters: 4, kernel: 25, stride: 1, padding: 0 }])
  const errChecks = validateConfig({ ...base, shapes: broken, memoryGb: 1 })
  assert.ok(errChecks.some((item) => item.level === 'error'))
})

test('validation warns about SGD with tiny learning rate', () => {
  const shapes = inferShapes(cnn2.layers)
  const timing = estimateTiming({ totalParams: shapes.totalParams, trainSamples: 1000, batch: 64, epochs: 2, device: 'gpu' })
  const checks = validateConfig({
    config: { ...defaultConfig(), optimizer: 'sgd', learningRate: 1e-4, device: 'gpu' },
    shapes, timing, memoryGb: 1
  })
  assert.ok(checks.some((item) => item.level === 'warn' && item.text.includes('SGD')))
})

test('duration formatting is human readable', () => {
  assert.equal(formatDuration(30), '30 秒')
  assert.equal(formatDuration(200), '3 分 20 秒')
  assert.equal(formatDuration(3600), '1 小时 0 分')
})

test('config hash is stable for the same config and changes with edits', async () => {
  const config = { ...defaultConfig(), layers: cnn2.layers }
  const first = await configHash(config)
  const second = await configHash({ ...config, layers: cnn2.layers.map((layer) => ({ ...layer })) })
  assert.equal(first, second)
  assert.ok(first.length >= 8)
  const changed = await configHash({ ...config, epochs: 11 })
  assert.notEqual(first, changed)
})

test('normalizeConfig drops UI-only fields', () => {
  const normalized = normalizeConfig({ ...defaultConfig(), error: 'x', loading: true })
  assert.equal('error' in normalized, false)
  assert.equal('loading' in normalized, false)
  assert.ok('layers' in normalized)
})

test('schema renders dependsOn fields only when the driver matches', () => {
  const hyper = PARAM_SCHEMA.find((group) => group.id === 'hyper')
  const momentum = hyper.items.find((item) => item.key === 'momentum')
  const patience = hyper.items.find((item) => item.key === 'patience')
  assert.equal(isVisible(momentum, { optimizer: 'adam' }), false)
  assert.equal(isVisible(momentum, { optimizer: 'sgd' }), true)
  assert.equal(isVisible(patience, { earlyStop: false }), false)
  assert.equal(isVisible(patience, { earlyStop: true }), true)
})

test('schema covers the four groups the design calls for', () => {
  assert.deepEqual(PARAM_SCHEMA.map((group) => group.id), ['data', 'hyper', 'runtime'])
  assert.ok(PARAM_SCHEMA.some((group) => group.items.some((item) => item.key === 'augMosaic')))
  for (const group of PARAM_SCHEMA) {
    for (const item of group.items) {
      assert.ok(item.key && item.label && item.widget)
    }
  }
})
