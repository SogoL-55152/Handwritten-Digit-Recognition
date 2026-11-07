<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
import { recognize } from '@/api/workspaces.js'
import { createDrawingBoard } from '@/recognition/drawing-board.js'
import { createRecognitionController } from '@/recognition/controller.js'
import { prepareImage } from '@/recognition/image-import.js'
import { appConfig } from '@/app-config.js'
const pilot = appConfig.pilot

const canvas = ref(null)
const user = useUserStore()
const workspace = useWorkspaceStore()
const boardError = ref('')
let board, observer
const controller = createRecognitionController({ session: user, workspace, exportPng: () => board.exportPng(), prepareImage, send: recognize, reactive })
const state = controller.state
const canSubmit = computed(() => (state.inputKind === 'image' || !boardError.value) && controller.canSubmit())
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
        <button data-testid="recognition-submit" class="primary" :disabled="!canSubmit" @click="controller.submit()">{{ state.loading ? '识别中…' : state.inputKind === 'image' ? '识别图片' : '识别数字' }}</button>
        <button v-if="state.inputKind === 'image'" data-testid="image-remove" :disabled="!state.image && !state.validating" @click="controller.removeImage()">移除图片</button>
        <button v-else @click="board?.clear()">清空画板</button>
      </div>
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
      <div v-else class="empty-state"><h3>等待你的第一个数字</h3><p>书写或选择图片后，点击识别按钮。这里仅展示服务器返回的结果，不生成示例预测。</p></div>
      <hr /><p class="muted">{{ pilot ? '切换输入、换图、移除、重画或退出后，旧请求不会覆盖当前结果。' : '空间默认模型由服务器决定。切换空间、输入、换图、移除、重画或退出后，旧请求不会覆盖当前结果。' }}超时后再次点击属于新的识别操作。</p>
    </section>
  </div>
</template>
