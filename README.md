# 手写数字识别系统

基于深度学习的手写数字识别系统：手机端微信小程序负责手写交互，PC 端 Vue 后台负责管理功能，Spring Boot 作为统一业务网关，Python 负责模型。真实手写场景识别准确率 **≥90% 是项目目标，并非当前实测结论**。

> M1–M5 的 W1 交付已集成到 `develop`，团队文档同步至 [GitHub Wiki](https://github.com/SogoL-55152/Handwritten-Digit-Recognition/wiki)。代码集成不等于人工验收或完整识别链路已完成，实际状态见 [W1 交付与验证记录](docs/W1-交付与验证记录.md)。

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

> 2026-11-25 更新：新增一键起停脚本与环境模板，推荐直接用它们，不再手抄命令。
>
> ```powershell
> Copy-Item scripts\.env.example scripts\.env   # 首次：改成自己机器上的路径与密码
> powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1   # 起（MySQL→Redis→模型→后端→worker→前端）
> powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1    # 停
> python scripts\smoke-test.py                                     # 验收：13 项检查
> ```
>
> 完整步骤、一次性初始化（建库、拉权重、备 MNIST、建管理员）与实测故障表见
> [部署手册（本机实测版）](docs/部署手册-本机实测.md) 与 [P0 交付记录](docs/P0-部署与压测-交付记录.md)。
> 下面第 1–6 小节是历史手动流程，保留作参考。

> 2026-11-18 更新。以下是本机（Windows）实测可用的启动方式；换机器只需替换路径和私有环境文件。

### 1. 前置依赖

| 依赖 | 本机路径示例 | 用途 |
|---|---|---|
| JDK 17 | `D:\Temp\hdr-w1-jdk-runtime\jdk-17.0.2` | 运行后端 |
| Maven 3.9 | `D:\Temp\hdr-tools\apache-maven-3.9.9` | 构建后端 |
| MySQL 8.0.40 | `D:\Temp\hdr-w2-mysql-runtime\mysql-8.0.40-winx64` | 业务库（数据目录 `D:\Temp\hdr-w2-mysql-state-20261103\data`） |
| Redis | `D:\Temp\hdr-w4-redis\bin\redis-server.exe` | 训练队列与状态 |
| Python venv | `D:\Temp\hdr-w4-venv` | 已装 torch / flask / celery / waitress |
| Node 22 | `D:\Temp\hdr-w1-node-runtime\node-v22.23.4-win-x64` | 前端构建与测试 |
| 私有环境文件 | `D:\Temp\hdr-w2-mysql-state-20261103\environment.json` | 数据库、JWT、内部令牌；**不入仓库** |

后端 jar 需要先构建：

```powershell
cd backend
$env:JAVA_HOME = "D:\Temp\hdr-w1-jdk-runtime\jdk-17.0.2"
D:\Temp\hdr-tools\apache-maven-3.9.9\bin\mvn.cmd -o -B package -DskipTests
```

前端需要已安装依赖（`frontend/node_modules` 已存在时可直接启动）。

### 2. 启动顺序

```
Redis(16379) → MySQL(13316) → 模型服务(5001) → 后端(8080) → 前端(5173) → 训练 worker（可选）
```

### 3. 一条命令段（PowerShell，项目根目录执行）

```powershell
cd C:\Users\毛守坤\Desktop\Handwritten-Digit-Recognition

# 读私有环境（数据库、JWT、内部令牌、Redis 地址）
$envFile = "D:/Temp/hdr-w2-mysql-state-20261103/environment.json"
(Get-Content $envFile -Raw | ConvertFrom-Json).PSObject.Properties |
  ForEach-Object { Set-Item -Path "env:$($_.Name)" -Value $_.Value }
$env:SPRING_PROFILES_ACTIVE = "default"; $env:HDR_PILOT_ENABLED = "false"
$env:MODEL_SERVICE_URL = "http://127.0.0.1:5001"
$env:MODEL_REGISTRY_PATH = "$PWD\model-service\weights\registry.json"
$env:WEIGHTS_DIR = "$PWD\model-service\weights"
$env:REDIS_URL = "redis://127.0.0.1:16379/0"; $env:REDIS_HOST = "127.0.0.1"; $env:REDIS_PORT = "16379"
$env:HDR_COLLECTED_DIR = "$PWD\collected-samples"
$env:HDR_RECOGNITION_DIR = "$PWD\recognition-images"
$env:HDR_TRAINING_DATA_DIR = "$PWD\training-data"
$env:TRAINING_CALLBACK_URL = "http://127.0.0.1:8080"

Start-Process "D:\Temp\hdr-w4-redis\bin\redis-server.exe" -ArgumentList "--port","16379","--bind","127.0.0.1"
Start-Process "D:\Temp\hdr-w2-mysql-runtime\mysql-8.0.40-winx64\bin\mysqld.exe" -ArgumentList `
  "--no-defaults","--basedir=D:\Temp\hdr-w2-mysql-runtime\mysql-8.0.40-winx64",`
  "--datadir=D:\Temp\hdr-w2-mysql-state-20261103\data","--bind-address=127.0.0.1","--port=13316",`
  "--mysqlx=OFF","--default-time-zone=+00:00","--console"
Start-Sleep -Seconds 10

Start-Process "D:\Temp\hdr-w4-venv\Scripts\python.exe" -ArgumentList "-I","model-service/serve.py"
Start-Sleep -Seconds 8

Start-Process "D:\Temp\hdr-w1-jdk-runtime\jdk-17.0.2\bin\java.exe" -ArgumentList `
  "-jar","backend\target\hdr-backend-0.1.0-SNAPSHOT.jar"

Start-Process "D:\Temp\hdr-w1-node-runtime\node-v22.23.4-win-x64\node.exe" -ArgumentList `
  "frontend/node_modules/vite/bin/vite.js","frontend","--host","127.0.0.1","--port","5173","--strictPort"

# 训练功能需要；不训练可以不起
Start-Process "D:\Temp\hdr-w4-venv\Scripts\python.exe" -ArgumentList `
  "-m","celery","-A","celery_app:celery_app","worker","--pool=solo","-Q","training","--loglevel=INFO" `
  -WorkingDirectory "$PWD\model-service"
```

> 首次启动后端会自动跑 Flyway 迁移到最新版本（当前 V23），不需要手动建表。

### 4. 确认启动成功

```powershell
D:\Temp\hdr-w4-venv\Scripts\python.exe -I scripts/local-demo.py check `
  --env-file D:/Temp/hdr-w2-mysql-state-20261103/environment.json
```

全部为 `true` 且 `verifiedModels` ≥ 1 即正常（本机当前为 18 个模型）。也可以直接看页面：

- 前端：<http://127.0.0.1:5173>
- 模型服务健康：<http://127.0.0.1:5001/api/v1/health>
- 后端存活：<http://127.0.0.1:8080/api/health>

本机开发账号：`admin` / `HdrAdmin2026!`（**仅本地使用，不可用于公开部署**）。

### 5. 停止服务

```powershell
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
  Where-Object { $_.CommandLine -like '*hdr-backend*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*model-service*' -or $_.CommandLine -like '*celery*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process mysqld, redis-server -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 6. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 打包报 `Unable to rename ...hdr-backend-...jar` | 后端进程还在占用 jar：先停后端再 `mvn package` |
| 模型服务报 `cannot import name 'serve' from waitress` 或 `No module named 'torch'` | venv 的 `.py` 文件被清理（本机 `D:\Temp` 清理过）：重建 venv 后重装 `requirements*.txt`，并确认 `D:\Temp\hdr-w4-venv` 指向可用的环境 |
| 端口被占用 | 13316 / 16379 / 8080 / 5001 / 5173 任一被占都会启动失败；先结束旧进程 |
| MySQL 起不来 | 数据目录必须是已初始化的（含 `auto.cnf`）；本机为 `D:\Temp\hdr-w2-mysql-state-20261103\data` |
| 页面能开但识别 502/503 | 模型服务没起或注册表摘要校验失败：检查 5001 健康与 `weights/registry.json` |
| 训练任务一直排队 | 训练 worker 没起，或 Redis 不可用：看 `D:\Temp\hdr-run\worker.out.log` |

Docker Compose 骨架（`docker compose up -d --build`）**尚未验证**，交付以此本机流程为准。

## 文档与协作

- [团队计划](docs/00-团队分工与工作计划.md)、[文档索引](docs/README.md)、[Git 与 CI 规范](docs/06-Git与CI规范.md)。
- 各成员在功能分支完成增量，经评审/CI 后合入 `develop`；`develop` 不会永久停留在框架状态。
- Wiki 是团队文档协作入口，`docs/` 保存待同步材料与版本快照。二者不自动同步，Wiki 发布前需保留组员的最新改动。
- 周四集中展示本周成果；需求确认、代码评审、合并和真机验收必须由实际参与者完成。

## 模型权重（不在仓库里）

训练产出的权重不进 git（约 114 MB），首次克隆后先执行一次：

    # Windows
    powershell -ExecutionPolicy Bypass -File scripts/fetch-weights.ps1

    # Linux / macOS
    bash scripts/fetch-weights.sh

脚本会下载基线权重并做 sha256 校验。说明见 [docs/权重与产物管理.md](docs/权重与产物管理.md)。

## 快速开始（clone 后一条命令）

### 方式 A：Docker（推荐，只需装 Docker）

```bash
git clone https://github.com/SogoL-55152/Handwritten-Digit-Recognition.git
cd Handwritten-Digit-Recognition
./start.sh          # Windows 双击 start.bat
```

脚本会自动完成：

1. 生成 .env（随机数据库密码 / JWT 密钥 / 内部 token / 管理员密码）
2. 下载基线权重并校验 sha256
3. docker compose up -d --build（首次构建约 2–4 分钟）
4. 等待服务就绪后自动打开浏览器

访问 http://127.0.0.1:8088，管理员账号与密码会打印在终端里（也写在 .env）。

停止与重置：

```bash
./stop.sh      # 停止，数据保留
./reset.sh     # 清空数据重来
```

### 方式 B：本机一键部署（无需 Docker）

入口：仓库根目录的 `deploy.bat`（内部调用 `scripts/deploy.ps1`）。脚本只检测环境、不自动安装。

#### B.1 前置条件

| 依赖 | 版本 | 检查 |
|---|---|---|
| JDK | 17 | `java -version` |
| Node | 20–22 | `node -v` |
| Python | 3.11 | `python --version` |
| MySQL | 8.0 | 需要 `mysqld.exe` / `mysql.exe` |
| Redis | 7 | 需要 `redis-server.exe` |

缺哪个，脚本会停下并打印安装命令。装了 Docker 的机器建议用方式 A，两者不要同时跑。

#### B.2 启动

```bat
git clone https://github.com/SogoL-55152/Handwritten-Digit-Recognition.git
cd Handwritten-Digit-Recognition
deploy.bat
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

#### B.3 首次运行会做什么

1. 检测 JDK / Node / Python / Maven / MySQL / Redis 与端口占用
2. 生成 `scripts/.env`（随机数据库密码、JWT、内部 token、管理员密码）
3. 启动 MySQL / Redis；数据目录为空时先初始化
4. 创建数据库（默认 `hdr_w2_it_live`）与用户 `hdr` 并授权
5. 创建 `.venv` 并安装依赖（含 torch，约 200 MB）
6. 检查权重（缺则下载）；缺 jar 则 `mvn package`，缺 node_modules 则 `npm ci`
7. 调用 `scripts/start-all.ps1` 启动 6 个服务并做健康检查
8. 打印访问地址、账号、密码

首次约 10–25 分钟（主要花在 torch / 权重 / npm），之后 30–60 秒。

#### B.4 完成后

```
访问：http://127.0.0.1:5173/login
账号：admin
密码：见 scripts/.env 的 HDR_BOOTSTRAP_ADMIN_PASSWORD
```

停止：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1
```

已部署过时，也可以跳过准备工作直接启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

#### B.5 常用参数

| 参数 | 说明 |
|---|---|
| `-CheckOnly` | 只检测环境，不写文件、不启动 |
| `-SkipDeps` | 跳过 Python 与权重准备（已装过时用） |
| `-SkipBuild` | 跳过打包与 `npm ci` |
| `-SkipFrontend` | 不启动前端 |
| `-Force` | 重新生成 `.env`、重建 `.venv` |
| `-NoOpen` | 不自动打开浏览器 |
| `-Database <name>` | 改数据库名 |
| `-Port <n>` | 改前端端口 |
| `-MysqlRootPassword <pwd>` | MySQL root 密码（建库/建用户时需要） |

示例：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -SkipDeps -NoOpen
```

#### B.6 数据库行为

| 情况 | 行为 |
|---|---|
| 库已存在且 `hdr` 用户可登录 | 直接复用，不会删数据 |
| 库不存在 | 用 root 建库、建用户并授权 |
| root 密码未知 | 用 `-MysqlRootPassword` 传入，或写入 `scripts/.env` 的 `MYSQL_ADMIN_PASSWORD` |
| 空密码 root | 脚本设置随机密码并写回 `scripts/.env` |

复用 `hdr_w2_it_live` 会保留原有模型、数据集与训练任务；全新机器自动建空库，Flyway 启动时迁移到最新版本（自带一个基线模型）。

### 常见问题

| 现象 | 处理 |
|---|---|
| 没装 Docker | 用方式 B（`deploy.bat`），或安装 Docker Desktop 后重试 |
| 8088 被占用 | 修改 .env 里的 WEB_PORT |
| 首次启动慢 | 首次要构建镜像并下载权重，约 3–6 分钟（本机模式要装 torch，更久） |
| 想看日志 | Docker：`docker compose logs -f`；本机：`D:\HDR-runtime\logs` |
| 提示缺 JDK/Node/Python | 按提示用 winget 安装，或把路径写进 `scripts/.env` |
| 端口被占用 | 先 `scripts\stop-all.ps1`，或换端口 |
| 权重下载失败 | 手动放到 `model-service/weights/`，再用 `-SkipDeps` 重跑 |
| torch 安装失败 | 重跑（会续用缓存），或配置 pip 镜像 |
| 数据库连接失败 | 改 `scripts/.env` 的 `DB_PASSWORD`，或用 `-MysqlRootPassword` 让脚本重置 |
| 启动后页面打不开 | 看 `D:\HDR-runtime\logs\web.err.log` |
