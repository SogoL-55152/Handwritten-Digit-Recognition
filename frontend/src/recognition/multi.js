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
