/**
 * 训练前的纯前端估算：形状推演、参数量、显存、耗时、校验。
 * 全部同步计算（<1ms），输入即反馈，不依赖后端。
 */

export const INPUT_SHAPE = { h: 28, w: 28, c: 1 }

/** 三种网络预设；层列表是可编辑的普通对象。 */
export const ARCH_PRESETS = [
  {
    id: 'lenet',
    name: 'LeNet-5（快）',
    hint: '参数量小、训练快，适合演示与低配机器',
    layers: [
      { type: 'conv', filters: 6, kernel: 5, stride: 1, padding: 2, act: 'relu' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'conv', filters: 16, kernel: 5, stride: 1, padding: 0, act: 'relu' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'flatten' },
      { type: 'linear', units: 120 },
      { type: 'linear', units: 84 },
      { type: 'linear', units: 10 }
    ]
  },
  {
    id: 'cnn2',
    name: 'CNN 2Conv（默认）',
    hint: '与当前线上模型一致的结构，MNIST 测试集约 99.2%',
    layers: [
      { type: 'conv', filters: 32, kernel: 3, stride: 1, padding: 1, act: 'relu' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'conv', filters: 64, kernel: 3, stride: 1, padding: 1, act: 'relu' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'flatten' },
      { type: 'linear', units: 128 },
      { type: 'dropout', p: 0.5 },
      { type: 'linear', units: 10 }
    ]
  },
  {
    id: 'cnnbn',
    name: 'CNN + BN + Dropout（稳）',
    hint: '抗过拟合，真实笔迹泛化更好，参数量更大',
    layers: [
      { type: 'conv', filters: 32, kernel: 3, stride: 1, padding: 1, act: 'relu' },
      { type: 'bn' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'conv', filters: 64, kernel: 3, stride: 1, padding: 1, act: 'relu' },
      { type: 'bn' },
      { type: 'pool', kernel: 2, stride: 2 },
      { type: 'flatten' },
      { type: 'linear', units: 256 },
      { type: 'dropout', p: 0.5 },
      { type: 'linear', units: 10 }
    ]
  }
]

const LAYER_LABEL = {
  conv: 'Conv2d', pool: 'MaxPool', flatten: 'Flatten', linear: 'Linear', dropout: 'Dropout', bn: 'BatchNorm'
}

export function layerLabel(layer) {
  return LAYER_LABEL[layer?.type] || String(layer?.type || '层')
}

/** 逐层推演：输出形状、该层参数量、错误原因。 */
export function inferShapes(layers, input = INPUT_SHAPE) {
  let h = input.h
  let w = input.w
  let c = input.c
  const rows = []
  const errors = []
  let totalParams = 0
  let activations = 0

  ;(Array.isArray(layers) ? layers : []).forEach((layer, index) => {
    const label = `${index + 1}. ${layerLabel(layer)}`
    let params = 0
    let shape = { h, w, c }
    if (layer.type === 'conv') {
      const k = Number(layer.kernel) || 1
      const s = Number(layer.stride) || 1
      const p = Number(layer.padding) || 0
      const filters = Number(layer.filters) || 1
      const outH = Math.floor((h + 2 * p - k) / s) + 1
      const outW = Math.floor((w + 2 * p - k) / s) + 1
      if (outH <= 0 || outW <= 0) {
        errors.push(`第 ${index + 1} 层输入 ${h}×${w}，无法做 ${k}×${k} 卷积`)
      }
      params = k * k * c * filters + filters
      shape = { h: Math.max(0, outH), w: Math.max(0, outW), c: filters }
    } else if (layer.type === 'pool') {
      const k = Number(layer.kernel) || 2
      const s = Number(layer.stride) || k
      const outH = Math.floor((h - k) / s) + 1
      const outW = Math.floor((w - k) / s) + 1
      if (outH <= 0 || outW <= 0) errors.push(`第 ${index + 1} 层池化窗口大于输入`)
      shape = { h: Math.max(0, outH), w: Math.max(0, outW), c }
    } else if (layer.type === 'flatten') {
      shape = { h: 1, w: 1, c: h * w * c, flat: true }
    } else if (layer.type === 'linear') {
      const units = Number(layer.units) || 1
      params = c * units + units
      shape = { h: 1, w: 1, c: units, flat: true }
    } else if (layer.type === 'bn') {
      params = 2 * c
      shape = { h, w, c }
    }
    totalParams += params
    activations += shape.h * shape.w * shape.c
    rows.push({ index: index + 1, label, type: layer.type, params, shape, layer })
    h = shape.h
    w = shape.w
    c = shape.c
  })

  return { rows, errors, totalParams, activationsPerSample: activations, output: { h, w, c } }
}

