# miniprogram — 微信小程序

手写画板 + 登录 + 上传识别。无需 npm 依赖，直接导入微信开发者工具即可。

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
| `pages/index/index` | Canvas 2D 手写板、清空、上传识别、结果展示 |

## 关键实现

- 画板使用 `type="2d"` 的 Canvas 2D，按设备像素比缩放，避免模糊。
- 白底黑字导出 PNG，服务端预处理会自动反色并与 MNIST 分布对齐。
- 识别通过 `wx.uploadFile` 调用 `POST /api/recognition/predict`，携带 JWT。
- Token 失效（code 401）自动清除本地状态并回到登录页。

## 后续工作

- [ ] 连续多位数识别（W4 选型、W5 实现）
- [ ] 识别历史记录页
- [ ] 登录改为 wx.login + 后端绑定（如需）
