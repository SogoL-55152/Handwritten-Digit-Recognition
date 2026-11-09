/**
 * 训练参数的浏览器侧校验与请求体构造。
 * 边界必须与服务端一致：服务端是最终裁决者，这里只做首屏即时反馈。
 */
export const TRAINING_LIMITS = {
  epochs: [1, 5],
  samples: [1000, 60000],
  batchSizes: [32, 64, 128],
  learningRate: [0, 0.1],
  seed: [0, 4294967295],
  photoRatio: [0, 1]
}

const isInt = (value) => Number.isInteger(value) && !Number.isNaN(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

export function validateTraining(form) {
  const errors = {}
  if (!isInt(form.epochs) || form.epochs < 1 || form.epochs > 5) errors.epochs = 'epoch 必须为 1–5 的整数'
  if (!isInt(form.samples) || form.samples < 1000 || form.samples > 60000) errors.samples = '样本数必须为 1000–60000 的整数'
  if (!TRAINING_LIMITS.batchSizes.includes(form.batchSize) || typeof form.batchSize !== 'number')
    errors.batchSize = 'batchSize 仅允许 32 / 64 / 128'
  if (!finite(form.learningRate) || form.learningRate <= 0 || form.learningRate > 0.1)
    errors.learningRate = 'learningRate 必须大于 0 且不超过 0.1'
  if (!isInt(form.seed) || form.seed < 0 || form.seed > 4294967295) errors.seed = 'seed 必须为 0–4294967295 的整数'
  if (!finite(form.photoRatio) || form.photoRatio < 0 || form.photoRatio > 1)
    errors.photoRatio = '照片比例必须在 0–1 之间'
  if (typeof form.useEmnist !== 'boolean') errors.useEmnist = 'EMNIST 选项必须为布尔值'
  return errors
}

export function validateDataset(datasetId) {
  return Number.isInteger(datasetId) && datasetId > 0 ? {} : { datasetId: '请选择一个数据集' }
}

/** 只提交服务端认识的字段，避免多余字段被契约拒绝。 */
export function toCreatePayload(form) {
  return {
    epochs: form.epochs,
    samples: form.samples,
    batchSize: form.batchSize,
    learningRate: form.learningRate,
    seed: form.seed,
    photoRatio: form.photoRatio,
    useEmnist: form.useEmnist
  }
}
