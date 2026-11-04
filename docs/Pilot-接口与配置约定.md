# 基础体验版接口与配置约定

2026-11-04，本地候选版；当前无服务器、域名或微信发布账号。沿用W2的 `/api/v2` 与真实HTTP/envelope，不改变模型和图片协议。

## 账号

- `POST /auth/register`：`{username,password,nickname?,pilotCode?}`。pilotCode仅用户输入，不能硬编码/缓存/日志记录；服务器pilot模式必验，未配置关闭注册。成功201，沿用 `{token,user,defaultWorkspaceId}`。
- 新注册username 3–32，password 6–32；禁止空白字符：U+0009–000D、U+0020、U+0085、U+00A0、U+1680、U+2000–200A、U+2028–2029、U+202F、U+205F、U+3000、U+FEFF。拒绝，不自动trim。昵称≤64。
- `POST /auth/login` 保持旧规则（非全空白、原有长度），**不trim或新增内部空白限制**。
- `POST /auth/password`，Bearer认证：`{currentPassword,newPassword}`。currentPassword按旧登录规则，newPassword按新注册密码规则；200 data=null。成功撤销该用户所有会话，客户端清缓存回登录；原密码错误400（不清会话）；失效会话401；限流429。不自动重试。
- pilot拒绝 `POST /workspaces`（403），注册创建个人空间不受影响；读取空间/识别仍核验成员。默认自动选服务器defaultWorkspaceId，不硬编码。

## 模式与公开配置

- 后端 `hdr.pilot.enabled` / env `HDR_PILOT_ENABLED` 默认false；`application-pilot.yml`设true。`PILOT_REGISTRATION_CODE`只在服务端，空值关闭pilot注册。
- 网页 `VITE_APP_MODE=development|pilot`（默认development），公开展示字段 `VITE_PILOT_OPERATOR`、`VITE_PILOT_CONTACT`、`VITE_PILOT_PRIVACY_VERSION`。这些不是秘密；绝不添加VITE_*注册码或内部token。
- 小程序 `config/runtime.js` 解析wx envVersion（develop/trial/release）及生成的公开配置。开发默认development+loopback；trial/release仅pilot+真实配置的HTTPS origin，未知环境/缺失/示例域名/loopback禁止联网。会话候选缓存绑定origin，地址改变清旧会话；开发测试兼容注入配置。
- `miniprogram/config/public.js` 作为公开配置模板（不改AppID），导出 `{mode:'development',apiBaseUrl:'http://127.0.0.1:8080',operator:'',contact:'',privacyVersion:''}`。打包脚本仅覆盖新输出目录副本为pilot配置，排除开发原型等。
- 发布缺少operator/contact/privacyVersion时阻止；本地UI显示未配置，不冒充正式隐私主体。

## 最小界面

pilot：画板、账号（改密/退出）、帮助/隐私。登录后直达画板；技术ID和版本折叠。开发模式保留W2路线/空间和原型。pilot直接访问隐藏路线也回允许入口；后端权限不依赖UI隐藏。

小程序新增同API注册，确认密码在客户端检查、不提交；无需PC预先注册。保留全部generation/revision过期保护，敏感输入结束/隐藏后清除。匿名开发原型零网络。

说明真实数据用途：仅数字识别；存账号/哈希/会话和识别元数据/摘要，不长期存原图、不用于训练、不收集手机号/相册/位置。传输临时文件、日志和备份另说明。试用参考留存：识别元数据30天，日志和备份7天；说明由维护者执行，实际分享前必须确认流程，不能承诺不存在的自动清理。找回/删除通过联系维护者核验办理，退出不是删除账号。

## 验证

不得改写W2历史结果/证据；pilot新测试和发布清单独立保存。静态打包/本地测试不等于微信工具、真机、HTTPS上线或审核通过。
