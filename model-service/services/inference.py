"""W2 只读 CPU 推理。导入此模块/创建 Flask app 不加载 torch 或权重。"""
import hashlib
import io
import logging
import threading
from pathlib import Path

from services.inference_manifest import BASELINE, INFERENCE_CONCURRENCY
from services.inference_policy import AcceptancePolicy, UncertainPrediction

logger = logging.getLogger(__name__)


class ModelUnavailable(RuntimeError):
    pass


class InferenceService:
    def __init__(self, checkpoint_path, policy=None):
        self.policy = policy if policy is not None else AcceptancePolicy()
        self._checkpoint_path = Path(checkpoint_path)
        self._load_lock = threading.Lock()
        self._load_attempted = False
        self._model = None
        self._torch = None
        self.slots = threading.BoundedSemaphore(INFERENCE_CONCURRENCY)

    def ensure_ready(self):
        with self._load_lock:
            if not self._load_attempted:
                self._load_attempted = True
                try:
                    # 同一份有界 bytes 完成摘要验证与反序列化，防止验证/加载路径竞态。
                    with self._checkpoint_path.open("rb") as stream:
                        payload = stream.read(BASELINE.checkpoint_bytes + 1)
                    if len(payload) != BASELINE.checkpoint_bytes:
                        raise ValueError("checkpoint size mismatch")
                    if hashlib.sha256(payload).hexdigest() != BASELINE.sha256:
                        raise ValueError("checkpoint digest mismatch")
                    import torch
                    from models.cnn import ARCHITECTURE
                    from services.mnist_training import load_checkpoint

                    if ARCHITECTURE != BASELINE.architecture():
                        raise ValueError("manifest architecture mismatch")
                    model, metadata = load_checkpoint(io.BytesIO(payload), device="cpu")
                    if metadata.get("epoch") != 3 or metadata.get("checkpoint_selection") != "final_epoch":
                        raise ValueError("checkpoint selection mismatch")
                    self._torch = torch
                    self._model = model
                except Exception as exc:
                    # 不向 HTTP 调用方暴露路径、内部异常或凭据。失败缓存直到重启。
                    logger.warning("Baseline unavailable (%s)", type(exc).__name__)
            if self._model is None:
                raise ModelUnavailable("可信基线未就绪，请检查服务配置后重启")
        return {"status": "UP", **BASELINE.identity(), "sha256": BASELINE.sha256}

    def probabilities(self, normalized):
        self.ensure_ready()
        torch = self._torch
        with torch.inference_mode():
            logits = self._model(torch.from_numpy(normalized).unsqueeze(0))
            if tuple(logits.shape) != (1, 10) or not torch.isfinite(logits).all().item():
                raise ModelUnavailable("模型输出无效")
            return torch.softmax(logits, dim=1)[0].tolist()

    def predict(self, normalized):
        self.ensure_ready()
        try:
            self.policy.check_input(normalized)
            return self.policy.select(self.probabilities(normalized))
        except UncertainPrediction as error:
            logger.info("Recognition declined (%s, %s)", self.policy.describe()["version"], error.reason)
            raise
        except ValueError as error:
            raise ModelUnavailable("模型输出或输入无效") from error