/** 显存粗估（GB）：激活 + 参数与优化器状态，AMP 打折。 */
export function estimateMemory(totalParams, activationsPerSample, batch = 64, amp = false) {
  const bytes = 4
  const activation = Math.max(0, activationsPerSample) * Math.max(1, batch) * bytes * 1.3
  const weights = Math.max(0, totalParams) * bytes * 3
  const total = (activation + weights) * (amp ? 0.6 : 1)
  return total / 1024 ** 3
}

/** 单步耗时：按结构相对规模线性插值，CPU 基准 12ms / GPU 基准 1.2ms（batch 64、421k 参数）。 */
export function estimateStepMs(totalParams, batch, device = 'cpu') {
  const reference = 421642
  const base = device === 'gpu' ? 1.2 : 12
  const scale = Math.max(0.2, totalParams / reference)
  return base * scale * (Math.max(1, batch) / 64)
}

export function estimateTiming({ totalParams, trainSamples, batch, epochs, device = 'cpu' }) {
  const steps = Math.max(1, Math.ceil((Number(trainSamples) || 0) / Math.max(1, batch)))
  const stepMs = estimateStepMs(totalParams, batch, device)
  const epochSeconds = (steps * stepMs) / 1000
  return { steps, stepMs, epochSeconds, totalSeconds: epochSeconds * Math.max(1, epochs) }
}

/** 配置校验：ok / warn / error 三态，warn 要给可执行建议。 */
export function validateConfig({ config, shapes, memoryGb, timing, gpuMemoryGb = 4 }) {
  const checks = []
  if (shapes.errors.length) {
    shapes.errors.slice(0, 3).forEach((text) => checks.push({ level: 'error', text }))
  } else {
    checks.push({ level: 'ok', text: '网络结构可以前向：逐层形状已推演到输出 10 维' })
  }
  if (memoryGb > gpuMemoryGb) {
    const suggest = Math.max(16, Math.floor((config.batchSize * gpuMemoryGb) / memoryGb / 16) * 16)
    checks.push({ level: 'warn', text: `batch=${config.batchSize} 估算 ${memoryGb.toFixed(1)} GB，超过可用 ${gpuMemoryGb} GB；建议 batch ≤ ${suggest} 或开启混合精度` })
  } else {
    checks.push({ level: 'ok', text: `显存估算 ${memoryGb.toFixed(2)} GB，在 ${gpuMemoryGb} GB 预算内` })
  }
  const lr = Number(config.learningRate)
  const optimizer = config.optimizer
  if (optimizer === 'adam' && (lr > 5e-3 || lr < 1e-5)) {
    checks.push({ level: 'warn', text: `Adam 常用学习率 5e-4 ~ 1e-3，当前 ${lr} 可能${lr > 5e-3 ? '发散' : '几乎不更新'}` })
  }
  if (optimizer === 'sgd' && lr < 1e-3) {
    checks.push({ level: 'warn', text: `SGD 学习率通常 1e-2 ~ 1e-1，当前 ${lr} 偏小` })
  }
  if (config.epochs > 20 && !config.earlyStop) {
    checks.push({ level: 'warn', text: `训练 ${config.epochs} 轮且未开早停，预计耗时 ${formatDuration(timing.totalSeconds)}，建议开启早停` })
  }
  if (config.device === 'cpu') {
    checks.push({ level: 'warn', text: `当前无 GPU，按 CPU 估算约 ${formatDuration(timing.totalSeconds)}，约为 GPU 的 10 倍` })
  }
  if (!checks.some((item) => item.level === 'error' || item.level === 'warn')) {
    checks.push({ level: 'ok', text: '参数齐全，可以开始训练' })
  }
  return checks
}

export function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  if (value < 60) return `${value} 秒`
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 配置指纹：sha256(configJson) 前 12 位；不可用时退化为简单哈希。 */
export async function configHash(config) {
  const text = JSON.stringify(normalizeConfig(config))
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(text)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
  }
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 只保留参与训练的字段，避免界面状态混进指纹。 */
export function normalizeConfig(config) {
  return {
    arch: config.arch,
    layers: (config.layers || []).map((layer) => ({ ...layer })),
    optimizer: config.optimizer,
    learningRate: Number(config.learningRate),
    batchSize: Number(config.batchSize),
    epochs: Number(config.epochs),
    earlyStop: Boolean(config.earlyStop),
    patience: Number(config.patience),
    seed: Number(config.seed),
    device: config.device,
    amp: Boolean(config.amp),
    datasetVersionId: config.datasetVersionId ?? null
  }
}
