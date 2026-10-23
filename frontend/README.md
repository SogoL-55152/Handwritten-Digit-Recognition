# frontend — Vue 3 管理端

Vue 3 + Vite + Element Plus + Pinia + Vue Router。当前为工程骨架：登录页、路由守卫、后台布局与首页占位。

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
| `/home` | 首页 | 骨架占位，展示当前登录用户 |

新增页面时：

1. 在 `src/views/` 创建组件
2. 在 `src/router/index.js` 的 `children` 中注册路由
3. 在 `src/layout/AdminLayout.vue` 的 `menuItems` 中追加菜单
4. 接口封装放在 `src/api/`，统一使用 `src/api/request.js`

## 构建

```bash
npm run build    # 产物位于 dist/
```

Docker 构建见 `Dockerfile`，Nginx 将 `/api` 反代到 `backend:8080`。

## 待各成员实现

- 概览、用户管理、数据集、模型管理、训练任务、统计看板页面
- 训练过程实时曲线（ECharts / SSE）
- 表格加载骨架、错误态统一组件
