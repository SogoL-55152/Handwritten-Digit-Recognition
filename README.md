# 手写数字识别系统

基于深度学习的在线手写数字识别系统。用户在手机端书写数字，由后端 CNN 模型自动识别；PC 管理端提供模型训练、模型管理与数据统计能力。识别准确率目标 **≥ 90%**。

## 功能

- **手写识别**：小程序画板书写，实时返回识别结果；增强功能支持连续多位数字识别
- **模型训练管理**：数据集选择 → 参数配置 → 训练过程实时可视化 → 模型保存，全程可视化
- **模型管理**：支持多模型并存，同一时刻仅一个模型活跃，可一键切换
- **用户管理**：注册登录、角色与权限控制
- **统计分析**：识别调用量、准确率、模型使用分布

## 系统架构

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
│   │   ├── controller/       # REST 接口
│   │   ├── service/          # 业务逻辑
│   │   ├── client/           # 调用 Flask 模型服务
│   │   └── ...
│   └── src/main/resources/db/schema.sql
├── frontend/                 # Vue 管理端
│   └── src/{api,layout,router,stores,views}
├── model-service/            # Flask 训练与推理服务
│   ├── api/                  # REST 接口
│   ├── services/             # 预处理、模型注册、训练、任务状态
│   ├── models/cnn.py         # CNN 结构
│   └── tests/
├── miniprogram/              # 微信小程序
├── docs/                     # 需求、架构、接口、数据库、测试文档
├── docker-compose.yml        # 一键部署（MySQL/Redis/模型服务/后端/前端）
└── .github/workflows/ci.yml  # 三端 CI
```

## 快速开始

### 方式一：Docker Compose（推荐联调 / 演示）

```bash
cp .env.example .env
docker compose up -d --build
```

| 服务 | 地址 |
|---|---|
| 管理端 | http://localhost |
| 后端 API / Swagger | http://localhost:8080 / http://localhost:8080/doc.html |
| 模型服务健康检查 | http://localhost:5001/api/v1/health |

首次启动自动建表并创建管理员 **admin / admin123**；训练任务由 `model-worker` 容器执行。

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
python app.py            # 默认 http://localhost:5001
```

另开终端启动训练 worker：`celery -A celery_app.celery_app worker --loglevel=info`。
若仅做单字识别演示、不训练，可跳过 worker。

**3. 启动后端**

```bash
cd backend
mvn spring-boot:run      # 默认 http://localhost:8080
```

**4. 启动管理端**

```bash
cd frontend
npm install
npm run dev              # 默认 http://localhost:5173
```

**5. 运行小程序**

使用微信开发者工具导入 `miniprogram/`，在「本地设置」勾选“不校验合法域名”，
以开发版 / 体验版调试。真机调试需将 `miniprogram/app.js` 中的 `baseUrl` 改为电脑局域网 IP。

> 首次运行前请按需配置 `backend/src/main/resources/application.yml` 与 `model-service/.env`
> 中的数据库、Redis 及服务地址；默认值对应本地 Docker 启动的 MySQL/Redis。

## 使用流程

1. 管理员在 PC 端创建训练任务，选择数据集与训练参数
2. 模型服务异步训练，管理端实时查看损失与准确率曲线
3. 训练完成后保存模型，在模型管理页设为活跃模型
4. 用户在小程序手写数字，请求经后端转发至模型服务返回识别结果

## 当前进度（W1 框架）

| 部分 | 已具备 | 后续 |
|---|---|---|
| 后端 | 登录注册、JWT 鉴权、用户/数据集/模型/训练任务/识别/统计接口、自动建表与初始化 | SSE、文件存储抽象、MockMvc 测试 |
| 模型服务 | 图像预处理、CNN、模型注册与热切换、Celery 异步训练、指标上报、pytest | 自采数据微调、连续识别切分 |
| 管理端 | 登录、概览、用户、数据集、模型、训练任务、训练曲线、统计看板 | SSE 实时曲线、UI 统一 |
| 小程序 | 登录、Canvas 手写板、单字识别、401 自动跳转 | 连续多位数识别、历史记录 |

> 骨架阶段训练默认使用 MNIST 在线下载（首次训练较慢）。识别前需先完成一次训练并在模型管理中启用。

## 文档

- [团队分工与工作计划](docs/00-团队分工与工作计划.md)
- [需求规格说明书](docs/01-需求规格说明书.md)
- [系统架构设计](docs/02-系统架构设计.md)
- [接口契约](docs/03-接口契约.md)
- [数据库设计](docs/04-数据库设计.md)
- [测试计划](docs/05-测试计划.md)
- Swagger：启动后端后访问 http://localhost:8080/doc.html

## 开发规范

- 分支策略：`main`（可发布）/ `develop`（集成）/ `feature/xxx`（功能）
- 合并需提交 Merge Request 且至少 1 人 Code Review
- 完成定义：代码已合并 + 文档已更新 + 自测通过 + 测试环境可演示

---
