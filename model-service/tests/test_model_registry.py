import json
import os

from services.model_registry import ModelRegistry


def test_registry_reloads_changes_written_by_another_process(tmp_path):
    registry = ModelRegistry(tmp_path)
    assert registry.list_models()["models"] == []

    state = {
        "models": [
            {"id": "abc123", "name": "cnn-v1", "path": str(tmp_path / "abc123.pt"), "accuracy": 0.98}
        ],
        "active": "abc123",
    }
    meta = tmp_path / "registry.json"
    meta.write_text(json.dumps(state), encoding="utf-8")
    # 模拟另一进程稍后写入，确保 mtime 变化
    future = meta.stat().st_mtime + 5
    os.utime(meta, (future, future))

    current = registry.list_models()
    assert current["active"] == "abc123"
    assert current["models"][0]["name"] == "cnn-v1"
