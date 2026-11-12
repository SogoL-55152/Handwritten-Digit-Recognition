<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { recognize } from '@/api/workspaces.js'
import { createDrawingBoard } from '@/recognition/drawing-board.js'
import { createRecognitionController } from '@/recognition/controller.js'
import { prepareImage } from '@/recognition/image-import.js'
import { appConfig } from '@/app-config.js'
import { submitSample } from '@/api/collected.js'
import { submitMulti } from '@/api/multi.js'
import { MAX_DIGITS_OPTIONS, buildMultiForm, buildMultiSampleForm, multiSummary, resolveMultiSampleLabel, validateMultiLabel } from '@/recognition/multi.js'
import { FEEDBACK_LABELS, buildFeedbackForm, feedbackMessage, validateFeedback } from '@/recognition/feedback.js'
const pilot = appConfig.pilot

const canvas = ref(null)
const user = useUserStore()
const workspace = useWorkspaceStore()
const boardError = ref('')
let board, observer
const controller = createRecognitionController({ session: user, workspace, exportPng: () => board.exportPng(), prepareImage, send: recognize, reactive })
const state = controller.state
const canSubmit = computed(() => (state.inputKind === 'image' || !boardError.value) && controller.canSubmit())

const multi = reactive({ enabled: false, maxDigits: 3, loading: false, result: null, error: '',
  submittedImage: null, requestId: null, labelText: '', sampleSubmitting: false, sampleMessage: '',
  sampleError: '', sampleDone: null, sampleMode: null })

async function runMultiRecognition() {
  if (multi.loading) return
  if (state.inputKind !== 'drawing') {
    multi.error = '多位数预览目前只支持画板书写。'
    return
  }
  if (!state.hasInk || state.drawing) {
    multi.error = '请先在画板写好数字，抬起指针后再提交。'
    return
  }
  multi.loading = true
  multi.error = ''
  multi.sampleMessage = ''
  multi.sampleError = ''
  multi.sampleDone = null
  multi.sampleMode = null
  multi.labelText = ''
  try {
    const image = await board.exportPng()
    multi.submittedImage = image
    const requestId = crypto.randomUUID()
    const response = await submitMulti(workspace.getSnapshot(), buildMultiForm(image, multi.maxDigits),
      requestId, { inputCurrent: () => true })
    const summary = multiSummary(response)
    if (!summary.valid) throw new Error('多位数接口返回了无法解析的结果')
    multi.result = { ...summary, modelVersion: response.modelVersion, requestId: response.requestId }
    multi.requestId = response.requestId
  } catch (error) {
    multi.error = error?.message || '多位数识别失败，请稍后重试'
    multi.result = null
  } finally {
    multi.loading = false
  }
}

async function submitMultiSample(mode) {
  if (multi.sampleSubmitting || !multi.submittedImage) return
  const text = resolveMultiSampleLabel(mode, multi.result && multi.result.text, multi.labelText)
  const invalid = validateMultiLabel(text)
  if (invalid) {
    multi.sampleError = invalid
    return
  }
  if (!consentGiven.value) {
    multi.sampleError = '请先在左侧勾选同意，才会保存这张图。'
    return
  }
  multi.sampleSubmitting = true
  multi.sampleError = ''
  try {
    const response = await submitSample(workspace.getSnapshot(), buildMultiSampleForm({
      image: multi.submittedImage,
      labelText: text,
      consent: true,
      result: multi.result
    }), { inputCurrent: () => true })
    multi.sampleMessage = feedbackMessage(response)
    multi.sampleDone = multi.requestId
    multi.sampleMode = null
    multi.labelText = ''
  } catch (error) {
    multi.sampleError = error?.message || '提交失败，请稍后重试'
  } finally {
    multi.sampleSubmitting = false
  }
}

function submitPrimary() {
  if (multi.enabled) return runMultiRecognition()
  return controller.submit()
}

const multiReady = computed(() => state.inputKind === 'drawing' && state.hasInk && !state.drawing && !multi.loading)

const CONSENT_KEY = 'hdr.consent.v1'
const consentGiven = ref(localStorage.getItem(CONSENT_KEY) === '1')
function setConsent(value) {
  consentGiven.value = Boolean(value)
  localStorage.setItem(CONSENT_KEY, consentGiven.value ? '1' : '0')
  if (consentGiven.value) feedbackErrors.value = {}
}

const feedback = reactive({ submitting: false, message: '', error: '', sentFor: null, wrongOpen: false })
const feedbackErrors = ref({})
const feedbackDone = computed(() => !state.submitted || feedback.sentFor === state.submitted.requestId)
const predictedLabel = computed(() => (state.result && typeof state.result.digit === 'number' ? state.result.digit : null))

