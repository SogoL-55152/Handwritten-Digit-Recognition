"""模型服务配置。所有配置均可通过环境变量覆盖。"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "hdr-model-service-dev")
    PORT = int(os.getenv("PORT", "5001"))
    HOST = os.getenv("HOST", "127.0.0.1")
    MODEL_INTERNAL_TOKEN = os.getenv("MODEL_INTERNAL_TOKEN", "")
    RECOGNITION_MIN_CONFIDENCE = float(os.getenv("RECOGNITION_MIN_CONFIDENCE", "0.90"))
    RECOGNITION_MIN_MARGIN = float(os.getenv("RECOGNITION_MIN_MARGIN", "0.85"))
    # 多模型：注册表是唯一可信来源，artifact 相对 MODEL_ROOT 解析。
    WEIGHTS_DIR = Path(os.getenv("WEIGHTS_DIR", BASE_DIR / "weights"))
    MODEL_REGISTRY_PATH = Path(os.getenv("MODEL_REGISTRY_PATH", WEIGHTS_DIR / "registry.json"))

    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    CELERY_TASK_ALWAYS_EAGER = os.getenv("CELERY_TASK_ALWAYS_EAGER", "0") == "1"

    DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
    DEFAULT_MODEL_NAME = os.getenv("DEFAULT_MODEL_NAME", "cnn-v1")

    MAX_CONTENT_LENGTH = 5 * 1024 * 1024

# Web 进程只读已有权重，不在导入时创建目录（只读挂载同样可运行）。
