# miniprogram — 微信小程序

登录 + 首页占位。当前为工程骨架，手写画板与识别功能待实现。

## 运行

1. 打开微信开发者工具 → 导入项目，目录选择 `miniprogram/`。
2. AppID 可使用测试号（项目已填 `touristappid`）。
3. 在「详情 → 本地设置」勾选 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**（本地 HTTP 调试必需）。
4. 确认后端已启动（默认 `http://localhost:8080`）。

真机调试时，把 [`app.js`](app.js) 中的 `baseUrl` 改为电脑的局域网 IP：

```js
baseUrl: 'http://192.168.1.10:8080'
```

手机与电脑需在同一局域网，且防火墙放行 8080 端口。

## 页面

| 页面 | 说明 |
|---|---|
| `pages/login/login` | 登录（演示账号 admin / admin123） |
| `pages/index/index` | 首页占位，展示当前用户 |

## 现有能力

- `utils/request.js` 封装 `request()` 与 `uploadFile()`，自动携带 JWT
- 401 自动清除本地登录状态并回到登录页
- 登录成功后 token / 用户信息写入本地存储

## 待各成员实现

- Canvas 2D 手写画板
- 单字识别与连续多位数识别
- 识别历史记录页
