"""训练任务状态存储：优先 Redis，不可用时退化为进程内字典（仅开发）。"""
import copy
import json
import logging
import threading

from config import Config

try:
    import redis as redis_lib
except ImportError:  # pragma: no cover
    redis_lib = None

logger = logging.getLogger(__name__)
TASK_TTL_SECONDS = 24 * 3600


class TaskStore:
    def __init__(self, redis_url: str):
        self._memory = {}
        self._lock = threading.Lock()
        self._redis = None
        if redis_lib is None:
            logger.warning("redis 未安装，训练状态使用进程内存储")
            return
        try:
            client = redis_lib.Redis.from_url(
                redis_url, decode_responses=True, socket_connect_timeout=1, socket_timeout=2
            )
            client.ping()
            self._redis = client
            logger.info("训练状态存储：Redis")
        except Exception as exc:
            logger.warning("Redis 不可用（%s），训练状态使用进程内存储", exc)

    @staticmethod
    def _key(task_id: str) -> str:
        return f"train:{task_id}"

    def create_task(self, task_id: str, data: dict) -> None:
        self._write(task_id, data)

    def update_task(self, task_id: str, **changes) -> dict:
        data = self.get_task(task_id) or {"metrics": []}
        data.update(changes)
        self._write(task_id, data)
        return data

    def get_task(self, task_id: str):
        if self._redis is not None:
            raw = self._redis.get(self._key(task_id))
            return json.loads(raw) if raw else None
        with self._lock:
            data = self._memory.get(task_id)
            return copy.deepcopy(data) if data else None

    def _write(self, task_id: str, data: dict) -> None:
        if self._redis is not None:
            self._redis.setex(self._key(task_id), TASK_TTL_SECONDS, json.dumps(data))
            return
        with self._lock:
            self._memory[task_id] = copy.deepcopy(data)


task_store = TaskStore(Config.REDIS_URL)
