<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { appConfig } from '@/app-config.js'
import { navigationLinks } from '@/router/routes.js'
const route = useRoute()
const pilot = appConfig.pilot
const privacy = computed(() => route.path === '/privacy')
const links = navigationLinks({ pilot })
</script>

<template>
  <div class="public-page">
    <header class="public-header support-header">
      <router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link>
      <nav class="actions" :aria-label="pilot ? '体验版导航' : '帮助导航'"><router-link v-for="[path, label] in links" :key="path" :to="path">{{ label }}</router-link></nav>
    </header>
    <main class="support-content stack">
      <section class="panel">
        <h1>{{ privacy ? '隐私说明' : '使用帮助' }}</h1>
        <dl class="details"><dt>维护 / 运营主体</dt><dd>{{ appConfig.operator || '未配置：尚未提供真实维护 / 运营主体' }}</dd><dt>人工联系方式</dt><dd>{{ appConfig.contact || '未配置：暂无可用的公开支持渠道，请联系向你提供体验入口的维护者' }}</dd><dt>隐私说明版本</dt><dd>{{ appConfig.privacyVersion || '未配置：当前仅为本地候选说明' }}</dd></dl>
        <p v-if="!appConfig.operator || !appConfig.contact || !appConfig.privacyVersion" class="notice" role="status">公开信息未配置完整。当前不是已准备好对外发布的服务，也不表示已经上线、备案或审核通过。</p>
      </section>

      <template v-if="privacy">
        <section class="panel"><h2>用途与存储范围</h2><p>本服务仅用于手写数字识别。保存账号信息、密码哈希、会话，以及识别元数据 / 图片摘要；图片用于本次推理，不长期保存原图，不用于训练。不收集手机号或位置。导入时仅在你明确选择后处理那一张图片，不扫描或批量读取相册；网页预览在本地，点击“识别图片”才上传原始文件。移除、切换输入、空间 / 账号或离开识别页会释放本地预览引用，不会删除你原有的图片。</p><p>传输过程中可能产生临时文件；运行日志与数据库备份是独立的运维数据，不应将“不长期保存原图”理解为没有临时文件、日志或备份。维护者须在实际分享前核查临时文件清理、日志脱敏及备份访问与清理流程。</p></section>
        <section class="panel"><h2>留存与人工处理</h2><p>试用参考留存：识别元数据 30 天，日志和备份 7 天。由维护者按实际运行流程执行，不是已实现的自动清理承诺；实际对外分享前必须确认执行责任与清理流程。</p><p>账号找回、账号 / 数据删除申请均通过上述联系方式，由维护者核验后人工办理。没有自助找回或自动删除功能，也不承诺未经确认的处理时限。退出登录不等于删除账号。</p></section>
      </template>

      <!-- 基础体验版（pilot）：保留原有说明 -->
      <template v-else-if="pilot">
        <section class="panel"><h2>开始体验</h2><ol class="steps"><li><strong>注册或登录</strong><p>注册使用维护者提供的体验码，并核对两次密码；已有账号直接登录。若注册关闭，请联系维护者，不要尝试猜测体验码。</p></li><li><strong>书写或导入一个 0–9</strong><p>登录后自动核验默认个人空间。使用鼠标、手指或触控笔在画板居中写大一点，点击“识别数字”；也可切换“导入图片”，选择一张 PNG / JPEG（≤5 MiB，最长边 ≤2048 像素），本地校验与预览后点击“识别图片”才上传。仅处理你选择的这一张图片，不扫描或批量读取相册。不支持多数字 OCR，不保证复杂背景照片的识别效果。</p></li><li><strong>查看结果</strong><p>显示预测数字、置信度和处理耗时。置信度是模型评分，不等于识别准确率。不确定输入可能被拒识，但拒识不能保证拦截所有非数字或复杂照片。换图、移除、切换输入、清空或重画使旧结果失效；需明确点击识别，不会自动重发请求。</p></li></ol></section>
        <section class="panel"><h2>遇到问题</h2><p>登录失效时重新登录；网络故障可稍后手动操作。默认空间不可用、注册受限或请求限流时，请按提示等待或联系维护者。不要向维护者发送密码、体验码或会话凭证。</p><p>忘记密码、账号找回、删除账号 / 数据，通过上方人工联系方式核验办理。退出只结束当前会话，不会删除账号。数据用途、留存与人工清理责任见<router-link to="/privacy">隐私说明</router-link>。</p></section>
      </template>

      <!-- 完整版（development）：面向真实功能的使用手册 -->
      <template v-else>
        <section class="panel"><h2>手写识别</h2><ol class="steps"><li><strong>写一个数字</strong><p>登录后选择一个空间，进入「手写识别」页。用鼠标、手指或触控笔在画板居中写大一点，每个数字之间留空隙，点击“识别数字”。</p></li><li><strong>一次识别多位</strong><p>勾选「多位数识别」并选择最多几位（1–4），间隔书写后点击“识别多位数字”。结果会显示整串和每个位置的置信度；低于阈值的位会标红，建议重写。多位数识别会写入识别历史。</p></li><li><strong>导入图片</strong><p>切换「导入图片」，选择一张 PNG / JPEG（≤5 MiB，最长边 ≤2048 像素）。图片应只含一个清晰的数字，或 1–4 个间隔书写的数字。可点「查看预处理效果」预览白底黑字、笔画加粗后的实际输入；点击“识别图片”才上传原始文件，不压缩或重新编码。</p></li><li><strong>结果与标注</strong><p>识别结果会显示数字、置信度与处理耗时；置信度是模型评分，不等于识别准确率。结果下方可以反馈“对 / 不对”，勾选同意后这些图片与你的标注会用于模型评估与改进（勾选一次长期有效，可随时取消）。</p></li></ol></section>
        <section class="panel"><h2>数据集与训练</h2><ol class="steps"><li><strong>准备数据</strong><p>「数据集」页新建数据集，导入文件夹 / CSV / zip / IDX（MNIST、EMNIST）等；导入成功会自动生成一个数据版本（快照）。</p></li><li><strong>发起训练</strong><p>「训练」页 →「发起训练」：先选数据版本，再定微调起点与参数。第一次建议直接用「快速上手」模板；参数改动会即时显示耗时与内存估算。</p></li><li><strong>看进度与结果</strong><p>提交后在「训练记录」看准备数据进度、逐轮准确率与损失曲线、三域评估（MNIST / 画板模拟 / 照片模拟）与混淆矩阵。</p></li><li><strong>上线新模型</strong><p>训练成功的新模型在「模型管理」页注册与激活后，识别接口即切换到新模型；也可以随时切回旧模型。</p></li></ol></section>
        <section class="panel"><h2>遇到问题</h2><p>登录失效时重新登录；网络故障可稍后手动操作。空间不可用、注册受限或请求限流时，请按提示等待或联系维护者。不要向维护者发送密码或会话凭证。</p><p>忘记密码、账号找回、删除账号 / 数据，通过上方人工联系方式核验办理。退出只结束当前会话，不会删除账号。数据用途、留存与人工清理责任见<router-link to="/privacy">隐私说明</router-link>。</p></section>
      </template>
    </main>
  </div>
</template>
