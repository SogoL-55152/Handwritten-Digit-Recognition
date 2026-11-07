# miniprogram — 微信小程序

同平台账号注册/登录、个人空间手写或导入图片识别、改密/退出、帮助与隐私说明。普通 USER / MEMBER 可以使用，不要求管理员。**免登录W1画板已取消**，识别必须先登录；共用Canvas组件和识别功能保留。无历史CRUD、私有资产或训练功能，无需先在PC注册。

## 导入图片（本地候选）

- 首页“手写数字 / 导入图片”切换；相册一次选择一张原图，检查后展示本地预览、类型和尺寸，可更换或移除。只有明确点击“识别图片”才生成请求标识并上传，选择/预览不调用 UUID 或识别接口。图片模式不要求 Canvas 初始化成功。
- `utils/image-import.js` 优先 `wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album'],sizeType:['original']})`；仅 API 不存在时使用 `wx.chooseImage`，仍只相册、原图。不因取消或权限失败回退，更不调用相机。
- 先读取实际文件大小（最大 5 MiB），最多读取 64 KiB 文件头核验 PNG/JPEG 真实格式及尺寸，再用 `wx.getImageInfo` 检查可打开性、类型与尺寸一致；边长≤2048、总像素≤4194304。扩展名不作依据。头部过长、无法在限额内取得尺寸的 JPEG 会拒绝；不自动压缩、转码或复制来绕过限制。
- 原路径仅在当前页面内用于预览/提交，不写 storage、不存相册，不删除平台拥有的原文件。读取/图片信息各阶段最多 10 秒，原生选图最多 120 秒，取消会立即结束等待，迟到或重复回调不影响新操作。
- 原生选择器引起的第一次 hide/show 仅保留独立选图意图/待核验候选；隐藏照常取消认证和识别，不上传。回调先于或晚于 show 都必须重新通过同账号、同 origin、原空间的 `/me`、空间列表与成员详情核验才可显示和提交。再次隐藏、卸载、退出、模式/空间/账号变化或移除均使旧意图失效；重新选择先清除旧图片和旧结果，取消后不恢复旧图。
- Node v22.23.4 本轮 **432 项通过，0 失败/取消/跳过**：原 311 项全部保留，新增文件校验 51 项、实际 Page/Component 生命周期 68 项、模板/隐私检查 2 项。包含原有未提交的 422 拒识回归。仅 wx/Canvas stub 验证，不代表真实相册/解码、设备 UI、微信隐私配置或 `wx.uploadFile` 已验收。
- 微信开发者工具及真机仍须检查 PNG/JPEG 原图、真实 picker 回调/生命周期、取消/权限/超限、相册隐私声明与授权、上传 multipart 和后端结果。没有相机、多数字 OCR 或复杂背景照片准确率承诺；未修改 AppID 或两个 project 配置，也未发布。

## 拒识提示（新本地功能）

Python接受策略未通过时，Java返回422 `UNRECOGNIZED_INPUT`，小程序提示更换图片或重新书写单个数字，不展示猜测数字，不退出当前账号或自动重试。已补生产Page拒识/清空后的旧响应测试；真实微信工具/设备仍需复测。该实验策略仍有乱画漏拒，不承诺所有非数字都能识别为无效，用户9→7原样例仍待提供，见 [验证与局限](../docs/通用拒识-验证与局限.md)。

### 2026-11-04 演示界面修正

- 登录/注册/账号/识别页删除开发提示，使用普通用户文案；业务页只展示数字、置信度和耗时。
- 蓝色按钮统一92rpx高度、全宽并水平/垂直居中；首页和账号页退出位于右上角。
- 安全UUID优先使用微信原生API，兼容跨realm buffer/视图和Promise回包；不可用时最多一次调用已认证的Java标识接口，不使用Math.random、固定ID或时间戳。
- 本次小程序**309项测试通过**，包括67项UUID适配测试；Java**125项单测通过并打包成功**；打包工具108项通过。已用实际helper模拟原生API不可用，连接真实Java/Python生成标识并识别7成功。**不是微信工具UI或真机验收**。
- 改动后请在微信开发者工具点击“编译”，必要时重新登录，书写后点击“识别这个数字”。后端新增接口需重启Java，本机已更新；AppID/private配置未改。

