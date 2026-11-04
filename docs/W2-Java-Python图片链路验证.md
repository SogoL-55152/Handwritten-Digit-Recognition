# W2 Java↔Python 图片链路验证

更新：2026-11-03。面向 M3/M5 及集成成员。**真实 MySQL、Java→Python→数据库和PC浏览器鼠标画板已通过本次验证；微信客户端仍待工具/真机验收。** 详细用例及初次失败记录见 [交付与验证记录](W2-交付与验证记录.md)。

## 冻结协议

```text
PC / 小程序
  POST /api/v2/workspaces/{workspaceId}/recognitions
  Authorization: Bearer <v2 token>
  Idempotency-Key: <UUID>
  multipart: image + source(WEB|MINIPROGRAM)
      ↓ Java 核验当前会话/空间成员、图片、幂等、限制
  POST /internal/v2/predict
  X-HDR-Internal-Token: <内部凭据>
  multipart: image + workspaceId + requestId
             + modelId + modelVersion + preprocessVersion
      ↓ 可信 manifest + SHA256 + 预处理 + 真实 CNN
  digit / confidence / 模型与预处理版本 / 耗时
      ↓ Java 校验上游响应并保存本人记录
  recognitionId / requestId / 预测结果 / createdAt
```

- 外部 `modelId` 是数据库字符串 ID；内部 `modelId` 是固定外部标识 `mnist-cnn-w1`，两者不要混用。
- Java 从当前空间默认引用取得模型快照，不从请求接受模型路径、URL 或全局 active 标记。
- 唯一键 `(workspace_id, creator_id, request_id)` 绑定图片字节 SHA256 和来源；成功同键返回已存结果，进行中/已失败不重复调用模型。
- Java 保存 PROCESSING 后释放数据库连接，再调用 HTTP；没有跨 HTTP 的数据库长事务。失败记录为 FAILED，进程中断残留在同键访问时按30秒窗口终结，不自动重发模型 POST。
- 连接/读取预算 2s/10s，并发最多2个；客户端有更长网络预算。大响应最多读取65,537字节并拒绝超过65,536字节的返回。模型数字及业务码校验防止超大整数转换绕回有效范围。

## 图片边界

| 项目 | 约定/实现 |
|---|---|
| 文件与请求 | 文件≤5 MiB；Java/Nginx请求≤6 MiB，预留multipart开销 |
| 像素 | 最大边2048，总像素≤4,194,304；先查尺寸再解码 |
| 类型 | 真实PNG/JPEG；不相信上传文件名；Java重建可信MIME |
| 资源保护 | 上传全局/IP固定窗口在懒解析前；Java内存图片流，Python并发槽与multipart数量/字段限制 |
| 透明/方向 | 透明层合成白底，EXIF转正，不任意旋转和拉伸 |
| 归一化 | 按边框底色选前景，裁剪、等比缩到20×20内、居中28×28；mean=.1307、std=.3081 |
| 无效输入 | 空白/损坏/超大/多帧拒绝；Python为最终预处理校验层 |
| 存储 | 只保存最小识别元数据与摘要，不永久保存原始图片 |

预处理是画板输入方案，不承诺手机照片、复杂背景或多数字识别效果。它与 W1 标准 MNIST 测试集不是同一输入分布。

## 组件验证历史（2026-11-02，不安装新依赖）

- Python 预处理/可信加载安全：**40 passed**，包含格式、透明、非正方、空白、损坏、大小和加载约束。
- 独立 full checkpoint：**4 passed**，校验固定摘要/manifest、只加载一次、`weights_only=True`、eval、确定性及两路并发。不导入 torchvision，不重新训练。
- 现有推理测试环境：Python3.11 / torch2.5.1+cpu / NumPy1.26.4 / Pillow13.0.0。依赖安装文件/Docker建议版本不是本次实际安装版本。
- Java：图片校验6项、上游结果协议20项、真实Controller的模拟multipart5项均已随本地完整单测通过。Mock HTTP/model 不作为真实模型或socket链路证据。
- 小程序生产 Page/Component/App 逻辑用 wx/software-canvas stub 测试；不是微信实际导出/上传证据。

一次从仓库根目录执行只带 `-c` 的权重测试误收集了 Flask 测试，报缺少 Flask/werkzeug；改为显式 `model-service/tests_inference` 后上述4项通过。当时完整API依赖缺口在11月3日获准新建独立环境后解决。

## 2026-11-03 真实闭环结果

- MySQL8.0.40：15项IT通过，包含迁移/回滚/权限/幂等/限流并发。
- 完整Python环境：94项Web/图片测试、4项真实权重测试通过，Waitress真实启动。
- 实际HTTP：24项检查通过，Java真实RestClient→Python→MySQL落库；合成7预测7，confidence=.99250727891922。
- 实际Edge：10项检查通过，真实鼠标Pointer Events绘制7、导出PNG、上传和渲染，confidence=.9950060248374939；核对记录、清空及迟到真实响应、空间切换、注销。最终截图经查看确认结果保持显示。
- 发现并修复同像素resize误清除识别结果；补1项逻辑回归和浏览器布局稳定断言。已保留 [截图](evidence/w2/2026-11-03/pc-recognition.png)、[PNG](evidence/w2/2026-11-03/browser-canvas.png)、[浏览器报告](evidence/w2/2026-11-03/browser-report.json) 与 [HTTP报告](evidence/w2/2026-11-03/http-smoke-result.json)。

## 尚未实测的范围

1. 微信工具/设备实际 `wx.getRandomValues`、Canvas2D PNG、multipart、超时和操作竞态；HTTP脚本的MINIPROGRAM来源不代替微信客户端。
2. 手机触摸/不同DPR的真实UI覆盖、更多手写形状/固定标注集；单个7不构成画板准确率评估。
3. 模型超时、缺权重及数据库中断的完整网关故障演练；现有单测/API覆盖不等于所有故障都实际注入过。
4. Docker及远端CI运行；当前仅本机进程验证，测试结束已关闭服务。

## 后续内部验收证据

每个用例记录：输入来源/尺寸/摘要、预处理版本、模型版本、请求ID、digit/confidence、Java耗时、识别记录ID、HTTP状态。凭据必须脱敏；不把用户图像或权重加入 Git。真实画板准确率需要固定标注样本集与错误分析，不能沿用 W1 的99.10%当结论。
