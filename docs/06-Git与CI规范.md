# Git 与 CI 规范

> 主责：M1　|　更新：2026-10-28　|　适用：全体成员

## 1. 分支与每周工作流

| 分支 | 用途 | 合并方向 |
|---|---|---|
| `main` | 可发布的稳定版本 | `develop` → `main` |
| `develop` | 从框架起步，持续集成各成员已评审、已验证的周任务 | `feature/*` → `develop` |
| `feature/<模块>` | 从最新 `develop` 创建的功能分支 | 通过 PR 合并 |

W1 成员分支及职责：

| 分支 | 增量范围 |
|---|---|
| `feature/m1-w1` | 需求、架构、接口契约、共享文档与 CI 规范 |
| `feature/m2-w1` | 后端认证修复、测试与数据库设计 |
| `feature/m3-w1` | MNIST/CNN 训练、测试、训练记录、轻量指标与训练产物忽略规则 |
| `feature/m4-w1` | 管理端登录、会话核验、路由守卫与测试 |
| `feature/m5-w1` | 小程序画板原型、会话处理与测试 |

五个成员分支从同一个框架基线独立创建，现已合并到 `develop`。成员分支保留作 W1 交付记录，后续开发从最新 `develop` 创建新功能分支。

1. 每位成员依据团队计划认领任务，在功能分支实现与自测。
2. 文档在 Wiki 对应页面维护，接口/数据结构变更应及时通知相关成员，不等到周末才沟通。
3. 一个可验证的增量完成后即可提 PR，不必等所有成员都做完才集成。
4. PR 通过代码评审与 CI 后合入 `develop`；合并冲突由功能分支负责人解决。
5. 周四集中展示本周成果，以已集成版本为主；未合并、未验证部分单独说明。

不在 `main`、`develop` 上直接开发。合并后可按团队约定清理功能分支，再从最新 `develop` 创建下一项工作分支。

**本次 W1 集成记录**：按用户指令直接合并五个成员分支，合并前后完成本地回归验证。Wiki 更新材料已准备，因发布权限确认尚未提交或推送。此次未创建 PR、未代替真人评审；日常协作仍按上述 PR 流程执行。代码集成不代表全部 DoD 已通过，本地汇总分支不推送。

## 2. 文档协作

- [GitHub Wiki](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/wiki) 是团队文档协作入口。每页保留主责人、版本和修订记录。
- 修改共享契约前先通知页面主责人，避免多人同时改同一段；意见通过 Issue 或群内反馈，不依赖 Wiki 评论功能。
- 仓库 `docs/` 保存版本快照和 OpenAPI 等机器可读文件。它与 Wiki **不会自动同步**；同步前比较最新 Wiki，不能用旧快照覆盖组员修改。
- 本轮已授权同步 Wiki；实际需求确认、代码评审和团队验收仍由成员完成，不能由自动化测试代签。

## 3. 提交与 PR

提交采用 `类型(模块): 简述`，例如 `feat(m5): 增加手写画板原型`。

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建、依赖、配置 |
| `refactor` | 不改变行为的重构 |

- 一次提交只做一件事；提交前检查 diff，不提交 `.env`、密钥、`target/`、`node_modules/`、数据集、模型权重或虚拟环境。
- PR（Merge Request）至少经 1 位其他成员评审，作者不自我批准。
- PR 说明包含：改了什么、验证命令与结果、接口/数据库影响、对应 Wiki 页面、未完成项。
- CI 未通过不能合并；训练测试被跳过、仅完成编译，都必须如实说明。

## 4. CI 流水线

配置：`.github/workflows/ci.yml`。触发于 push 到 `main`/`develop` 或提交 PR；普通功能分支 push 不单独触发。

`develop` 已集成以下四个 job：

| Job | 环境 | 检查 |
|---|---|---|
| Spring Boot | Java 17 | `mvn -B verify`，包含测试与打包 |
| Flask model service | Python 3.11 | 轻量依赖、编译检查、`pytest -q`、无模型依赖的训练参数测试 |
| Vue admin | Node 22 | 安装依赖、`npm test`、`npm run build` |
| Mini program prototype | Node 22 | `npm test`，画板与会话逻辑测试 |

成员分支中的 CI 只包含基线及各自增量；本次合并保留了全部模块的检查。以后修改 CI 时，不用某个旧功能分支的整份配置覆盖集成版本。

完整 MNIST 训练不放入常规 CI，避免下载数据与长耗时训练。训练环境中的测试、真实 MNIST 基线、小程序开发者工具与真机验证另行执行并记录。

本次 `develop` 推送触发 GitHub Actions；远端状态以 [Actions 页面](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/actions) 为准，不能把本地测试结果当作线上 CI 已通过。

## 5. 本地自检

在最新 `develop` 的仓库根目录、依赖已经就绪时执行：

```bash
mvn -B -f backend/pom.xml verify
(cd model-service && python -m pytest -q)
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix miniprogram test
git diff --check
```

训练依赖与命令见模型服务 README；小程序实际触摸、导出图片和 DPR 检查见小程序 README。MockMvc 不验证 MySQL 落库，`wx` 桩测试不验证真实微信渲染，构建成功不等于浏览器登录流程已验收。

## 6. 完成定义（DoD）

代码通过评审并合并 + 接口/文档已更新 + 自测通过 + 团队内部验收通过、可运行展示。

周四集中展示本周成果，不把会上展示当作代码评审或需求确认。W1 当前是“已集成、自测通过，人工评审与集成场景验收待完成”，不能登记为全部 DoD 已完成。

## 7. 发布

`develop` 集成稳定后，通过 PR 合入 `main`；再按需要创建版本标签。本次只更新 `develop` 和 Wiki，不更新 `main`、不创建发布标签、不部署服务。