## 运行与联调

1. 微信开发者工具导入 `miniprogram/`。本次不修改项目实际配置的 AppID；需使用团队已授权的开发者身份。无权限时自行选择工具的测试号入口，不把他人 AppID 当成通用测试号，也不提交个人 AppID 改动。
2. 使用支持Canvas2D的基础库（项目配置为3.5.0）。原生安全随机数API不可用时使用后端兜底，无需安装npm依赖。
3. 登录前只可查看帮助/隐私；免登录画板页面已删除，不能再配置为编译入口。App启动和登录页显示不自动请求认证，即使存在旧会话缓存。
4. **W2 业务**：启动项目 W2 Java API 和真实模型服务，完成团队的数据库/基线准备。可在小程序注册普通账号，或使用已有同平台账号。不预填演示账号或密码，不使用旧 W1 token。
5. `config/public.js` 默认 `mode: 'development'`、`apiBaseUrl: 'http://127.0.0.1:8080'`（不带 `/api/v2`），operator/contact/privacyVersion 均为空。`config/runtime.js` 读取 `wx.getAccountInfoSync().miniProgram.envVersion`；仅确认 develop 环境才允许 development 配置。仅在受控本机开发者工具联调中，可在「详情 → 本地设置」勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。离线帮助不需要此设置。
6. 登录后必须成功核验 `GET /api/v2/auth/me`，再加载 `/workspaces`、核验所选 `/workspaces/{id}`。有缓存时点击「继续上次登录」，不会仅因缓存而进入业务页。每次业务页重新显示也重新核验身份。
7. 在首页书写单个数字，点击「识别这个数字」；或选择「导入图片」从相册选一张图片并预览，再明确点击「识别图片」。查看数字、置信度、耗时；置信度不是准确率。开发配置仍可选择本人空间，pilot自动选择个人空间。

### 真机受控 LAN 设置（需要团队明确准备，不由本次代码自动开放）

- 手机的 `localhost` 是手机自己。若要在 develop + development 下真机联调，仅将本地 `config/public.js` 的 `apiBaseUrl` 改为同一受信局域网内电脑的私网 IP，例如 `http://192.168.1.10:8080`，测试后恢复 loopback 默认；不要提交个人地址。trial/release 不允许此方式。
- 需由操作者明确安排 Java / 反向代理在指定私网网卡可达，使用仅对测试设备/私网来源开放的临时防火墙规则；如果后端当前只绑定 loopback，单改 URL 不会使它可达。本次没有修改服务绑定、Compose 端口、防火墙或域名规则。
- 不使用公网隧道、路由器公网端口映射或全接口无范围放行。只访问统一 Java 入口；不要向手机暴露 MySQL、Redis、Python 内部推理端口或内部凭据。
- 开发者工具不校验域名不代表真机预览/发布可用。真机调试需团队按微信当前调试规则验证；正式发布必须另行配置合法 HTTPS `request` / `uploadFile` 域名，不能以关闭校验替代。

## 页面、接口与状态保护