/** 提交用户标注：label 必须是用户自己确认的数字，不是模型预测。 */
async function sendFeedback(label) {
  const submitted = state.submitted
  if (!submitted || feedback.submitting || feedbackDone.value) return
  feedbackErrors.value = validateFeedback({ label, consent: consentGiven.value })
  if (Object.keys(feedbackErrors.value).length) {
    feedback.error = consentGiven.value ? '' : '请先在左侧勾选同意，才会保存这张图。'
    return
  }
  feedback.submitting = true
  feedback.error = ''
  try {
    const response = await submitSample(workspace.getSnapshot(), buildFeedbackForm({
      image: submitted.image,
      label,
      consent: true,
      result: state.result,
      source: 'WEB'
    }), { inputCurrent: () => true })
    feedback.message = feedbackMessage(response)
    feedback.sentFor = submitted.requestId
    feedback.wrongOpen = false
  } catch (error) {
    feedback.error = error?.message || '提交失败，请稍后重试'
  } finally {
    feedback.submitting = false
  }
}

const confirmCorrect = () => {
  if (predictedLabel.value === null) return
  void sendFeedback(predictedLabel.value)
}
const pickCorrect = (value) => {
  feedback.wrongOpen = false
  void sendFeedback(value)
}
const skipFeedback = () => {
  if (!state.submitted) return
  feedback.sentFor = state.submitted.requestId
  feedback.message = ''
  feedback.error = ''
}

// 每次重新识别都重置标注状态，避免把上一张的标签带到新图上
watch(() => state.submitted?.requestId, () => {
  feedback.message = ''
  feedback.error = ''
  feedback.wrongOpen = false
  feedbackErrors.value = {}
})

function selectFile(event) {
  const file = event.target.files?.[0]
  event.target.value = '' // Selecting the same file again still emits change; never retain a path.
  void controller.selectImage(file)
}
function resizeDrawing() {
  if (state.inputKind === 'drawing') board?.resize()
}
watch(() => state.inputKind, resizeDrawing, { flush: 'post' })
watch(() => workspace.generation, () => board?.clear(), { flush: 'sync' })
onMounted(() => {
  try {
    board = createDrawingBoard({ canvas: canvas.value, onChange: controller.drawingChanged })
    observer = new ResizeObserver(resizeDrawing)
    observer.observe(canvas.value)
  } catch (error) { boardError.value = error.message }
})
onUnmounted(() => { observer?.disconnect(); controller.dispose(); board?.dispose() })
</script>

