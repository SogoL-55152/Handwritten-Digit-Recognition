export function validateTraining(form) {
  const errors = {}
  if (typeof form.modelName !== 'string' || !form.modelName.trim() || form.modelName.trim().length > 64) errors.modelName = '模型名称需为 1–64 个字符'
  if (form.architecture !== 'DigitCNN') errors.architecture = 'W2 仅允许固定 DigitCNN'
  if (!Number.isInteger(form.epoch) || form.epoch < 1 || form.epoch > 5) errors.epoch = 'epoch 必须为 1–5 的整数'
  if (![32, 64, 128].includes(form.batchSize)) errors.batchSize = 'batchSize 仅允许 32 / 64 / 128'
  if (!Number.isFinite(form.learningRate) || form.learningRate <= 0 || form.learningRate > 0.1) errors.learningRate = 'learningRate 必须大于 0 且不超过 0.1'
  if (!Number.isInteger(form.seed) || form.seed < 0 || form.seed > 4294967295) errors.seed = 'seed 必须为 0–4294967295 的整数'
  return errors
}
