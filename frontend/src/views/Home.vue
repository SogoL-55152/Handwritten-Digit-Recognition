<script setup>
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="welcome">
      <h2>欢迎，{{ userStore.displayName }}</h2>
      <p>当前为工程骨架，业务页面由各成员在各自的 feature 分支中实现。</p>
      <ul>
        <li>路由注册：<code>src/router/index.js</code></li>
        <li>页面目录：<code>src/views/</code></li>
        <li>接口封装：<code>src/api/</code></li>
      </ul>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  padding: 24px;
}

.welcome {
  max-width: 720px;
}

.welcome h2 {
  margin: 0 0 12px;
}

.welcome p {
  color: #6b7280;
}

.welcome ul {
  margin: 16px 0 0;
  padding-left: 20px;
  line-height: 2;
  color: #4a5568;
}

code {
  padding: 2px 6px;
  border-radius: 4px;
  background: #f1f5f9;
  font-size: 13px;
}
</style>
