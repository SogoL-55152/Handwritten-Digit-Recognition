# model-service — Flask 推理与训练服务

Python 3.10–3.12（推荐 3.11）/ Flask / PyTorch / Celery + Redis。该服务只在内网被 Spring Boot 调用。

> PyTorch 2.4 尚未提供 Python 3.13+ 的官方 wheel，请使用 3.11/3.12 虚拟环境。

## 本地启动

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py                    # http://localhost:5001
```

训练需要 Celery worker（另开终端）：

```bash
celery -A celery_app.celery_app worker --loglevel=info --concurrency=1
```

若只想快速演示、不想启动 Redis/Celery，可在 `.env` 中设置
`CELERY_TASK_ALWAYS_EAGER=1`，训练会在后台线程执行。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查 |
| POST | `/api/v1/predict` | multipart `file`，返回识别结果 |
| GET | `/api/v1/models` | 模型注册表 |
| POST | `/api/v1/models/{id}/activate` | 激活模型 |
| POST | `/api/v1/train` | 创建训练任务 |
| GET | `/api/v1/train/{task_id}` | 训练状态与指标 |

统一响应：`{ "code": 0, "message": "ok", "data": ... }`。

## 目录

```
config.py             环境配置
app.py                Flask 入口
celery_app.py         Celery 配置
tasks.py              异步训练任务
api/                  HTTP 接口
services/preprocess   图像归一化（与训练分布对齐）
services/model_registry  模型注册、热加载、推理
services/trainer      MNIST + CNN 训练循环
services/task_store   Redis 任务状态（无 Redis 时降级内存）
models/cnn.py         CNN 结构
weights/              权重与 registry.json（不提交）
data/                 MNIST 下载目录（不提交）
```

## 测试

```bash
pip install -r requirements-ci.txt
pytest -q
```

## 说明

- 该服务**没有鉴权**，只应作为内网服务被 Spring Boot 调用；生产环境不要将 5001 端口暴露到公网。
- 推理前请至少完成一次训练（或手动把权重登记到 `weights/registry.json`），否则返回“尚无可用模型”。
- CPU 环境安装 PyTorch 可使用官方 CPU wheel 源以减小体积：
  `pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cpu`
- 训练数据集当前为 MNIST；自采数据微调（W6）将在 `trainer.py` 中扩展。
