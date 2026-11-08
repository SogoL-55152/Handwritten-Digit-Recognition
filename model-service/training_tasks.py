"""训练任务实现：渲染训练集 → 训练 → 计算摘要 → 写注册表 → 回调 Java。

设计约束：
- 产物目录按 attempt 隔离，崩溃重投不会踩上一次的残留；成功后把校验过的
  checkpoint 落到稳定的 artifact 路径，并登记注册表条目。
- 指标与状态通过回调写回 Java（数据库是唯一事实来源），Python 不直接连 MySQL。
- 训练输入复用线上 canvas_input（见 train_canvas_aug），保证训练与线上同源。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request

from celery.exceptions import SoftTimeLimitExceeded
from celery.signals import worker_ready

from celery_app import TRAINING_QUEUE, celery_app

LEASE_SECONDS = int(os.getenv("TRAINING_LEASE_SECONDS", "30"))
REAPER_INTERVAL = float(os.getenv("TRAINING_REAPER_INTERVAL", "5"))
ACTIVE_SET = "training:active"


def _redis():
    import redis
    return redis.Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:16379/0"))

SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from services.inference_manifest import BASELINE  # noqa: E402
from train_canvas_aug import CanvasAugConfig, run  # noqa: E402

logger = logging.getLogger(__name__)

MAX_TASK_ID = 64


def weights_dir():
    return Path(os.getenv("WEIGHTS_DIR", SCRIPT_ROOT / "weights"))


def data_root():
    return Path(os.getenv("TRAINING_DATA_DIR", SCRIPT_ROOT / "data" / "MNIST" / "raw"))


def emnist_zip():
    value = os.getenv("TRAINING_EMNIST_ZIP", "")
    return Path(value) if value else None


def callback_base():
    return os.getenv("TRAINING_CALLBACK_URL", "http://127.0.0.1:8080")


def notify(task_id, payload):
    """把状态/指标写回 Java。回调失败要显式抛出：宁可任务失败，也不静默丢结果。"""
    token = os.getenv("MODEL_INTERNAL_TOKEN", "")
    if not token.strip():
        raise RuntimeError("MODEL_INTERNAL_TOKEN is not configured")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{callback_base()}/internal/v2/training/{task_id}/state", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-HDR-Internal-Token": token})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"callback rejected with {response.status}")


def _digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest(), path.stat().st_size


def _publish_registry(version, artifact_relative, sha256, size_bytes):
    """把新模型追加进 registry.json（原子替换），并返回重载后的注册表视图。"""
    path = Path(os.getenv("MODEL_REGISTRY_PATH", weights_dir() / "registry.json"))
    document = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"models": []}
    models = [entry for entry in document.get("models", []) if entry.get("version") != version]
    models.append({"modelId": BASELINE.model_id, "version": version,
                   "preprocessVersion": BASELINE.preprocess_version,
                   "artifact": artifact_relative, "sha256": sha256, "sizeBytes": size_bytes})
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"models": models}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def train_one(task_id, attempt, params):
    epochs = int(params["epochs"])
    samples = int(params["samples"])
    config = CanvasAugConfig(epochs=epochs, samples=samples, batch=int(params["batchSize"]),
                             learning_rate=float(params["learningRate"]), seed=int(params["seed"]),
                             photo_ratio=float(params["photoRatio"]))
    root = weights_dir() / "w4-train" / task_id
    attempt_dir = root / f"a{attempt}"
    if attempt_dir.exists():
        shutil.rmtree(attempt_dir)
    metrics = run(config, data_root(), attempt_dir, init=None, threads=int(os.getenv("TRAINING_THREADS", "2")),
                  emnist_zip=emnist_zip() if params.get("useEmnist") else None)
    stable = root / "checkpoint.pt"
    shutil.copyfile(attempt_dir / "checkpoint.pt", stable)
    sha256, size_bytes = _digest(stable)
    if sha256 != _digest(attempt_dir / "checkpoint.pt")[0]:
        raise RuntimeError("artifact copy digest mismatch")
    version = f"w4-task-{task_id}-a{attempt}"
    relative = f"w4-train/{task_id}/checkpoint.pt"
    _publish_registry(version, relative, sha256, size_bytes)
    return {"metrics": metrics, "version": version, "artifact": relative,
            "sha256": sha256, "sizeBytes": size_bytes}


def next_attempt(task_id):
    """投递次数以 Redis 原子计数为准：崩溃重投后仍是同一条消息，request.retries 不会自增。"""
    import redis
    client = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:16379/0"))
    key = f"training:attempt:{task_id}"
    attempt = int(client.incr(key))
    client.expire(key, 24 * 3600)
    return max(1, attempt)


@celery_app.task(bind=True, name="hdr.train", acks_late=True, max_retries=1)
def train_task(self, task_id, params):
    attempt = next_attempt(task_id)
    logger.info("training %s attempt %s", task_id, attempt)
    notify(task_id, {"state": "RUNNING", "attempt": attempt})
    with _Heartbeat(task_id):
        result, failure = _run_training(task_id, attempt, params)
    _finish(task_id)
    if failure is not None:
        raise failure
    payload = {"state": "SUCCEEDED", "attempt": attempt, "modelVersion": result["version"],
               "artifact": result["artifact"], "sha256": result["sha256"],
               "sizeBytes": result["sizeBytes"], "metrics": result["metrics"]}
    notify(task_id, payload)
    return {"taskId": task_id, "version": result["version"], "sha256": result["sha256"]}


def _finish(task_id):
    client = _redis()
    client.delete(_lease_key(task_id))
    client.delete(f"training:requeue:{task_id}")
    client.srem(ACTIVE_SET, task_id)
    client.delete(f"training:payload:{task_id}")


def _run_training(task_id, attempt, params):
    try:
        result = train_one(task_id, attempt, params)
    except SoftTimeLimitExceeded:
        notify(task_id, {"state": "FAILED", "attempt": attempt, "errorCategory": "TIMEOUT",
                         "errorMessage": "训练超时"})
        return None, SoftTimeLimitExceeded()
    except Exception as error:  # noqa: BLE001 - 需要把可读原因回写而不是吞掉
        logger.warning("training %s failed (%s)", task_id, type(error).__name__)
        notify(task_id, {"state": "FAILED", "attempt": attempt, "errorCategory": type(error).__name__,
                         "errorMessage": str(error)[:200]})
        return None, error
    return result, None


def enqueue(task_id, params):
    """入队前把参数快照留在 Redis，供租约超时后的重投使用。"""
    client = _redis()
    client.set(f"training:payload:{task_id}", json.dumps(params), ex=24 * 3600)
    client.sadd(ACTIVE_SET, task_id)
    return train_task.apply_async(args=[task_id, params], queue=TRAINING_QUEUE)


def _lease_key(task_id):
    return f"training:lease:{task_id}"


class _Heartbeat:
    """任务运行期间续租；worker 硬崩溃后心跳停止，租约过期即可判定需要重投。"""

    def __init__(self, task_id):
        self.task_id = task_id
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"lease-{task_id}")

    def _run(self):
        client = _redis()
        while not self._stop.wait(LEASE_SECONDS / 3):
            try:
                client.expire(_lease_key(self.task_id), LEASE_SECONDS)
            except Exception:  # noqa: BLE001 - 续租失败不应中断训练
                pass

    def __enter__(self):
        _redis().set(_lease_key(self.task_id), "1", ex=LEASE_SECONDS)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)


def reap_once():
    """把"活跃集合里存在但租约已过期"的任务重新入队；返回本次重投的任务 ID。"""
    client = _redis()
    requeued = []
    for raw in client.smembers(ACTIVE_SET):
        task_id = raw.decode() if isinstance(raw, bytes) else str(raw)
        if client.exists(_lease_key(task_id)):
            continue
        payload_raw = client.get(f"training:payload:{task_id}")
        if not payload_raw:
            client.srem(ACTIVE_SET, task_id)
            continue
        # 用 NX 抢一个短锁，避免多个 worker 同时重投同一任务。
        if not client.set(f"training:requeue:{task_id}", "1", nx=True, ex=LEASE_SECONDS):
            continue
        params = json.loads(payload_raw)
        train_task.apply_async(args=[task_id, params], queue=TRAINING_QUEUE)
        requeued.append(task_id)
        logger.warning("training %s re-enqueued after lease expiry", task_id)
    return requeued


@worker_ready.connect
def _start_reaper(sender, **_):
    """只在 worker 进程里起 reaper；API 进程不承担重投职责。"""
    def loop():
        while True:
            try:
                reap_once()
            except Exception:  # noqa: BLE001 - reaper 自身不能把 worker 拖死
                logger.warning("reaper tick failed")
            time.sleep(REAPER_INTERVAL)
    threading.Thread(target=loop, daemon=True, name="training-reaper").start()
