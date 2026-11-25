"""模型对比接口（/internal/v2/compare）契约测试。

假模型只返回固定概率，不对应任何准确率结论；目的是锁住"同一批图、两个模型、逐张对比"的契约。
"""
import hashlib
import json
import struct
import threading
import zlib
from io import BytesIO
from types import SimpleNamespace

import pytest

from app import create_app
from services.inference_manifest import BASELINE

TOKEN = "local-test-internal-token-not-a-real-secret"
HEADERS = {"X-HDR-Internal-Token": TOKEN}
ARTIFACT = b"test-only-artifact-bytes-not-a-real-checkpoint"
VERSION_A = "model-a-v1"
VERSION_B = "model-b-v1"
IDENTITY = BASELINE.identity()


def png():
    """固定白底黑笔画的小图，用标准库生成，避免依赖 Pillow 之外的东西。"""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(100):
        rows.append(0)
        for x in range(80):
            rows.extend(b"\x00\x00\x00" if 35 <= x <= 44 and 20 <= y <= 80 else b"\xff\xff\xff")
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 80, 100, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def registry_entry(version):
    return {"modelId": IDENTITY["modelId"], "version": version,
            "preprocessVersion": IDENTITY["preprocessVersion"], "artifact": "models/m.pt",
            "sha256": hashlib.sha256(ARTIFACT).hexdigest(), "sizeBytes": len(ARTIFACT)}


def write_registry(root, versions):
    artifact = root / "models" / "m.pt"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(ARTIFACT)
    path = root / "registry.json"
    path.write_text(json.dumps({"models": [registry_entry(v) for v in versions]}), encoding="utf-8")
    return path


class FakeService:
    """按预设脚本返回概率：script 是"这一次该预测成哪个数字"的列表。"""

    def __init__(self, artifact, script, slots=2):
        self.artifact = SimpleNamespace(identity=lambda: {
            "modelId": artifact.model_id, "modelVersion": artifact.version,
            "preprocessVersion": artifact.preprocess_version})
        self.slots = threading.BoundedSemaphore(slots)
        self.script = list(script)
        self.calls = 0

    def probabilities(self, normalized):
        digit = self.script[self.calls % len(self.script)]
        self.calls += 1
        vector = [0.01] * 10
        vector[digit] = 0.91
        return vector


@pytest.fixture
def make_app(tmp_path):
    def build(script_a, script_b, versions=(VERSION_A, VERSION_B), slots=2):
        app = create_app({"TESTING": True, "MODEL_INTERNAL_TOKEN": TOKEN,
                          "MODEL_REGISTRY_PATH": write_registry(tmp_path, list(versions)),
                          "WEIGHTS_DIR": tmp_path})
        registry = app.extensions["model_registry"]
        scripts = {VERSION_A: script_a, VERSION_B: script_b}
        registry._services = {}
        registry._service_factory = lambda path, policy=None, artifact=None: FakeService(
            artifact, scripts[artifact.version], slots)
        return app
    return build


def compare_form(labels, models=(VERSION_A, VERSION_B), images=3):
    data = {
        "modelAId": IDENTITY["modelId"], "modelAVersion": models[0],
        "modelAPreprocess": IDENTITY["preprocessVersion"],
        "modelBId": IDENTITY["modelId"], "modelBVersion": models[1],
        "modelBPreprocess": IDENTITY["preprocessVersion"],
        "labels": labels,
    }
    data["image"] = [(BytesIO(png()), f"d{i}.png", "image/png") for i in range(images)]
    return data


def test_compare_reports_per_image_and_summary(make_app):
    # A: 7,3,9   B: 7,4,0   真值: 7,3,0
    app = make_app(script_a=[7, 3, 9], script_b=[7, 4, 0])
    response = app.test_client().post("/internal/v2/compare", data=compare_form("7,3,0"), headers=HEADERS)
    assert response.status_code == 200
    data = response.json["data"]

    assert data["modelA"]["modelVersion"] == VERSION_A
    assert data["modelB"]["modelVersion"] == VERSION_B

    summary = data["summary"]
    assert summary["samples"] == 3 and summary["labelled"] == 3
    assert summary["agreement"] == 1                      # 只有第 1 张一致
    assert summary["agreementRate"] == 0.3333
    assert summary["accuracyA"] == 0.6667                 # 7、3 对
    assert summary["accuracyB"] == 0.6667                 # 7、0 对
    assert summary["bothRight"] == 1
    assert summary["onlyA"] == 1                          # 3：A 对 B 错
    assert summary["onlyB"] == 1                          # 0：B 对 A 错
    assert summary["bothWrong"] == 0
    assert summary["meanConfidenceA"] == 0.91

    rows = data["rows"]
    assert [row["digitA"] for row in rows] == [7, 3, 9]
    assert [row["digitB"] for row in rows] == [7, 4, 0]
    assert [row["agree"] for row in rows] == [True, False, False]
    assert rows[1]["label"] == 3 and rows[1]["digitA"] == 3 and rows[1]["digitB"] == 4


def test_unlabelled_samples_only_affect_agreement(make_app):
    app = make_app(script_a=[1, 2], script_b=[1, 3])
    response = app.test_client().post("/internal/v2/compare", data=compare_form("-1,-1", images=2),
                                      headers=HEADERS)
    assert response.status_code == 200
    summary = response.json["data"]["summary"]
    assert summary["labelled"] == 0
    assert summary["accuracyA"] is None and summary["accuracyB"] is None
    assert summary["agreement"] == 1 and summary["agreementRate"] == 0.5


def test_labels_count_must_match_images(make_app):
    app = make_app(script_a=[1], script_b=[1])
    # 3 个标签但只给 2 张图
    response = app.test_client().post("/internal/v2/compare", data=compare_form("1,2,3", images=2),
                                      headers=HEADERS)
    assert response.status_code == 400
    assert response.json["data"]["category"] == "INVALID_REQUEST"


@pytest.mark.parametrize("labels", ["7,3,", "7, 3,0", "ten", "7,,0"])
def test_invalid_labels_are_rejected(make_app, labels):
    app = make_app(script_a=[1], script_b=[1])
    response = app.test_client().post("/internal/v2/compare", data=compare_form(labels), headers=HEADERS)
    assert response.status_code == 400
    assert response.json["data"]["category"] == "INVALID_REQUEST"


def test_unregistered_model_is_rejected(make_app):
    app = make_app(script_a=[1], script_b=[1], versions=(VERSION_A,))
    response = app.test_client().post("/internal/v2/compare", data=compare_form("1,1,1"), headers=HEADERS)
    assert response.status_code == 400
    assert response.json["data"]["category"] == "MODEL_NOT_ALLOWED"


def test_busy_slots_return_429(make_app):
    app = make_app(script_a=[1], script_b=[1], slots=0)
    response = app.test_client().post("/internal/v2/compare", data=compare_form("1,1,1"), headers=HEADERS)
    assert response.status_code == 429
    assert response.json["data"]["category"] == "MODEL_BUSY"


def test_auth_failure_happens_before_body_parsing(make_app):
    app = make_app(script_a=[1], script_b=[1])
    response = app.test_client().post("/internal/v2/compare", data=b"malformed",
                                      headers={"X-HDR-Internal-Token": "wrong"})
    assert response.status_code == 401


def test_requires_multipart(make_app):
    app = make_app(script_a=[1], script_b=[1])
    response = app.test_client().post("/internal/v2/compare", json={"labels": "1"}, headers=HEADERS)
    assert response.status_code == 415
    assert response.json["data"]["category"] == "UNSUPPORTED_MEDIA_TYPE"
