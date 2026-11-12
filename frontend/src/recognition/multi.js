/** 多位数预览的纯逻辑：表单构造与结果整理，便于单测。 */
export const MAX_DIGITS_OPTIONS = [1, 2, 3, 4]

export function buildMultiForm(image, maxDigits, source = 'WEB') {
  const form = new FormData()
  const name = image && typeof image.name === 'string' && image.name ? image.name : 'drawing.png'
  form.append('image', image, name)
  form.append('source', source)
  return form
}

export function multiSummary(response) {
  if (!response || typeof response.text !== 'string' || !/^[0-9]+$/.test(response.text)) {
    return { text: '', digits: [], valid: false }
  }
  const digits = (Array.isArray(response.digits) ? response.digits : []).map((item, index) => ({
    digit: item.digit,
    confidence: typeof item.confidence === 'number' ? `${(item.confidence * 100).toFixed(1)}%` : '—',
    position: index + 1,
    low: typeof item.confidence === 'number' && item.confidence < 0.9
  }))
  const lowCount = digits.filter((item) => item.low).length
  return {
    text: response.text,
    recognitionId: response.recognitionId || '',
    digits,
    valid: digits.length === response.text.length,
    accepted: Boolean(response.accepted),
    hint: lowCount
      ? `有 ${lowCount} 位置信度低于 90%，建议重写`
      : response.accepted
        ? '各位置信度都在阈值以上'
        : '整串未达到接受阈值，请重写或减少位数'
  }
}

/** 多位数采集：用户手输实际写的数字串（1–4 位），不是点选。 */
export function validateMultiLabel(value) {
  const text = String(value ?? '').trim()
  if (!text) return '请填写你实际写的数字'
  if (!/^[0-9]{1,4}$/.test(text)) return '只能填 1–4 位数字'
  return ''
}

export function buildMultiSampleForm({ image, labelText, consent, result, source = 'WEB' }) {
  const form = new FormData()
  const name = image && typeof image.name === 'string' && image.name ? image.name : 'drawing.png'
  form.append('image', image, name)
  form.append('labelText', String(labelText).trim())
  form.append('consent', String(Boolean(consent)))
  form.append('source', source)
  if (result && result.text) form.append('predictedText', result.text)
  if (result && result.recognitionId) form.append('recognitionId', String(result.recognitionId))
  if (result && result.modelVersion) form.append('modelVersion', String(result.modelVersion))
  return form
}

/**
 * 根据用户的选择得出要提交的标签：
 * confirm = 确认模型判断正确，直接用品串；correct = 用户自己输入正确串。
 */
export function resolveMultiSampleLabel(mode, predicted, input) {
  if (mode === 'confirm') return String(predicted ?? '').trim()
  return String(input ?? '').trim()
}

/** 多位数接口的查询串：位数 + 是否需要照片增强。 */
export function buildMultiQuery(maxDigits, enhance) {
  const parts = [`maxDigits=${encodeURIComponent(maxDigits)}`]
  if (enhance) parts.push('enhance=true')
  return `?${parts.join('&')}`
}
