# model-service — Flask 模型服务

Python 3.10–3.12（推荐 3.11）/ Flask。该服务只在内网被 Spring Boot 调用。

当前为工程骨架：仅提供健康检查与统一响应格式，推理、CNN、训练等模块待算法同学补充。

## 本地启动

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py                    # http://localhost:5001
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查 |

统一响应：`{ "code": 0, "message": "ok", "data": ... }`，见 `api/common.py` 的 `ok()` / `fail()`。

## 目录

```
config.py             环境配置
app.py                Flask 入口，注册蓝图
api/common.py         统一响应工具
api/health.py         健康检查
tests/                pytest
weights/              模型权重目录（不提交）
data/                 数据集目录（不提交）
```

## 测试

```bash
pip install -r requirements-ci.txt
pytest -q
```

## 扩展约定

- 新接口在 `api/` 下新建蓝图，并在 `app.py` 中注册，前缀统一 `/api/v1`
- 推理/预处理代码放 `services/`，模型结构放 `models/`
- 需要 PyTorch 时在 `requirements.txt` 增加 `torch==2.4.1 torchvision==0.19.1`
- 异步训练使用 Celery + Redis，届时在 `docker-compose.yml` 中恢复 worker 服务

## 说明

- 该服务**没有鉴权**，只应作为内网服务被 Spring Boot 调用；生产环境不要将 5001 端口暴露到公网。
- 骨架阶段 `requirements.txt` 仅含 Flask 依赖，镜像体积小、构建快。
