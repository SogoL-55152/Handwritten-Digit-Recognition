/** 用户标注反馈的纯逻辑：校验、表单构造、结果文案。 */
export const FEEDBACK_LABELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

export function validateFeedback({ label, consent }) {
  const errors = {}
  if (!Number.isInteger(label) || label < 0 || label > 9) errors.label = '请选择你实际写的数字'
  if (!consent) errors.consent = '需要同意后才能保存这张图片'
  return errors
}

function imageName(image) {
  if (image && typeof image.name === 'string' && image.name) return image.name
  const type = image && image.type
  return type === 'image/jpeg' ? 'drawing.jpeg' : 'drawing.png'
}

/**
 * 构造采集表单。predict* 来自本次识别结果，用于记下"模型当时怎么判的"，
 * 与用户给出的正确答案一起构成一条带上下文的样本。
 */
export function buildFeedbackForm({ image, label, consent, result, source = 'WEB' }) {
  const form = new FormData()
  form.append('image', image, imageName(image))
  form.append('label', String(label))
  form.append('consent', String(Boolean(consent)))
  form.append('source', source)
  if (result) {
    if (typeof result.digit === 'number') form.append('predictedDigit', String(result.digit))
    if (typeof result.confidence === 'number') form.append('confidence', String(result.confidence))
    if (result.modelVersion) form.append('modelVersion', String(result.modelVersion))
    if (result.recognitionId) form.append('recognitionId', String(result.recognitionId))
  }
  return form
}

export function feedbackMessage(response) {
  const total = response && typeof response.contributedTotal === 'number' ? response.contributedTotal : 0
  if (response && response.duplicate) return `这张图片之前已经采集过，感谢！你已贡献 ${total} 条。`
  return `已收录，感谢！你已贡献 ${total} 条。`
}
