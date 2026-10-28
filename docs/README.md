# 文档目录（W1 分成员交付）

> 面向全体组员；W1 按 `feature/m1-w1` 至 `feature/m5-w1` 分支提交、推送。共享文档归 M1，数据库文档归 M2，训练记录与指标归 M3。本次不创建 PR、不合入 `develop`、不更新 Wiki。

| 文档 | 内容 | 主责 |
|---|---|---|
| [团队分工与工作计划](00-团队分工与工作计划.md) | 分工、周任务、交付物与完成定义 | M1 |
| [需求规格说明书](01-需求规格说明书.md) | 目标需求与真人待确认事项 | M1 |
| [系统架构设计](02-系统架构设计.md) | W1 实际边界与后续目标架构 | M1 |
| [接口契约](03-接口契约.md) | 已实现认证/健康检查与未来接口约定 | M1 |
| [OpenAPI](api/openapi.yaml) | 机器可读契约，不代表所有接口已实现 | M1 |
| [数据库设计](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m2-w1/docs/04-数据库设计.md) | 五表字段、固定角色设计、逻辑关系 ER 图 | M2 |
| [Git 与 CI 规范](06-Git与CI规范.md) | Wiki 协作、功能分支、PR、CI 与自检 | M1 |
| [W1 交付与验证记录](W1-交付与验证记录.md) | M1–M5 文件索引、实测结果、阻塞与人工待办 | M1 汇总 |
| [W1 MNIST 基线训练记录](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m3-w1/docs/W1-MNIST基线训练记录.md) | 训练准备、实际执行状态与复现步骤 | M3 |

各模块的操作方法见 [后端 README](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m2-w1/backend/README.md)、[模型服务 README](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m3-w1/model-service/README.md)、[管理端 README](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m4-w1/frontend/README.md)、[小程序 README](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m5-w1/miniprogram/README.md)。跨成员材料使用对应分支链接，不要求 M1 分支包含其他成员的实现。

## 后续 Wiki 发布

Wiki 是文档协作入口；本目录保存待同步材料与版本快照，两者不会自动同步。得到 Wiki 发布授权后，由页面主责人先读取对应 Wiki 最新内容，合并组员修改再发布，不能直接用旧快照覆盖。OpenAPI 随代码版本维护并从 Wiki 链接引用。

本次不改在线 Wiki 页面、不代填成员确认或完成合并验收；数据库真实落库、浏览器与小程序真机验证的状态见交付记录。