<template>
  <div class="recognition-grid">
    <section class="panel drawing-panel">
      <div class="section-heading"><h2>识别单个 0–9</h2><span v-if="!pilot" class="tag">PNG / JPEG · WEB</span></div>
      <div class="actions input-modes" role="group" aria-label="输入方式">
        <button data-testid="input-drawing" :aria-pressed="state.inputKind === 'drawing'" :class="{ primary: state.inputKind === 'drawing' }" @click="controller.setInputKind('drawing')">手写数字</button>
        <button data-testid="input-image" :aria-pressed="state.inputKind === 'image'" :class="{ primary: state.inputKind === 'image' }" @click="controller.setInputKind('image')">导入图片</button>
      </div>
      <div v-show="state.inputKind !== 'image'">
        <p class="muted">使用鼠标、触控笔或手指。尽量居中写大一些，每次只写一个数字。</p>
        <div class="canvas-frame"><canvas ref="canvas" aria-label="手写数字画板" role="img">浏览器需支持 Canvas，请使用新版 Edge 或 Chrome。</canvas></div>
        <p v-if="boardError" class="notice error" role="alert">{{ boardError }}</p>
      </div>
      <div v-if="state.inputKind === 'image'" class="image-input">
        <p id="image-limits" class="muted">选择一张 PNG / JPEG，大小 ≤5 MiB，最长边 ≤2048 像素。图片应只含一个清晰的 0–9；不支持多数字 OCR，不保证复杂背景照片的识别效果。</p>
        <label>选择本地图片<input data-testid="image-file" type="file" accept="image/png,image/jpeg" aria-describedby="image-limits" @change="selectFile" /></label>
        <p v-if="state.validating" data-testid="image-validation" class="notice" role="status">正在本地校验图片，尚未上传…</p>
        <figure v-if="state.image" class="image-preview">
          <img data-testid="image-preview" :src="state.image.previewUrl" alt="待识别的已选图片" />
          <figcaption>{{ state.image.mime === 'image/jpeg' ? 'JPEG' : 'PNG' }} · {{ state.image.width }} × {{ state.image.height }} 像素 · {{ (state.image.size / 1024).toFixed(1) }} KiB</figcaption>
        </figure>
        <p v-else-if="!state.validating" class="muted">尚未选择有效图片。</p>
        <p class="muted">仅处理你明确选择的这一张图片，不扫描或批量读取相册。预览只在本地；点击“识别图片”才上传原始文件，不压缩或重新编码。</p>
      </div>
      <div class="actions">
        <button data-testid="recognition-submit" class="primary" :disabled="multi.enabled ? !multiReady : !canSubmit" @click="submitPrimary()">{{ multi.enabled ? (multi.loading ? '识别中…' : '识别多位数字') : (state.loading ? '识别中…' : state.inputKind === 'image' ? '识别图片' : '识别数字') }}</button>
        <button v-if="state.inputKind === 'image'" data-testid="image-remove" :disabled="!state.image && !state.validating" @click="controller.removeImage()">移除图片</button>
        <button v-else @click="board?.clear()">清空画板</button>
      </div>
      <label class="consent-row multi-toggle">
        <input type="checkbox" v-model="multi.enabled" :disabled="state.inputKind === 'image'" />
        <span>多位数识别：先在画板上写 1–4 个间隔的数字，再点识别</span>
        <select v-model.number="multi.maxDigits" :disabled="!multi.enabled" aria-label="最多几位">
          <option v-for="value in MAX_DIGITS_OPTIONS" :key="value" :value="value">最多 {{ value }} 位</option>
        </select>
      </label>
      <p v-if="multi.enabled" class="muted">会写入识别历史；数字之间要留空隙，最多 4 位。</p>
      <label class="consent-row">
        <input type="checkbox" :checked="consentGiven" @change="setConsent($event.target.checked)" />
        <span>同意把识别图片与我的标注用于模型评估与改进（勾选一次后长期有效，可随时取消）</span>
      </label>
      <p v-if="state.inputKind !== 'image'" class="muted">{{ !state.hasInk ? '画板为空，请先书写。' : state.drawing ? '书写中，请抬起指针后提交。' : '继续书写或清空会使之前的识别结果失效。' }}</p>
    </section>
    <section class="panel result-panel" aria-live="polite" :aria-busy="state.loading">
      <p class="eyebrow">真实模型推理</p><h2>识别结果</h2>
      <p v-if="state.loading" class="notice">{{ pilot ? '正在识别数字。' : '正在通过 Java 调用模型。' }}请勿重复提交；没有自动重试。</p>
      <p v-else-if="state.error" role="alert" class="notice error">{{ state.error }}</p>
      <template v-else-if="state.result">
        <p class="prediction">预测数字 <strong data-testid="recognized-digit">{{ state.result.digit }}</strong></p>
        <template v-if="pilot">
          <dl class="details"><dt>置信度</dt><dd>{{ (state.result.confidence * 100).toFixed(2) }}%</dd><dt>处理耗时</dt><dd>{{ state.result.processingMs }} ms</dd></dl>
          <details :key="state.result.requestId"><summary>查看技术详情（模型、版本与记录）</summary><dl class="details"><dt>模型 ID</dt><dd>{{ state.result.modelId }}</dd><dt>模型版本</dt><dd>{{ state.result.modelVersion }}</dd><dt>预处理版本</dt><dd>{{ state.result.preprocessVersion }}</dd><dt>来源</dt><dd>{{ state.result.source }}</dd><dt>记录 ID</dt><dd>{{ state.result.recognitionId }}</dd><dt>请求 ID</dt><dd>{{ state.result.requestId }}</dd><dt>记录时间</dt><dd>{{ state.result.createdAt }}</dd></dl></details>
        </template>
        <dl v-else class="details"><dt>置信度</dt><dd>{{ (state.result.confidence * 100).toFixed(2) }}%</dd><dt>模型 ID</dt><dd>{{ state.result.modelId }}</dd><dt>模型版本</dt><dd>{{ state.result.modelVersion }}</dd><dt>预处理版本</dt><dd>{{ state.result.preprocessVersion }}</dd><dt>处理耗时</dt><dd>{{ state.result.processingMs }} ms</dd><dt>来源</dt><dd>{{ state.result.source }}</dd><dt>记录 ID</dt><dd>{{ state.result.recognitionId }}</dd><dt>请求 ID</dt><dd>{{ state.result.requestId }}</dd><dt>记录时间</dt><dd>{{ state.result.createdAt }}</dd></dl>
        <p class="muted">置信度表示本次预测的模型评分，不是线上识别准确率。</p>
      </template>
      <div v-if="multi.result" class="multi-result" aria-live="polite">
        <p class="prediction">识别为 <strong data-testid="multi-text">{{ multi.result.text }}</strong></p>
        <div class="multi-chips">
          <span v-for="item in multi.result.digits" :key="item.position" class="multi-chip" :class="{ low: item.low }">
            {{ item.position }}: {{ item.digit }} · {{ item.confidence }}
          </span>
        </div>
        <p class="muted">{{ multi.result.hint }}（{{ multi.result.recognitionId ? "记录 #" + multi.result.recognitionId + " · " : "" }}模型 {{ multi.result.modelVersion }}）</p>
        <div v-if="multi.submittedImage && multi.sampleDone !== multi.requestId" class="multi-sample">
          <p class="feedback-question">这次识别对了吗？</p>
          <div class="feedback-actions">
            <button type="button" class="primary" :disabled="multi.sampleSubmitting" @click="submitMultiSample('confirm')">✓ 对，就是 {{ multi.result.text }}</button>
            <button type="button" :disabled="multi.sampleSubmitting" @click="multi.sampleMode = multi.sampleMode === 'correct' ? null : 'correct'">✗ 不对，我来输入</button>
            <button type="button" :disabled="multi.sampleSubmitting" @click="multi.sampleDone = multi.requestId">跳过</button>
          </div>
          <div v-if="multi.sampleMode === 'correct'" class="sample-input-row">
            <span>实际是：</span>
            <input v-model="multi.labelText" maxlength="4" inputmode="numeric" placeholder="例如 351"
                   aria-label="你实际写的数字" @input="multi.sampleError = ''" />
            <button type="button" class="primary" :disabled="multi.sampleSubmitting || !multi.labelText" @click="submitMultiSample('correct')">{{ multi.sampleSubmitting ? '提交中…' : '提交标注' }}</button>
          </div>
          <p v-if="!consentGiven" class="muted">提交前请先在左侧勾选同意，才会保存这张图。</p>
          <p v-if="multi.sampleError" class="notice error" role="alert">{{ multi.sampleError }}</p>
        </div>
        <p v-if="multi.sampleMessage" class="notice" role="status">{{ multi.sampleMessage }}</p>
      </div>
      <p v-if="multi.error" class="notice error" role="alert">{{ multi.error }}</p>
      <div v-else class="empty-state"><h3>等待你的第一个数字</h3><p>书写或选择图片后，点击识别按钮。这里仅展示服务器返回的结果，不生成示例预测。</p></div>
      <div v-if="state.submitted && !state.loading" class="feedback-inline" aria-live="polite">
        <template v-if="state.result">
          <p class="feedback-question">这个 <strong>{{ state.result.digit }}</strong> 对吗？</p>
          <div class="feedback-actions" v-if="!feedbackDone">
            <button type="button" class="primary" :disabled="feedback.submitting" @click="confirmCorrect">✓ 对，就是 {{ state.result.digit }}</button>
            <button type="button" :disabled="feedback.submitting" @click="feedback.wrongOpen = !feedback.wrongOpen">✗ 不对，实际是…</button>
          </div>
          <div v-if="feedback.wrongOpen && !feedbackDone" class="label-grid compact">
            <button
              v-for="value in FEEDBACK_LABELS"
              :key="value"
              type="button"
              :disabled="feedback.submitting"
              @click="pickCorrect(value)"
            >{{ value }}</button>
          </div>
        </template>
        <template v-else>
          <p class="feedback-question">这次没有给出结果。你实际写的是几？</p>
          <div v-if="!feedbackDone" class="label-grid compact">
            <button
              v-for="value in FEEDBACK_LABELS"
              :key="value"
              type="button"
              :disabled="feedback.submitting"
              @click="pickCorrect(value)"
            >{{ value }}</button>
          </div>
        </template>
        <p v-if="feedback.message" class="notice" role="status">{{ feedback.message }}</p>
        <p v-if="feedback.error" class="notice error" role="alert">{{ feedback.error }}</p>
        <p v-if="!feedbackDone" class="muted"><button type="button" class="link" @click="skipFeedback">跳过这次标注</button></p>
      </div>
      <hr /><p class="muted">{{ pilot ? '切换输入、换图、移除、重画或退出后，旧请求不会覆盖当前结果。' : '空间默认模型由服务器决定。切换空间、输入、换图、移除、重画或退出后，旧请求不会覆盖当前结果。' }}超时后再次点击属于新的识别操作。</p>
    </section>
  </div>
</template>
