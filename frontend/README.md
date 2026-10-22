# frontend — Vue 3 管理端

Vue 3 + Vite + Element Plus + ECharts + Pinia + Vue Router。

## 本地启动

```bash
npm install
npm run dev      # http://localhost:5173
```

开发服务器通过 Vite 代理把 `/api` 转发到 `http://localhost:8080`，无需额外配置 CORS。

## 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/login` | 登录 | 默认 `admin / admin123` |
| `/dashboard` | 概览 | 关键指标、上手流程 |
| `/users` | 用户管理 | 仅管理员可见，启停账号 |
| `/datasets` | 数据集 | 列表与新建 |
| `/models` | 模型管理 | 切换活跃模型、删除 |
| `/train-tasks` | 训练任务 | 列表、创建任务 |
| `/train-tasks/:id` | 训练详情 | 2s 轮询指标 + ECharts 曲线 |
| `/stats` | 统计分析 | 调用趋势、模型分布 |

## 构建

```bash
npm run build    # 产物位于 dist/
```

Docker 构建见 `Dockerfile`，Nginx 将 `/api` 反代到 `backend:8080`。

## 后续工作（W2–W5）

- [ ] 登录页接入图形验证码（如需要）
- [ ] 训练详情从轮询切换为 SSE
- [ ] 表格加载骨架、错误态统一组件
- [ ] 响应式适配与暗色主题评估
