# Git 与 CI 规范

> 编制：M1　|　日期：2026-10-24　|　适用：全体成员

## 1. 分支模型

| 分支 | 用途 | 合并方向 |
|---|---|---|
| `main` | 随时可发布的稳定版本 | `develop` → `main` |
| `develop` | 集成基线，仅保留框架与共享文档 | `feature/*` → `develop` |
| `feature/<模块>` | 各成员功能分支，从 `develop` 拉出 | 合并后删除 |

命名示例：`feature/m1-foundation`、`feature/m2-user-auth`、`feature/m3-model-service`、`feature/m4-admin`、`feature/m5-miniprogram`。

约定：

- 所有功能分支从最新 `develop` 拉出，开工前先 `git pull`。
- 不在 `main`、`develop` 上直接提交，一律通过 Merge Request 合入。
- 分支合并后删除远端分支，避免堆积。

## 2. 提交规范

提交信息使用前缀 + 中文或英文简述，一次提交只做一件事：

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(m2): 用户分页查询接口` |
| `fix` | 缺陷修复 | `fix(m3): 修正预处理反色条件` |
| `docs` | 文档 | `docs(m1): 补充需求确认表` |
| `test` | 测试 | `test(m5): 识别接口自动化用例` |
| `chore` | 构建、依赖、配置 | `chore: 升级 Spring Boot 依赖` |
| `refactor` | 不改变行为的重构 | `refactor(m4): 抽取表格分页组件` |

禁止提交的内容：`target/`、`node_modules/`、`.env`、模型权重（`weights/*.pt`、`registry.json`）、数据集文件。

## 3. Merge Request 与 Code Review

- 至少 1 人 Code Review 通过后才能合并，作者不能自我批准。
- MR 描述包含三部分：**改了什么**、**怎么验证**（命令或步骤）、**影响范围**（是否改动接口契约/表结构）。
- 涉及接口契约或表结构变更时，同步更新对应文档并 @ 相关成员。
- CI 未通过不允许合并。

## 4. CI 流水线

配置文件：`.github/workflows/ci.yml`。

| Job | 环境 | 执行内容 |
|---|---|---|
| Spring Boot | Java 17 (temurin) | `mvn -B -DskipTests package` |
| Flask model service | Python 3.11 | `pip install -r requirements-ci.txt`、`compileall`、`pytest -q` |
| Vue admin | Node 22 | `npm install`、`npm run build` |

触发条件：

- push 到 `main` 或 `develop`
- 任意 Pull Request

查看方式：仓库 **Actions** 页面。`feature/*` 分支的普通 push 不触发流水线，开 PR 后会自动运行。

## 5. 本地自检

提交前在本地执行与 CI 等价的检查：

```bash
# 后端
cd backend && mvn -B -DskipTests package

# 模型服务
cd model-service && pip install -r requirements-ci.txt && pytest -q

# 管理端
cd frontend && npm install && npm run build
```

## 6. 完成定义（DoD）

代码已合并 + 接口/文档已更新（含 Wiki）+ 自测通过 + 测试环境可演示，且已通过团队内部验收、可在周四集中展示时现场演示。

## 7. 发布

- `develop` 集成稳定后，通过 MR 合入 `main`。
- `main` 上打标签（如 `v0.1.0`）对应可演示版本，标签信息写明本次包含的功能范围。
