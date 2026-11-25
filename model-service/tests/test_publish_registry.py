"""训练产物写入 registry.json 的护栏。

背景：训练产物版本号是 w4-task-<taskId>-a<attempt>，而发布基线历史上也用过
w4-task-8-a1 这种名字。旧实现按版本号直接替换条目，会把已发布基线的权重
从注册表里顶掉，数据库摘要随之不一致（现场表现为 verified=false、无法再激活）。
"""
import json

import pytest

import training_tasks


def _registry(tmp_path, models):
    path = tmp_path / "registry.json"
    path.write_text(json.dumps({"models": models}, ensure_ascii=False), encoding="utf-8")
    return path


def _entry(version, sha):
    return {"modelId": "mnist-cnn-w1", "version": version, "preprocessVersion": "adaptive-mnist-v2",
            "artifact": f"w4-train/{version}/checkpoint.pt", "sha256": sha, "sizeBytes": 16}


def test_new_version_is_appended(tmp_path, monkeypatch):
    path = _registry(tmp_path, [_entry("w4-task-1-a1", "a" * 64)])
    monkeypatch.setenv("MODEL_REGISTRY_PATH", str(path))
    training_tasks._publish_registry("w4-task-2-a1", "w4-train/2/a1/checkpoint.pt", "b" * 64, 32)
    versions = [e["version"] for e in json.loads(path.read_text(encoding="utf-8"))["models"]]
    assert versions == ["w4-task-1-a1", "w4-task-2-a1"]


def test_same_digest_republish_is_idempotent(tmp_path, monkeypatch):
    path = _registry(tmp_path, [_entry("w4-task-1-a1", "a" * 64)])
    monkeypatch.setenv("MODEL_REGISTRY_PATH", str(path))
    training_tasks._publish_registry("w4-task-1-a1", "w4-train/1/a1/checkpoint.pt", "a" * 64, 16)
    models = json.loads(path.read_text(encoding="utf-8"))["models"]
    assert len(models) == 1
    assert models[0]["sha256"] == "a" * 64


def test_published_baseline_is_never_overwritten(tmp_path, monkeypatch):
    # 模拟"第 8 个任务的版本号恰好等于发布基线 w4-task-8-a1"
    path = _registry(tmp_path, [_entry("w4-task-8-a1", "b117effe" + "0" * 56)])
    monkeypatch.setenv("MODEL_REGISTRY_PATH", str(path))
    with pytest.raises(ValueError, match="不会覆盖已发布模型"):
        training_tasks._publish_registry("w4-task-8-a1", "w4-train/8/checkpoint.pt", "beef639e" + "0" * 56, 99)
    # 注册表内容保持原样
    models = json.loads(path.read_text(encoding="utf-8"))["models"]
    assert len(models) == 1
    assert models[0]["sha256"].startswith("b117effe")
