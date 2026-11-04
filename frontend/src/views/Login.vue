<script setup>
import { computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user.js'
import { SESSION_MESSAGES } from '@/auth/session.js'
import { createAuthFormController } from '@/auth/form-controller.js'
import { safeRedirect } from '@/router/auth-guard.js'
import { appConfig } from '@/app-config.js'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const pilot = appConfig.pilot
const registering = computed(() => route.path === '/register')
const controller = createAuthFormController({ session: user, registering: () => registering.value, pilot, reactive,
  onAuthenticated: () => router.replace(safeRedirect(route.query.redirect, (value) => router.resolve(value), appConfig)) })
const state = controller.state
const form = state.form
const sessionMessage = computed(() => SESSION_MESSAGES[user.reason || route.query.reason] || '')
watch(() => route.path, controller.reset)
function hideSensitive() { if (document.hidden) controller.clearSensitive() }
onMounted(() => document.addEventListener('visibilitychange', hideSensitive))
onUnmounted(() => { document.removeEventListener('visibilitychange', hideSensitive); controller.dispose() })
</script>

<template>
  <div class="public-page">
    <header class="public-header"><router-link class="brand" to="/"><span class="brand-mark">D</span> Digit Studio</router-link><router-link to="/">返回门户</router-link></header>
    <main class="auth-grid">
      <section v-if="pilot" class="auth-intro"><p class="eyebrow">手写数字识别 · 基础体验版</p><h1>{{ registering ? '创建你的体验账号。' : '欢迎回来。' }}</h1><p>登录后直接进入画板。默认个人空间由服务器核验，无需手动选择。</p><p>注册需向维护者索取体验码；体验码仅用于本次注册，不保存在本地。</p><p><router-link to="/help">使用帮助</router-link> · <router-link to="/privacy">隐私说明与人工支持</router-link></p></section>
      <section v-else class="auth-intro"><p class="eyebrow">你的数字识别工作空间</p><h1>{{ registering ? '从一个个人空间开始。' : '欢迎回来。' }}</h1><p>一个账号，独立的工作空间。普通用户可以直接书写和识别，空间访问资格由服务器实时确认。</p><p class="muted">W2 提供可信公共基线，不开放私有资产上传或在线训练。</p></section>
      <section class="panel auth-panel">
        <h2>{{ registering ? '创建普通账号' : '登录账号' }}</h2>
        <p class="muted">{{ registering ? '注册成功后自动创建个人空间，并校验新会话。' : pilot ? '登录后即可书写和识别。' : '登录后校验 v2 会话，不信任本地缓存角色。' }}</p>
        <p v-if="state.error" role="alert" class="notice error">{{ state.error }}</p>
        <p v-if="sessionMessage" role="status" class="notice">{{ sessionMessage }}</p>
        <p v-if="user.logoutWarning" role="status" class="notice">{{ user.logoutWarning }}</p>
        <div v-if="user.token" class="stack">
          <p>已有凭证。可继续校验会话，或退出后切换账号。</p>
          <button class="primary" :disabled="state.loading" @click="controller.run(true)">{{ state.loading ? '校验中…' : '继续 / 重试会话校验' }}</button>
          <button @click="controller.switchAccount">退出并切换账号</button>
        </div>
        <form v-else class="stack" @submit.prevent="controller.run()">
          <label>用户名<input v-model="form.username" name="username" autocomplete="username" required minlength="3" maxlength="32" :disabled="state.loading" :placeholder="registering ? '3–32 个非空白字符' : '请输入原用户名（不自动去空白）'" /></label>
          <label v-if="registering">昵称（可选）<input v-model="form.nickname" name="nickname" autocomplete="nickname" maxlength="64" :disabled="state.loading" /></label>
          <label>密码<input v-model="form.password" name="password" type="password" :autocomplete="registering ? 'new-password' : 'current-password'" required minlength="6" maxlength="32" :disabled="state.loading" :placeholder="registering ? '6–32 个非空白字符' : '请输入原密码'" /></label>
          <template v-if="pilot && registering">
            <label>确认密码<input v-model="form.confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="32" :disabled="state.loading" /></label>
            <label>体验码<input v-model="form.pilotCode" name="pilotCode" type="password" autocomplete="off" required :disabled="state.loading" placeholder="请向维护者索取" /></label>
            <p class="muted">提交注册前请阅读<router-link to="/privacy">隐私说明</router-link>。确认密码仅在本页核对，不提交给服务器。</p>
          </template>
          <button type="submit" class="primary" :disabled="state.loading">{{ state.loading ? '校验会话中…' : registering ? '注册并进入' : '登录' }}</button>
        </form>
        <p class="auth-switch"><router-link :to="{ path: registering ? '/login' : '/register', query: route.query.redirect ? { redirect: route.query.redirect } : {} }">{{ registering ? '已有账号？去登录' : '还没有账号？创建普通账号' }}</router-link></p>
      </section>
    </main>
  </div>
</template>