| 路径 | 说明 |
|---|---|
| `pages/login/login` | 空白凭据输入；v2 登录后 `/me` 核验；缓存会话须显式核验；小程序注册入口 |
| `pages/register/register` | 同 `/api/v2/auth/register` 注册，确认密码只本地校验，用户输入试用注册码，不缓存 |
| `pages/account/account` | 重新 `/me` 核验，修改密码、退出，找回/删除联系说明 |
| `pages/help/help`、`pages/privacy/privacy` | 无需会话与网络的只读说明；维护者/联系方式/版本未配置时如实显示 |
| `config/public.js`、`config/runtime.js` | 公开配置模板、微信环境判定与 fail-closed 域名校验 |
| `pages/index/index` | 受保护识别页；真实成员空间列表/详情核验、空间选择、手写/图片输入、真实结果、退出 |
| `components/drawing-board/drawing-board` | 复用 Canvas 2D 与本地预览；增加 revision/change 和异步导出接口 |
| `utils/session.js` | v2 token 候选缓存、服务端核验、会话/空间代次、过期保护 |
| `utils/request.js` | HTTP + envelope 校验、可取消请求/上传、15 秒预算、无全局过期 toast |
| `utils/recognition.js` | UUID v4 请求标识、空间/结果合同校验 |
| `utils/image-import.js` | 单张相册原图选择、大小/有界文件头/图片信息校验、可取消等待 |

合同以 `../docs/W2-接口实现约定.md` 为准：

- 登录 `POST /api/v2/auth/login`，身份 `GET /api/v2/auth/me`，退出 `POST /api/v2/auth/logout`。退出先发服务器撤销，再立即清本地会话；断网时不能声称服务器撤销成功，旧响应也不能清掉随后新登录。
- 缓存只保存 `hdr_v2_session={token,origin}` 候选，不缓存授权角色、密码或注册码。缺少 origin 的旧候选、服务地址改变或配置失效时清旧会话；旧 token 不会发往新地址。App 启动清除 `hdr_token` / `hdr_user`。身份来自 `/me`，成员列表/空间详情来自服务端；前端选择只是请求上下文，不能替代后端逐请求鉴权。
- `POST /api/v2/workspaces/{wid}/recognitions` 使用 `wx.uploadFile` 的 **`name: 'image'`**、`formData: {source: 'MINIPROGRAM'}`，Bearer 与 `Idempotency-Key: <UUID v4>` 请求头。由平台生成 multipart boundary；不添加第二套正文 requestId。
- 单图 PNG/JPEG 最大 5 MiB，请求 6 MiB、最大边长 2048、总像素 4194304；上传画板 PNG 或已检查的相册 PNG/JPEG 原图，服务端仍负责校验字节、尺寸、空白图和成员权限。不长期保存原图。
- 校验返回 requestId 与本次 UUID 相同、字符串业务 ID、digit 整数 0..9、有限置信度 0..1、非负耗时，以及 W2 固定模型版本 `w1-full-3epoch` / 预处理 `canvas-mnist-v1`。错误/假格式不显示为识别结果。
- 同时检查 HTTP 状态和 `{code,message,data}`，包括代理非 JSON 413；401 只清当前请求所属会话，403/404 不赶普通成员回登录页。429 展示 Retry-After，409 保留冲突消息。超时/断网/409 **不自动重发 POST**，用户明确再次点击才生成新 UUID。
- 请求与上传默认 15 秒（长于 Java 初始 2 秒连接 + 10 秒读取预算），Canvas 导出 10 秒，随机 UUID 生成 3 秒。`abort()` 即使平台不回调也会结束 Promise；服务器已经收到的请求不保证因本地 abort 而撤销。
- 成功、错误、finally 同时检查会话代次、空间代次、画板 revision 与当前操作。切换空间、清空、重画、隐藏/卸载、退出或换账号时，旧导出/请求不能覆盖新预览、结果、错误或 loading；不对旧失败发全局 toast。

### 画板窄接口与 W1 不变量

- `change` 事件：`event.detail={revision,hasInk}`；每次修改增加 revision。
- `getSnapshot()` 返回 `{revision,hasInk,ready,drawing}`；`exportSnapshot()` 返回 Promise，成功值 `{filePath,revision}`。清空/重画/卸载使待导出立即以 `stale` 失败，业务页据此拒绝过期上传。
- 原 `exportImage()` 按钮继续生成本地 PNG 预览，保留错误提示与重复导出保护；新异步接口不主动发 toast。画板组件本身从不请求网络。
- 保留白色不透明背景、黑色圆头圆角笔画、按下实心点、DPR 位图尺寸、多指过滤、抬手/取消分笔不相连、初始化失败重试、空白禁导出、清空重置像素与预览。临时图片不承诺跨页面保存，也不保存到相册。

