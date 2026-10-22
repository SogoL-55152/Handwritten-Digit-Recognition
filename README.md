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
| 模型服务 | Python 3.10+、Flask、PyTorch、Celery + Redis |
| 移动端 | 微信小程序 |
| 存储 | MySQL 8、Redis、本地/对象存储模型文件 |
| 模型 | CNN（数据集：MNIST 及自采扩展数据） |
| 部署 | Docker Compose |

## 目录结构

```
.
├── backend/          # Spring Boot 业务服务（唯一对外网关）
├── frontend/         # Vue 管理端
├── model-service/    # Flask 训练与推理服务
├── miniprogram/      # 微信小程序
└── docs/             # 需求、设计、接口与测试文档
```

## 快速开始

**1. 启动模型服务**

```bash
cd model-service
pip install -r requirements.txt
python app.py            # 默认 http://localhost:5001
```

**2. 启动后端**

```bash
cd backend
mvn spring-boot:run      # 默认 http://localhost:8080
```

**3. 启动管理端**

```bash
cd frontend
npm install
npm run dev              # 默认 http://localhost:5173
```

**4. 运行小程序**

使用微信开发者工具导入 `miniprogram/`，以开发版 / 体验版调试。

> 首次运行前请配置 `backend/src/main/resources/application.yml` 与 `model-service/.env` 中的数据库、Redis 及服务地址。

## 使用流程

1. 管理员在 PC 端创建训练任务，选择数据集与训练参数
2. 模型服务异步训练，管理端实时查看损失与准确率曲线
3. 训练完成后保存模型，在模型管理页设为活跃模型
4. 用户在小程序手写数字，请求经后端转发至模型服务返回识别结果

## 文档

- [团队分工与工作计划](手写数字识别系统-分工与工作计划.md)
- 需求规格说明书、系统设计文档、接口文档（Swagger）、测试报告见 `docs/`

## 开发规范

- 分支策略：`main`（可发布）/ `develop`（集成）/ `feature/xxx`（功能）
- 合并需提交 Merge Request 且至少 1 人 Code Review
- 完成定义：代码已合并 + 文档已更新 + 自测通过 + 测试环境可演示

---
