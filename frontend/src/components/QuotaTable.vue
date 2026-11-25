<script setup>
defineProps({ limits: { type: Object, required: true } })
</script>

<template>
  <div class="table-wrap"><table><caption>限额与功能配置（只读）</caption><thead><tr><th>项目</th><th>配置值</th><th>执行 / 计量状态</th></tr></thead><tbody>
    <tr><td>每账号创建空间上限</td><td>{{ limits.maxWorkspaces ?? '未提供' }}</td><td>服务器限制，含个人空间</td></tr>
    <tr><td>每空间成员上限</td><td>{{ limits.maxMembers ?? '未提供' }}</td><td>配置保留；W2 未开放邀请</td></tr>
    <tr><td>单图上传上限</td><td>{{ limits.imageMaxBytes ?? '未提供' }} bytes</td><td>已执行；请求另受 6 MiB 上限约束</td></tr>
    <tr><td>每分钟识别限制</td><td>{{ limits.recognitionPerMinute ?? '未提供' }}</td><td>服务器限流；超限返回 429</td></tr>
    <tr><td>每日识别预算</td><td>{{ limits.dailyRecognitionLimit ?? '未提供' }}</td><td>{{ limits.dailyQuotaEnforced === true ? '已执行' : limits.dailyQuotaEnforced === false ? '未启用（enforced=false）' : '状态未提供' }}</td></tr>
    <tr><td>今日剩余额度</td><td>{{ limits.dailyQuotaEnforced === true && limits.remainingDaily != null ? limits.remainingDaily : '不可用' }}</td><td>{{ limits.dailyQuotaEnforced === false ? '不是已执行的日额度账本' : '以服务端计量为准' }}</td></tr>
    <tr><td>在线训练</td><td>{{ limits.trainingAvailable === true ? '可用' : '不可用' }}</td><td>W2 仅参数校验原型，不生成任务</td></tr>
    <tr><td>存储计量</td><td>{{ limits.storageMeteringAvailable === true ? '可用' : '不可用' }}</td><td>未接入时不显示假 0 或无限额度</td></tr>
  </tbody></table></div>
</template>
