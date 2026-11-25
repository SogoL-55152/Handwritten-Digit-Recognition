<script setup>
import { useUserStore } from '@/stores/user.js'
import { appConfig } from '@/app-config.js'
import { navigationLinks } from '@/router/routes.js'
const pilotLinks = navigationLinks({ pilot: true })
const user = useUserStore()
</script>

<template>
  <div v-if="appConfig.pilot" class="public-page">
    <header class="public-header support-header"><router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link><nav aria-label="体验版导航" class="actions"><router-link v-for="[path, label] in pilotLinks" :key="path" :to="path">{{ label }}</router-link></nav></header>
    <main class="portal">
      <section class="hero"><p class="eyebrow">手写数字识别 · 基础体验版</p><h1>写下一个数字，<br />看看模型的答案。</h1><p class="hero-copy">用鼠标、手指或触控笔写一个 0–9。登录后直接进入个人画板，查看真实预测、置信度与处理耗时。</p><div class="actions"><router-link class="button primary" to="/recognize">开始识别</router-link><router-link class="button" to="/register">使用体验码注册</router-link><router-link to="/login">已有账号登录</router-link></div><p class="muted">默认个人空间由服务器核验，无需创建或切换空间。</p></section>
      <aside class="panel portal-note"><h2>一张画板，一个数字</h2><ol class="steps"><li><strong>注册或登录</strong><p>向维护者索取体验码，或使用已有账号。</p></li><li><strong>书写与识别</strong><p>每次写一个数字，点击识别查看结果。</p></li><li><strong>需要帮助？</strong><p><router-link to="/help">使用帮助与人工支持</router-link> · <router-link to="/privacy">隐私与数据留存说明</router-link></p></li></ol></aside>
    </main>
    <footer class="public-footer">基础体验版 · 仅用于手写数字识别，不用于训练</footer>
  </div>
  <div v-else class="public-page">
    <header class="public-header">
      <router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link>
      <nav aria-label="公开导航" class="actions"><router-link to="/login">登录</router-link><router-link class="button primary" to="/register">创建账号</router-link></nav>
    </header>
    <main class="portal">
      <section class="hero">
        <p class="eyebrow">手写数字识别 · W2</p>
        <h1>写下一个数字，<br />看看模型的答案。</h1>
        <p class="hero-copy">在你的工作空间中，用鼠标或触控笔书写 0–9。通过真实的 CNN 基线模型完成识别，查看预测、置信度与使用记录计数。</p>
        <div class="actions"><router-link class="button primary" :to="user.isAuthenticated ? '/recognize' : '/register'">开始识别</router-link><router-link class="button" to="/home">进入工作空间</router-link></div>
        <p class="muted">普通账号即可使用，无需管理员权限。</p>
      </section>
      <aside class="panel portal-note">
        <p class="eyebrow">从书写到结果</p><h2>一张画板，一个数字</h2>
        <ol class="steps"><li><strong>创建账号</strong><p>自动获得个人空间，平台身份与空间角色独立。</p></li><li><strong>选择空间并书写</strong><p>白底画板导出 PNG，经 Java 服务调用模型。</p></li><li><strong>读取真实结果</strong><p>查看预测置信度、模型版本与耗时，不把置信度称为准确率。</p></li></ol>
      </aside>
      <section class="panel portal-scope"><h2>当前开放范围</h2><p>单字识别、公共模型与数据集只读浏览、本人空间用量。训练入口仅校验参数；在线训练、实时曲线、成员邀请和私有资产上传尚未开放。</p></section>
    </main>
    <footer class="public-footer">Digit Studio · CNN 手写数字识别实验项目</footer>
  </div>
</template>
