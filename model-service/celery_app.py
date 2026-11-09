"""训练任务队列（Celery + Redis）。

本地演示用：solo 池、单 worker、10s visibility_timeout，目的是让"入队/消费/
崩溃重投/结果回写"四项可确定复现。这里不做高可用与多并发承诺，见
docs/W4-训练管理-设计与交付.md。
"""
from __future__ import annotations

import os

from celery import Celery

TRAINING_QUEUE = "training"


def create_celery():
    broker = os.getenv("REDIS_URL", "redis://127.0.0.1:16379/0")
    app = Celery("hdr-training", broker=broker, backend=broker,
                 include=["training_tasks"])
    app.conf.update(
        task_default_queue=TRAINING_QUEUE,
        # 任务在完成（ack）之前被判失败时允许重投；崩溃重投依赖 visibility_timeout。
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        # solo 池一次只取一个任务，让消费顺序与重投行为确定可断言。
        worker_prefetch_multiplier=1,
        broker_transport_options={
            "visibility_timeout": int(os.getenv("TRAINING_VISIBILITY_TIMEOUT", "10")),
        },
        task_track_started=True,
        task_soft_time_limit=int(os.getenv("TRAINING_SOFT_TIMEOUT", "600")),
        task_time_limit=int(os.getenv("TRAINING_HARD_TIMEOUT", "720")),
        result_expires=3600,
        broker_connection_retry_on_startup=True,
    )
    return app


celery_app = create_celery()
