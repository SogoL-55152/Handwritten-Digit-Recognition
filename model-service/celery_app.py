"""Celery 应用：Redis 作为 broker 与 result backend。"""
from celery import Celery

from config import Config

celery_app = Celery(
    "hdr",
    broker=Config.REDIS_URL,
    backend=Config.REDIS_URL,
)

celery_app.conf.update(
    task_always_eager=Config.CELERY_TASK_ALWAYS_EAGER,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Shanghai",
    enable_utc=False,
    # worker 启动时导入任务模块完成注册
    imports=("tasks",),
)
