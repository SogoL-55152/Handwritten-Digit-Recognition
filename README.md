# 手写数字识别系统

基于深度学习的在线手写数字识别系统。用户在手机端书写数字，由后端 CNN 模型自动识别；PC 管理端提供模型训练、模型管理与数据统计能力。识别准确率目标 **≥ 90%**。

> 本仓库当前为**团队工程骨架**（W1）。各成员从 `develop` 拉出自己的 `feature/*` 分支，在骨架上完成各自模块。

## 目标功能

- **手写识别**：小程序画板书写，返回识别结果；增强功能支持连续多位数字识别
- **模型训练管理**：数据集选择 → 参数配置 → 训练过程可视化 → 模型保存
- **模型管理**：多模型并存，同一时刻仅一个模型活跃，可一键切换
- **用户管理**：注册登录、角色与权限控制
- **统计分析**：识别调用量、准确率、模型使用分布

## 系统架构（目标形态）

```
微信小程序 ─┐
            ├─→ Spring Boot 网关（鉴权 / 业务 / 文件）─→ Flask 模型服务（推理 / 训练）
Vue 管理端 ─┘              │                                    │
                     MySQL + Redis                       Celery 任务队列 / 模型文件
```

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Java 17、Spring Boot 3、MyBatis-Plus、JWT |
| 管理端 | Vue 3、Vite、Element Plus、ECharts |
| 模型服务 | Python 3.10–3.12、Flask、PyTorch、Celery + Redis |
| 移动端 | 微信小程序 |
| 存储 | MySQL 8、Redis、本地/对象存储模型文件 |
| 模型 | CNN（数据集：MNIST 及自采扩展数据） |
| 部署 | Docker Compose |

## 目录结构

```
.
├── backend/                  # Spring Boot 业务服务（唯一对外网关）
│   ├── src/main/java/com/hdr/
│   │   ├── auth/             # JWT、拦截器、权限注解
│   │   ├── common/           # 统一响应、分页、异常处理
│   │   ├── config/           # Web / MyBatis-Plus / OpenAPI / 初始化
│   │   ├── controller/       # AuthController、HealthController
│   │   ├── dto/              # 登录注册相关对象
│   │   ├── entity/ mapper/   # User
│   │   └── service/          # UserService
│   └── src/main/resources/db/schema.sql
├── frontend/                 # Vue 管理端
│   └── src/{api,layout,router,stores,views}
├── model-service/            # Flask 服务
│   ├── api/                  # health
│   ├── tests/
│   └── app.py
├── miniprogram/              # 微信小程序
├── docs/                     # 团队计划与文档说明
├── docker-compose.yml        # 一键启动 MySQL/Redis/模型服务/后端/前端
└── .github/workflows/ci.yml  # 三端 CI
```

## 快速开始

### 方式一：Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

| 服务 | 地址 |
|---|---|
| 管理端 | http://localhost |
| 后端 API / Swagger | http://localhost:8080 / http://localhost:8080/doc.html |
| 模型服务健康检查 | http://localhost:5001/api/v1/health |

首次启动自动建表并创建管理员 **admin / admin123**。

### 方式二：本地分别启动

**1. 启动 MySQL 与 Redis**

```bash
docker compose up -d mysql redis
```

**2. 启动模型服务**

```bash
cd model-service
pip install -r requirements.txt
cp .env.example .env
python app.py            # http://localhost:5001
```

**3. 启动后端**

```bash
cd backend
mvn spring-boot:run      # http://localhost:8080
```

**4. 启动管理端**

```bash
cd frontend
npm install
npm run dev              # http://localhost:5173
```

**5. 运行小程序**

使用微信开发者工具导入 `miniprogram/`，在「本地设置」勾选“不校验合法域名”。
真机调试需将 `miniprogram/app.js` 中的 `baseUrl` 改为电脑局域网 IP。

## 当前状态（W1 工程骨架）

| 部分 | 已具备 | 待各成员实现 |
|---|---|---|
| 后端 | 统一响应/异常、JWT 鉴权、登录注册、健康检查、自动建表与管理员初始化 | 用户管理、数据集、模型管理、训练任务、识别转发、统计接口 |
| 模型服务 | Flask 入口、统一响应用法、健康检查、pytest 配置 | 图像预处理、CNN、模型注册与推理、Celery 训练 |
| 管理端 | 登录页、路由守卫、后台布局、请求封装、首页占位 | 概览、用户、数据集、模型、训练、统计页面 |
| 小程序 | 登录页、请求封装、首页占位 | 手写画板、识别、历史记录 |

## 分支与协作

| 分支 | 用途 |
|---|---|
| `main` | 随时可发布的稳定版本 |
| `develop` | 集成基线，仅保留框架与共享文档 |
| `feature/xxx` | 各成员功能分支，从 `develop` 拉出 |

- M1 的集成与部署工作使用 `feature/m1-foundation`
- 合并走 Merge Request，至少 1 人 Code Review
- 完成定义：代码已合并 + 文档已更新 + 自测通过 + 测试环境可演示

## 文档

- [团队分工与工作计划](docs/00-团队分工与工作计划.md)（共享）
- 需求、架构、接口、数据库、测试文档由各责任人在自己的分支产出，合入前不放 `develop`

## 开发规范

- 接口先行：前后端以接口契约为准，变更需同步通知相关成员
- 提交信息使用 `feat/fix/docs/chore` 前缀
- CI 在 push 到 `main`/`develop` 或提交 PR 时运行
