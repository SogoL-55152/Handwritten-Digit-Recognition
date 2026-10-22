<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const formRef = ref()
const loading = ref(false)
const form = reactive({ username: 'admin', password: 'admin123' })

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

async function submit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  loading.value = true
  try {
    await userStore.login(form)
    ElMessage.success('登录成功')
    router.push(route.query.redirect || '/dashboard')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-panel">
      <section class="intro">
        <div class="logo">手写数字识别系统</div>
        <h1>从书写到识别<br />只需一次点击</h1>
        <p>CNN 模型训练 · 多模型管理 · 实时训练可视化 · 识别统计</p>
        <div class="badges">
          <span>准确率 ≥ 90%</span>
          <span>微信小程序</span>
          <span>Spring Boot + Flask</span>
        </div>
      </section>

      <el-card class="login-card" shadow="never">
        <h2>管理端登录</h2>
        <p class="muted">使用管理员账号进入后台</p>
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @keyup.enter="submit">
          <el-form-item label="用户名" prop="username">
            <el-input v-model="form.username" placeholder="请输入用户名" />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input v-model="form.password" type="password" show-password placeholder="请输入密码" />
          </el-form-item>
          <el-button type="primary" class="submit" :loading="loading" @click="submit">
            登录
          </el-button>
        </el-form>
        <p class="hint">默认管理员：admin / admin123（首次登录后请修改）</p>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 32px;
  background:
    radial-gradient(circle at 10% 20%, rgba(59, 110, 246, 0.18), transparent 45%),
    radial-gradient(circle at 90% 80%, rgba(83, 190, 255, 0.2), transparent 45%),
    #0f172a;
}

.login-panel {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) 380px;
  gap: 56px;
  width: min(980px, 100%);
  align-items: center;
}

.intro {
  color: #e2e8f0;
}

.logo {
  display: inline-block;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  font-size: 13px;
  letter-spacing: 1px;
}

.intro h1 {
  margin: 24px 0 16px;
  font-size: 40px;
  line-height: 1.25;
  color: #ffffff;
}

.intro p {
  color: #94a3b8;
  line-height: 1.8;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.badges span {
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
  font-size: 12px;
}

.login-card {
  border: none;
  border-radius: 16px;
}

.login-card h2 {
  margin: 0 0 4px;
  font-size: 22px;
}

.login-card .muted {
  margin: 0 0 20px;
}

.submit {
  width: 100%;
  margin-top: 4px;
}

.hint {
  margin: 18px 0 0;
  font-size: 12px;
  color: #98a2b3;
  text-align: center;
}

@media (max-width: 820px) {
  .login-panel {
    grid-template-columns: 1fr;
    gap: 28px;
  }

  .intro h1 {
    font-size: 28px;
  }
}
</style>
