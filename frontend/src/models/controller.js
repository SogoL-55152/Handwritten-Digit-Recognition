/**
 * 模型管理页的纯逻辑：校验服务端响应、计算按钮可用性、串行化切换操作。
 * 不导入 Vue 或 store，便于在 node --test 下直接验证。
 */
const STATUSES = new Set(['ACTIVE', 'INACTIVE', 'DISABLED'])

export function validateModelList(data) {
  if (!Array.isArray(data) || !data.length) throw new Error('模型列表为空或格式无效')
  return data.map((model) => {
    if (!model || typeof model.id !== 'string' || !model.id) throw new Error('模型条目缺少标识')
    if (typeof model.externalId !== 'string' || typeof model.version !== 'string') throw new Error('模型条目缺少版本信息')
    if (typeof model.preprocessVersion !== 'string' || !model.preprocessVersion) throw new Error('模型条目缺少预处理版本')
    if (!STATUSES.has(model.status)) throw new Error('模型状态无法识别')
    if (typeof model.verified !== 'boolean') throw new Error('模型条目缺少注册表校验结果')
    return model
  })
}

export function summarize(model) {
  return {
    id: model.id,
    title: `${model.externalId} · ${model.version}`,
    status: model.status,
    statusLabel: { ACTIVE: '生效中', INACTIVE: '待启用', DISABLED: '已停用' }[model.status],
    preprocessVersion: model.preprocessVersion,
    artifact: model.artifact || '未登记',
    digest: model.sha256 ? `${model.sha256.slice(0, 12)}…` : '未登记',
    sizeLabel: Number.isFinite(model.sizeBytes) ? `${(model.sizeBytes / 1024 / 1024).toFixed(2)} MiB` : '未登记',
    registryLabel: model.verified ? '文件摘要已校验' : `注册表不可用（${model.registryReason || '原因未提供'}）`
  }
}

export function canActivate(model) {
  return Boolean(model) && model.status !== 'ACTIVE' && model.verified === true
}

export function canDisable(model) {
  return Boolean(model) && model.status === 'ACTIVE'
}

export function canDelete(model) {
  return Boolean(model) && model.status !== 'ACTIVE'
}

/**
 * 切换是互斥操作：同一时刻只允许一个请求在飞，避免并发点击产生两次切换。
 */
export function createModelAdmin({ api, getSession }) {
  let pending = null
  async function run(action, task) {
    if (pending) throw new Error('上一次模型操作尚未完成')
    pending = action
    try { return await task() } finally { pending = null }
  }
  return {
    pending: () => pending,
    async list() {
      return validateModelList(await api.listModels(getSession()))
    },
    async activate(id) {
      return run('activate', async () => {
        const updated = await api.activateModel(id, getSession())
        if (!updated || updated.status !== 'ACTIVE') throw new Error('服务端未确认该模型已生效')
        return updated
      })
    },
    async disable(id) {
      return run('disable', () => api.disableModel(id, getSession()))
    },
    async remove(id) {
      return run('delete', () => api.deleteModel(id, getSession()))
    },
    async reloadRegistry() {
      return run('reload', () => api.reloadRegistry(getSession()))
    }
  }
}
