<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user.js'
import { useWorkspaceStore } from '@/stores/workspace.js'
const user = useUserStore()
const workspace = useWorkspaceStore()
const route = useRoute()
const name = ref('')
async function create() { if (await workspace.createSpace(name.value)) name.value = '' }
</script>

<template>
  <div class="stack wide-gap">
    <p v-if="route.query.denied === 'platform'" role="alert" class="notice">平台运营仅限 SUPER_ADMIN。你的普通用户会话仍然有效，可以继续使用工作空间。</p>
    <section class="panel welcome"><h2>欢迎，{{ user.displayName }}</h2><p>选择一个工作空间，开始识别。平台角色不授予任何空间的访问权；空间角色以服务器返回的成员资格为准。</p><div class="actions"><router-link class="button primary" to="/recognize">打开画板</router-link><router-link class="button" to="/assets">浏览公共基线</router-link></div></section>
    <section class="panel">
      <div class="section-heading"><h2>我的空间</h2><button :disabled="workspace.loading || workspace.creating" @click="workspace.load()">刷新列表</button></div>
      <p class="muted">仅显示当前账号有效加入的空间。创建后自动成为 OWNER；每账号最多创建 3 个（含个人空间），由服务器执行限制。</p>
      <div class="table-wrap"><table><thead><tr><th>空间名称</th><th>我的角色</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in workspace.items" :key="item.id"><td>{{ item.name }}<small class="cell-detail">ID {{ item.id }}</small></td><td>{{ item.role }}</td><td>{{ item.status }}</td><td><button :disabled="workspace.loading || workspace.creating || workspace.active?.id === item.id" @click="workspace.select(item.id)">{{ workspace.active?.id === item.id ? '当前空间' : '选择空间' }}</button></td></tr><tr v-if="!workspace.items.length"><td colspan="4">{{ workspace.loading ? '加载中…' : '暂无可用空间，可重试或创建空间。' }}</td></tr></tbody></table></div>
      <form class="create-space" @submit.prevent="create"><label>新空间名称<input v-model="name" required maxlength="64" placeholder="例如：数字识别实验" /></label><button class="primary" type="submit" :disabled="workspace.creating || workspace.loading || workspace.selecting">{{ workspace.creating ? '创建中…' : '创建空间' }}</button></form>
    </section>
  </div>
</template>
