<script setup>
import { onMounted, onUnmounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user.js'
import { createPasswordController } from '@/auth/password-controller.js'

const user = useUserStore()
const router = useRouter()
const controller = createPasswordController({ session: user, reactive,
  onReauthenticate: (reason) => router.replace({ path: '/login', query: { reason } }) })
const state = controller.state
function hideSensitive() { if (document.hidden) controller.clearSensitive() }
onMounted(() => document.addEventListener('visibilitychange', hideSensitive))
onUnmounted(() => { document.removeEventListener('visibilitychange', hideSensitive); controller.dispose() })
function logout() { void user.logout(); void router.replace('/login') }
</script>

<template>
  <section class="panel account-panel">
    <h2>修改密码</h2>
    <p>当前账号：{{ user.displayName }}</p>
    <p>修改成功后，服务器会撤销此账号在所有设备上的会话，当前页面也会退出。请用新密码重新登录。</p>
    <p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p>
    <form class="stack" @submit.prevent="controller.submit()">
      <label>原密码<input v-model="state.form.currentPassword" name="currentPassword" type="password" autocomplete="current-password" required minlength="6" maxlength="32" :disabled="state.loading" placeholder="原样输入，保留旧密码中的空白" /></label>
      <label>新密码<input v-model="state.form.newPassword" name="newPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="32" :disabled="state.loading" placeholder="6–32 个字符，不允许空白字符" /></label>
      <button type="submit" class="primary" :disabled="state.loading">{{ state.loading ? '正在修改…' : '修改密码并重新登录' }}</button>
    </form>
    <p class="muted">此操作不会自动重试。原密码错误不会退出账号；请求超时不代表修改失败，请先尝试重新登录或联系维护者核实。</p>
    <hr />
    <h2>退出与人工支持</h2>
    <p>退出登录只结束当前会话，不会删除账号或识别记录。忘记密码、申请删除账号或数据，请通过<router-link to="/help">帮助页</router-link>联系维护者核验办理。</p>
    <button @click="logout">退出登录</button>
  </section>
</template>
