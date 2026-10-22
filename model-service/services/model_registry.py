"""模型注册表：维护权重文件、元数据与活跃模型，状态持久化到 registry.json。"""
import json
import logging
import threading
import uuid
from pathlib import Path

from config import Config

try:
    import torch
    from models.cnn import DigitCNN

    TORCH_AVAILABLE = True
except ImportError:  # 未安装 PyTorch 时仍允许启动服务/运行预处理测试
    torch = None
    DigitCNN = None
    TORCH_AVAILABLE = False

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self, weights_dir: Path):
        self.weights_dir = Path(weights_dir)
        self.weights_dir.mkdir(parents=True, exist_ok=True)
        self._meta_path = self.weights_dir / "registry.json"
        self._lock = threading.RLock()
        self._loaded = {}
        self._state = self._read_state()
        try:
            self._last_mtime = self._meta_path.stat().st_mtime_ns
        except OSError:
            self._last_mtime = 0

    def _read_state(self) -> dict:
        if self._meta_path.exists():
            try:
                state = json.loads(self._meta_path.read_text(encoding="utf-8"))
                state.setdefault("models", [])
                state.setdefault("active", None)
                return state
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("读取模型注册表失败，使用空注册表：%s", exc)
        return {"models": [], "active": None}

    def _write_state(self) -> None:
        temp = self._meta_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self._meta_path)
        try:
            self._last_mtime = self._meta_path.stat().st_mtime_ns
        except OSError:
            self._last_mtime = 0

    def _refresh(self) -> None:
        """worker 与 API 分属不同进程，写盘后需按 mtime 重新加载。"""
        try:
            mtime = self._meta_path.stat().st_mtime_ns
        except OSError:
            return
        with self._lock:
            if mtime != self._last_mtime:
                self._state = self._read_state()
                self._last_mtime = mtime

    def list_models(self) -> dict:
        self._refresh()
        with self._lock:
            return {"models": list(self._state["models"]), "active": self._state["active"]}

    def register(self, name: str, path: Path, accuracy: float) -> dict:
        model = {
            "id": uuid.uuid4().hex[:12],
            "name": name,
            "path": str(path),
            "accuracy": round(float(accuracy), 4),
        }
        self._refresh()
        with self._lock:
            self._state["models"].append(model)
            if not self._state["active"]:
                self._state["active"] = model["id"]
            self._write_state()
        logger.info("Registered model %s (%s)", name, model["id"])
        return model

    def activate(self, model_id: str) -> dict:
        self._refresh()
        with self._lock:
            for model in self._state["models"]:
                if model["id"] == model_id:
                    self._state["active"] = model_id
                    self._write_state()
                    return model
        raise KeyError(f"模型不存在：{model_id}")

    def _resolve(self, model_id: str | None) -> dict:
        self._refresh()
        with self._lock:
            target = model_id or self._state["active"]
            for model in self._state["models"]:
                if model["id"] == target:
                    return dict(model)
        raise RuntimeError("尚无可用模型，请先在管理端完成一次训练")

    def _load_network(self, model: dict):
        if not TORCH_AVAILABLE:
            raise RuntimeError("PyTorch 未安装，无法执行推理")

        path = Path(model["path"])
        if not path.exists():
            raise RuntimeError(f"模型文件不存在：{path}")

        cache_key = str(path)
        with self._lock:
            if cache_key in self._loaded:
                return self._loaded[cache_key]
            network = DigitCNN()
            network.load_state_dict(torch.load(path, map_location="cpu"))
            network.eval()
            self._loaded[cache_key] = network
            return network

    def predict(self, array, model_id: str | None = None) -> dict:
        model = self._resolve(model_id)
        network = self._load_network(model)
        with torch.no_grad():
            logits = network(torch.from_numpy(array))
            probabilities = torch.softmax(logits, dim=1)
            confidence, prediction = probabilities.max(dim=1)
        return {
            "result": str(int(prediction.item())),
            "confidence": round(float(confidence.item()), 4),
            "model_id": model["id"],
            "model_name": model["name"],
        }


registry = ModelRegistry(Config.WEIGHTS_DIR)