## 基础体验版 pilot（本地候选）

合同见 `../docs/Pilot-接口与配置约定.md`，W1/W2 历史证据不改写。

- `config/public.js` 只含 `{mode,apiBaseUrl,operator,contact,privacyVersion}` 五个公开字符串字段。源目录保留development+loopback模板；打包只在新输出副本覆盖pilot公开配置。业务和帮助共六个页面，不包含已移除的免登录画板。本次不修改两个 project 配置文件或 AppID，不提供任何真实服务域名/凭据。
- 未知微信环境，trial/release 中的 development 模式、HTTP、IP/loopback、示例/占位域名、无效公开字段或缺少维护者/联系/隐私版本时禁止 request/upload。界面显示配置错误，帮助/隐私仍离线可读。禁止把注册码、内部 token 放入公开配置。
- pilot自动核验并选择默认个人空间，不回退其他空间；不显示空间选择，所有模式业务页使用简洁画板和数字/置信度/耗时结果，不展示开发详情或导出预览。后端仍逐次校验权限。
- 注册 `POST /api/v2/auth/register`，用户输入 pilotCode；confirmation 不提交。新用户名 3–32、新密码 6–32，按合同明确 Unicode 空白列表拒绝（含 U+0085），不自动 trim；昵称最多 64。旧登录凭据和改密的 currentPassword 原样提交，不新增内部空白限制。
- 改密 `POST /api/v2/auth/password` 仅 `{currentPassword,newPassword}`，200 data=null 才清本次会话并回登录；400 保留有效会话，401 清当前失效会话，429/网络失败可读且不自动重试。成功撤销所有设备会话由服务器执行；本地退出不等于删除账号。
- 密码、确认密码和注册码在完成、隐藏、卸载后清空；取消/过期回包不覆盖新账号或页面。帮助/隐私准确说明仅数字识别、不训练、不长期保存原图、不读取手机号/位置，仅访问用户明确选择的单张图片、不扫描或批量读取相册、不使用相机；临时文件、日志/备份单列。元数据 30 天、日志/备份 7 天为维护者须落实的参考留存，不声称已有自动清理。

## 自动化验证（stub 层，不是微信 UI 验收）

Node.js 20+，本次使用获准的 **Node v22.23.4 / npm 10.9.9**。在 `miniprogram/` 执行：

```sh
npm test
```

或使用本机已有的获准 Node22（Git Bash，先进入 `miniprogram/`）：

```sh
"D:/Temp/hdr-w1-node-runtime/node-v22.23.4-win-x64/node.exe" --test \
  tests/drawing-board.test.js tests/session.test.js tests/pilot.test.js tests/recognition.test.js tests/interface.test.js tests/image-import.test.js
```

测试无第三方依赖，加载实际 **Component / Page / App** 定义和真实 session/request 模块，以 wx stub 和最小 Canvas 软件栅格 stub 验证：

- W1 全部 29 项画板行为回归；新增异步导出、revision、立即取消与超时。
- 启动/匿名入口零网络；W1/不完整缓存迁移、缓存不授权、普通成员、v2 登录 `/me`、退出、旧登录/401 与异步 finally 隔离。
- 真实页面编排的空间列表/详情核验、空态、403/404、切换/离开竞态。
- 实际画板组件 → 异步 PNG 路径 → 上传参数 → 回包渲染状态；UUID、HTTP/业务/非 JSON 错误、Retry-After、超时/abort、无重试、旧成功/失败/finally、返回值合同校验。

W1 历史证据：此前 Node v20.15.0 的 45 项通过，随后获准 Node v22.23.4 / npm 10.9.9 的 45 项通过，均仅 stub 验证。**W2 本次在 Node v22.23.4 上执行 `npm test` 与直接 `node --test`，136 项全部通过（画板 35、会话/页面/请求 101），0 失败、0 跳过**；计时器用例使用 Node MockTimers，其 experimental warning 不代表微信真实运行证据。不能沿用 W1 数量当作 W2 验收。

