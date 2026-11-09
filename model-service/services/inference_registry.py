"""多模型注册表。

唯一可信来源是服务器本地的 registry.json（管理员维护，不在请求里传入）。
每个条目在 reload 时做路径逃逸检查、大小检查与 SHA-256 摘要校验；校验失败的
条目不会进入可推理集合（fail closed，不回退到别的模型）。

条目不包含绝对路径，只有相对 MODEL_ROOT 的 artifact 名称。
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path, PurePosixPath
import threading

from services.inference import Artifact, InferenceService
from services.inference_policy import AcceptancePolicy

logger = logging.getLogger(__name__)

MAX_REGISTRY_BYTES = 256 * 1024
ENTRY_FIELDS = {"modelId", "version", "preprocessVersion", "artifact", "sha256", "sizeBytes"}


class RegistryInvalid(ValueError):
    """注册表本身不可用（缺失/结构错误），属于配置错误。"""


@dataclass(frozen=True)
class RegistryEntry:
    model_id: str
    version: str
    preprocess_version: str
    artifact: str
    sha256: str
    size_bytes: int

    def identity(self):
        return {"modelId": self.model_id, "modelVersion": self.version,
                "preprocessVersion": self.preprocess_version}

    @property
    def key(self):
        return (self.model_id, self.version)


def _token(value, field):
    if not isinstance(value, str) or not value or len(value) > 64:
        raise RegistryInvalid(f"registry entry field {field} must be a short non-empty string")
    return value


def _sha(value):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise RegistryInvalid("registry entry sha256 must be 64 lowercase hex characters")
    return value


def _size(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 512 * 1024 * 1024:
        raise RegistryInvalid("registry entry sizeBytes must be a positive integer")
    return value


def _artifact_path(root, name):
    if not isinstance(name, str) or not name or len(name) > 512 or "\\" in name or ":" in name:
        raise RegistryInvalid("registry entry artifact must be a relative POSIX path")
    pure = PurePosixPath(name)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise RegistryInvalid("registry entry artifact must not escape the model root")
    resolved = (root / pure).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise RegistryInvalid("registry entry artifact must stay inside the model root")
    return resolved


def parse_registry(document):
    """把 registry.json 解析为条目列表；结构错误整体拒绝。"""
    if not isinstance(document, dict) or set(document) != {"models"}:
        raise RegistryInvalid("registry must be an object with a single models list")
    models = document["models"]
    if not isinstance(models, list) or not 1 <= len(models) <= 64:
        raise RegistryInvalid("registry models must be a list of 1..64 entries")
    entries, seen = [], set()
    for index, item in enumerate(models, 1):
        if not isinstance(item, dict) or set(item) != ENTRY_FIELDS:
            raise RegistryInvalid(f"registry entry {index} must have exactly {sorted(ENTRY_FIELDS)}")
        entry = RegistryEntry(
            model_id=_token(item["modelId"], "modelId"),
            version=_token(item["version"], "version"),
            preprocess_version=_token(item["preprocessVersion"], "preprocessVersion"),
            artifact=item["artifact"],
            sha256=_sha(item["sha256"]),
            size_bytes=_size(item["sizeBytes"]),
        )
        if entry.key in seen:
            raise RegistryInvalid(f"registry entry {index} duplicates modelId+version")
        seen.add(entry.key)
        entries.append(entry)
    return entries


class ModelRegistry:
    """线程安全的多模型注册表；推理服务按 (modelId, version) 懒加载并缓存。"""

    def __init__(self, registry_path, model_root, policy=None, service_factory=InferenceService):
        self._registry_path = Path(registry_path)
        self._model_root = Path(model_root)
        self._policy = policy if policy is not None else AcceptancePolicy()
        self._service_factory = service_factory
        # reload() 在持锁期间要读取视图，因此用可重入锁。
        self._lock = threading.RLock()
        self._entries = {}
        self._unverified = {}
        self._services = {}
        self._error = None
        self.reload()

    def reload(self):
        with self._lock:
            try:
                entries = self._read()
                error = None
            except RegistryInvalid as invalid:
                # 注册表本身不可用时保持空集合：服务照常启动，但没有任何模型可用。
                entries, error = [], type(invalid).__name__
                logger.warning("Model registry unusable (%s)", type(invalid).__name__)
            verified, unverified = {}, {}
            for entry in entries:
                try:
                    path = _artifact_path(self._model_root, entry.artifact)
                    self._verify(path, entry)
                except (RegistryInvalid, OSError) as error_type:
                    unverified[entry.key] = type(error_type).__name__
                    logger.warning("Model %s/%s unusable (%s)", entry.model_id, entry.version,
                                   type(error_type).__name__)
                    continue
                verified[entry.key] = entry
            self._entries = verified
            self._unverified = unverified
            self._error = error
            # 只保留仍然有效的已加载模型；被替换的条目下次请求会重新校验并加载。
            self._services = {key: service for key, service in self._services.items() if key in verified}
            return self.public_entries()

    def _read(self):
        if not self._registry_path.is_file():
            raise RegistryInvalid("registry file is missing")
        if self._registry_path.stat().st_size > MAX_REGISTRY_BYTES:
            raise RegistryInvalid("registry file is too large")
        try:
            document = json.loads(self._registry_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RegistryInvalid("registry file is not valid JSON") from error
        return parse_registry(document)

    @staticmethod
    def _verify(path, entry):
        if not path.is_file():
            raise RegistryInvalid("artifact is missing")
        if path.stat().st_size != entry.size_bytes:
            raise RegistryInvalid("artifact size mismatch")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != entry.sha256:
            raise RegistryInvalid("artifact digest mismatch")

    def public_entries(self):
        with self._lock:
            verified = [{**entry.identity(), "sha256": entry.sha256, "sizeBytes": entry.size_bytes,
                         "artifact": entry.artifact, "verified": True, "loaded": entry.key in self._services}
                        for entry in self._entries.values()]
            rejected = [{"modelId": key[0], "modelVersion": key[1], "artifact": "",
                         "verified": False, "reason": reason} for key, reason in self._unverified.items()]
            return {"models": verified + rejected,
                    "registry": self._registry_path.name,
                    "error": getattr(self, "_error", None)}

    def service(self, model_id, version, preprocess_version):
        """按注册表路由到具体模型；未知模型或版本不符一律拒绝。"""
        with self._lock:
            entry = self._entries.get((model_id, version))
            if entry is None or entry.preprocess_version != preprocess_version:
                raise LookupError("model is not registered or preprocess version mismatched")
            service = self._services.get(entry.key)
            if service is None:
                artifact = Artifact(path=_artifact_path(self._model_root, entry.artifact),
                                    sha256=entry.sha256, size_bytes=entry.size_bytes,
                                    model_id=entry.model_id, version=entry.version,
                                    preprocess_version=entry.preprocess_version)
                service = self._service_factory(artifact.path, policy=self._policy, artifact=artifact)
                self._services[entry.key] = service
            return service

    def ready(self, model_id, version, preprocess_version):
        return self.service(model_id, version, preprocess_version).ensure_ready()
