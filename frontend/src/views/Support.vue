<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { appConfig } from '@/app-config.js'
import { navigationLinks } from '@/router/routes.js'
const route = useRoute()
const privacy = computed(() => route.path === '/privacy')
const links = navigationLinks({ pilot: true })
</script>

<template>
  <div class="public-page">
    <header class="public-header support-header">
      <router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link>
      <nav class="actions" aria-label="体验版导航"><router-link v-for="[path, label] in links" :key="path" :to="path">{{ label }}</router-link></nav>
    </header>
    <main class="support-content stack">
      <section class="panel">
        <h1>{{ privacy ? '隐私说明' : '使用帮助' }}</h1>
        <dl class="details"><dt>维护 / 运营主体</dt><dd>{{ appConfig.operator || '未配置：尚未提供真实维护 / 运营主体' }}</dd><dt>人工联系方式</dt><dd>{{ appConfig.contact || '未配置：暂无可用的公开支持渠道，请联系向你提供体验入口的维护者' }}</dd><dt>隐私说明版本</dt><dd>{{ appConfig.privacyVersion || '未配置：当前仅为本地候选说明' }}</dd></dl>
        <p v-if="!appConfig.operator || !appConfig.contact || !appConfig.privacyVersion" class="notice" role="status">公开信息未配置完整。当前不是已准备好对外发布的服务，也不表示已经上线、备案或审核通过。</p>
      </section>
      <template v-if="privacy">
        <section class="panel"><h2>用途与存储范围</h2><p>本服务仅用于手写数字识别。保存账号信息、密码哈希、会话，以及识别元数据 / 图片摘要；图片用于本次推理，不长期保存原图，不用于训练。不收集手机号、相册或位置。</p><p>传输过程中可能产生临时文件；运行日志与数据库备份是独立的运维数据，不应将“不长期保存原图”理解为没有临时文件、日志或备份。维护者须在实际分享前核查临时文件清理、日志脱敏及备份访问与清理流程。</p></section>
        <section class="panel"><h2>留存与人工处理</h2><p>试用参考留存：识别元数据 30 天，日志和备份 7 天。由维护者按实际运行流程执行，不是已实现的自动清理承诺；实际对外分享前必须确认执行责任与清理流程。</p><p>账号找回、账号 / 数据删除申请均通过上述联系方式，由维护者核验后人工办理。没有自助找回或自动删除功能，也不承诺未经确认的处理时限。退出登录不等于删除账号。</p></section>
      </template>
      <template v-else>
        <section class="panel"><h2>开始体验</h2><ol class="steps"><li><strong>注册或登录</strong><p>注册使用维护者提供的体验码，并核对两次密码；已有账号直接登录。若注册关闭，请联系维护者，不要尝试猜测体验码。</p></li><li><strong>书写一个 0–9</strong><p>登录后自动核验默认个人空间。使用鼠标、手指或触控笔在画板居中写大一点，点击“识别数字”。不支持多字识别。</p></li><li><strong>查看结果</strong><p>显示预测数字、置信度和处理耗时。置信度是模型评分，不等于识别准确率。清空或重画后重新提交；不会自动重发请求。</p></li></ol></section>
        <section class="panel"><h2>遇到问题</h2><p>登录失效时重新登录；网络故障可稍后手动操作。默认空间不可用、注册受限或请求限流时，请按提示等待或联系维护者。不要向维护者发送密码、体验码或会话凭证。</p><p>忘记密码、账号找回、删除账号 / 数据，通过上方人工联系方式核验办理。退出只结束当前会话，不会删除账号。数据用途、留存与人工清理责任见<router-link to="/privacy">隐私说明</router-link>。</p></section>
      </template>
    </main>
  </div>
</template>
