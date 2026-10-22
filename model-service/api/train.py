import threading
import uuid

from flask import Blueprint, current_app, request

from api.common import fail, ok
from config import Config
from services.task_store import task_store
from tasks import train_model_task

bp = Blueprint("train", __name__)


def _normalize_params(payload: dict) -> dict:
    raw = payload.get("params") or {}
    return {
        "epochs": max(1, min(int(raw.get("epochs", 3)), 50)),
        "batchSize": max(1, min(int(raw.get("batchSize", 128)), 2048)),
        "learningRate": float(raw.get("learningRate", 0.001)),
        "modelName": payload.get("model_name") or Config.DEFAULT_MODEL_NAME,
        "dataset": payload.get("dataset") or "MNIST",
    }


@bp.post("/train")
def start_training():
    payload = request.get_json(silent=True) or {}
    try:
        params = _normalize_params(payload)
    except (TypeError, ValueError) as exc:
        return fail(f"训练参数格式错误：{exc}", 400)

    task_id = str(payload.get("task_id") or uuid.uuid4().hex)
    task_store.create_task(task_id, {
        "status": "PENDING",
        "progress": 0,
        "epoch": 0,
        "metrics": [],
        "model": None,
        "error": None,
    })

    try:
        if Config.CELERY_TASK_ALWAYS_EAGER:
            # 开发模式：不开 worker，直接在后台线程训练
            threading.Thread(
                target=train_model_task, args=(task_id, params), daemon=True
            ).start()
        else:
            train_model_task.delay(task_id, params)
    except Exception as exc:  # broker 不可用等
        current_app.logger.exception("Failed to enqueue training task")
        task_store.update_task(task_id, status="FAILED", error=f"任务入队失败：{exc}")
        return fail(f"任务入队失败：{exc}", 502)

    return ok({"task_id": task_id})


@bp.get("/train/<task_id>")
def training_status(task_id: str):
    task = task_store.get_task(task_id)
    if task is None:
        return fail(f"训练任务不存在或已过期：{task_id}", 404)
    return ok(task)
