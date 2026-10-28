# frontend — Vue 3 管理端

Vue 3 + Vite + Element Plus + Pinia + Vue Router。W1 复用登录页、后台布局与首页占位，补齐管理员会话校验；不包含 W2 管理业务页面。

## 本地启动

目标环境为 **Node.js 22+**（以 `package.json` 的 `engines` 为准）。已有依赖时无需重新安装。

```bash
npm install      # 仅首次安装依赖时需要
npm run dev      # http://localhost:5173
```

开发服务器通过 Vite 代理把 `/api` 转发到 `http://localhost:8080`，无需额外配置 CORS。

## 页面与会话

| 路由 | 页面 | 说明 |
|---|---|---|
| `/login` | 管理端登录 | 手动输入管理员账号与密码，无预填密码 |
| `/home` | 管理员首页 | `/auth/me` 确认角色为 `ADMIN` 后可进入，仍为 W1 占位页 |

- 登录后、首个受保护路由以及页面刷新后的首次访问均通过 `GET /api/auth/me` 校验；同一已验证会话内切换路由不重复请求。登录响应和本地 `hdr_user` 均不作为授权依据，旧用户缓存直接清理。
- 普通用户不得进入管理端：清理 token/store，停留登录页并明确提示。登录页始终可访问，不会仅因存在 token 自动跳转形成循环。
- HTTP 401 和响应体 `code: 401` 都会清理当前会话。普通 API 请求通过注入回调触发站内登录导航，不使用 `window.location`，请求模块不反向导入 store/router。
- 网络、服务故障或异常 `/me` 响应不证明 token 无效：保留凭证，但不放行未验证会话。登录页可点击“重试会话校验”，也可“切换账号”主动清理凭证。
- 并发校验共享同一请求。登出/新登录会推进会话版本，旧校验、旧登录和旧请求的 401 都不能覆盖或清除新会话，即使服务器重复签发相同 token。
- 登录后的 `redirect` 只允许已注册、受保护的站内路由；外部地址、协议相对地址、登录页、异常编码等回退 `/home`。
- 页面中的“准确率 ≥ 90%”是**项目目标（待验证）**，不是已完成的模型指标。前端守卫只控制界面入口，后端仍须独立校验身份与权限。

新增页面时：

1. 在 `src/views/` 创建组件
2. 在 `src/router/index.js` 的管理端 `children` 中注册路由，继承 `requiresAuth` / `admin` 元数据
3. 在 `src/layout/AdminLayout.vue` 的 `menuItems` 中追加菜单
4. 接口封装放在 `src/api/`，统一使用 `src/api/request.js`

## 回归测试

```bash
npm test
```

使用 Node 内置 `node:test`，不新增 Vitest / E2E 依赖，不访问真实后端。测试直接调用生产使用的 `src/auth/session.js`、`src/router/auth-guard.js` 和 `src/api/request.js`，通过内存 storage、Vue Router 内存历史和 Axios adapter 注入可控行为。

覆盖未登录拦截、服务端管理员/普通用户角色、伪造/损坏缓存、HTTP/业务 401、网络失败与重试、并发去重、登出和新登录竞态、安全 redirect，以及请求拦截器的会话隔离。此为逻辑回归测试，不替代浏览器与真实后端联调。

本次已在 **Node 22.23.4 / npm 10.9.9** 上运行 `npm test`（43 项通过）及 `npm run build`（通过，有大于 500 kB 的 chunk 提示）。Node 20 的兼容性检查也通过，但最终构建/测试记录以 Node 22 为准。

## 构建

```bash
npm run build    # 在 Node 22+ 目标环境执行，产物位于 dist/
```

Docker 构建见 `Dockerfile`，Nginx 将 `/api` 反代到 `backend:8080`。

## 后续业务范围（非 W1 已实现）

- 概览、用户管理、数据集、模型管理、训练任务、统计看板页面
- 训练过程实时曲线（ECharts / SSE）
- 表格加载骨架、错误态统一组件
