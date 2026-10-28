# 手写数字识别系统

基于深度学习的手写数字识别系统：手机端微信小程序负责手写交互，PC 端 Vue 后台负责管理功能，Spring Boot 作为统一业务网关，Python 负责模型。真实手写场景识别准确率 **≥90% 是项目目标，并非当前实测结论**。

> M1–M5 的 W1 交付已集成到 `develop`，[GitHub Wiki](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/wiki) 更新材料已准备，线上发布因权限确认尚未完成。代码集成不等于人工验收或完整识别链路已完成，实际状态见 [W1 交付与验证记录](docs/W1-交付与验证记录.md)。

## 本次范围与成员分支

五个成员分支从同一个 `develop` 基线出发，现已合并至 `develop`，下表保留各自的 W1 交付入口。后续开发从最新 `develop` 创建功能分支；本地汇总分支不作为团队拉取入口。

| 成员分支 | W1 交付 | 后续内容 |
|---|---|---|
| [feature/m1-w1](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/tree/feature/m1-w1) | 需求、架构、接口契约/OpenAPI、协作规范与 CI 配置 | 正式 Java→Flask 图片调用通道、部署实测 |
| [feature/m2-w1](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/tree/feature/m2-w1) | 注册/登录/当前用户接口的边界修复与回归测试，数据库字典/ER 图 | 用户管理 CRUD、训练任务/模型管理接口 |
| [feature/m3-w1](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/tree/feature/m3-w1) | 独立 CNN/MNIST 训练 CLI、测试、checkpoint 与实际指标记录 | Flask 在线推理、Celery 训练调度 |
| [feature/m4-w1](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/tree/feature/m4-w1) | 管理端登录、服务端会话核验、管理员路由限制与回归测试 | 用户/模型/训练/统计管理页面 |
| [feature/m5-w1](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/tree/feature/m5-w1) | 独立手写画板组件、白底 PNG 导出预览、会话缓存修复及逻辑测试 | 上传识别、连续数字识别、历史记录 |

**真实 MNIST 基线已跑通**：60,000 条训练、10,000 条测试，CPU 3 轮最终测试准确率 **99.10%**，权重重载验证通过；详见 [M3 的 MNIST 基线记录](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/blob/feature/m3-w1/docs/W1-MNIST基线训练记录.md)。该指标不等于真实画板准确率，微信桩测试也不能代替真机验收。

## 后续目标架构

```text
微信小程序 ─┐
             ├─ Spring Boot 网关 ── MySQL（业务数据）
Vue 管理端 ─┘          │
                       └─ Flask 模型服务 ── Redis / Celery / 训练 worker
                                                   └─ 模型文件
```

W1 中 Flask 只有健康检查；CNN 通过独立命令离线训练。上图在线推理、异步训练、模型管理与统计能力按后续周计划实现，不是已有的完整闭环。

## 各成员使用说明

| 文档 | 内容 |
|---|---|
| [M2 后端 README](backend/README.md) | Java 17 / Spring Boot 3 / MyBatis-Plus / JWT；认证与健康检查 |
| [M4 管理端 README](frontend/README.md) | Node 22 / Vue 3 / Pinia / Element Plus；管理员登录与首页 |
| [M3 模型服务 README](model-service/README.md) | Flask 健康服务，独立 Python 3.11 / PyTorch 离线训练 |
| [M5 小程序 README](miniprogram/README.md) | 小程序登录与独立 W1 画板原型 |
| [共享文档](docs/README.md) | 需求、契约、规范与验证记录；包含跨成员文档链接 |

## 本地验证

以下全套命令适用于最新 `develop`；在历史成员分支只运行对应模块的检查。依赖准备妥当后，在项目根目录执行：

```bash
mvn -B -f backend/pom.xml verify
(cd model-service && python -m pytest -q)
(cd model-service && python -m pytest -c pytest-training.ini -q -rs)
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix miniprogram test
```

训练集合需要独立训练依赖；缺 PyTorch 导致的跳过不算数值测试通过。CI 按成员模块拆分，只跑轻量检查，不下载 MNIST、不训练模型。

## 启动应用

以下说明适用于最新 `develop`。各模块可分别启动；W1 尚未接通手写图片识别链路。

### Docker 骨架

```bash
cp .env.example .env
docker compose up -d --build
```

这会配置 MySQL、Redis、Flask、Spring Boot、Vue 五个服务；不会启动训练 worker 或把离线 CNN 接成识别接口。本次未验证 Docker 部署。

### 分别启动

1. 准备 MySQL 8，按后端 README 配置数据库连接。
2. Flask：在 `model-service/` 安装 `requirements.txt` 后运行 `python app.py`，健康地址为 `http://localhost:5001/api/v1/health`。
3. 后端：在 `backend/` 运行 `mvn spring-boot:run`，监听 8080；API 文档见 `http://localhost:8080/doc.html`。
4. 前端：在 `frontend/` 使用 Node 22，运行 `npm install`、`npm run dev`，访问 `http://localhost:5173`。
5. 微信开发者工具导入 `miniprogram/`，通过登录页的 W1 画板入口或启动路径 `pages/drawing-prototype/drawing-prototype` 独立体验原型，不需要后端或模型。

后端初始开发账号及环境配置见后端 README；仅用于本地开发，不应直接用于公开部署。

## 文档与协作

- [团队计划](docs/00-团队分工与工作计划.md)、[文档索引](docs/README.md)、[Git 与 CI 规范](docs/06-Git与CI规范.md)。
- 各成员在功能分支完成增量，经评审/CI 后合入 `develop`；`develop` 不会永久停留在框架状态。
- Wiki 是团队文档协作入口，`docs/` 保存待同步材料与版本快照。二者不自动同步，Wiki 发布前需保留组员的最新改动。
- 周四集中展示本周成果；需求确认、代码评审、合并和真机验收必须由实际参与者完成。