### Pilot 新增回归（与 W1/W2 历史证据分开）

本地 Node v22.23.4 直接运行上述三个测试文件：**234 项通过，0 失败、0 取消、0 跳过**；原画板 35 项、会话/页面/请求 101 项全部保留，另新增 `tests/pilot.test.js` 98 项。旧会话测试显式注入 develop + localhost 并绑定缓存 origin；旧「失败保留密码」断言按新合同改为清空，原网络错误显示/解锁重试断言保留。新用例覆盖真实 Page/Component 的注册/改密、明确 Unicode 列表、离线配置错误、origin 变化与旧回包、默认空间和原型路线封锁。测试域名与邀请码均为 wx stub 的合成数据，不是已配置线上服务。

## 开发者工具 / 真机人工验收（未执行，必须如实保留待验）

以下方框保持未勾选；团队会前内部验收并记录真实结果，周四会议只展示已完成成果。**Node stub 通过不代表真实 Canvas、PNG 字节、网络域名、设备 UI 或双端 AC-02 全部通过。**

- [ ] 从相册明确选择 PNG/JPEG 原图 → 本地预览 → 明确识别 → Java/Python 结果；取消/重选/移除/格式与超限失败不上传，选择本身不生成请求标识。核验真实临时路径、图片头与 `wx.getImageInfo` 返回类型/尺寸（含带方向信息的 JPEG）。
- [ ] 真机选择器回调先于/晚于 onShow、切后台/返回、账号/空间变化、退出/卸载及旧 401/422 不复活旧图；确认相册相关微信平台隐私声明、授权与正式审核要求，没有相机入口。
- [ ] 登录前无缓存/旧缓存/v2候选缓存均不直接授权识别；确认没有免登录画板入口。
- [ ] 登录后画板单点、多笔、多指、边缘触摸、取消/清空及DPR1/2/3的实际PNG尺寸/完整性。
- [ ] 初始化/导出失败可重试，清空/重画/离开后没有旧结果或错误。
- [ ] PC 当前注册普通账号，小程序同账号登录 → `/me` → 本人空间 → 手写 → Java → Python 可信基线 → 真实数字/置信度/版本/耗时；保留脱敏结果与真实 Canvas PNG 证据，不能用 stub 结果替代。
- [ ] 缓存存在但过期/伪造时不能直接授权；无会话直达首页回登录；错误登录可修正，无预填管理员密码，无 login/index 循环。
- [ ] 实际 OWNER / MEMBER 均可识别；第二账号及非成员/跨空间 404、成员权限 403 不显示他人结果，不误退出仍有效普通账号。
- [ ] 两个真实空间来回切换，列表和详情核验对应当前空间；空态、断网、非 JSON 413、429、409、模型未就绪/超时错误可读，没有自动重试。
- [ ] 识别期间清空、重画、切换空间、离开页面、退出/换账号，确认旧成功/错误/loading 均不复活；新识别不会被旧 finally 关闭。
- [ ] 受控 LAN 真机上实际验证 Java 可达、合法域名/调试规则、`wx.getRandomValues`、`wx.uploadFile` multipart 和实际服务端请求 ID 一致；退出时核查服务端会话已撤销。
- [ ] Pilot 新流程：实际微信 trial/release 包注册 → 默认个人空间识别 → 改密 → 各设备旧会话失效 → 新密码重新登录；检查隐藏/卸载后的密码/注册码清空与真实键盘布局。
- [ ] Pilot 配置与隐私：填写经团队确认的真实 HTTPS 合法域名、维护者/联系方式/隐私版本，验证未配置版本零联网、无免登录入口、帮助可离线读；确认留存/删除与备份流程后再分享。本地静态检查不代表 HTTPS 上线、微信审核或真机通过。
