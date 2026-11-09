"""Lightweight Flask contract tests; fake predictor is test-only, not an accuracy claim."""
from io import BytesIO
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest
from werkzeug.datastructures import MultiDict

from app import create_app
from services.inference import ModelUnavailable
from services.inference_manifest import BASELINE, IMAGE_MAX_BYTES, REQUEST_MAX_BYTES

TOKEN = "local-test-internal-token-not-a-real-secret"
RID = "f740afce-7fd9-4b81-89d0-a08de3a55fe3"
HEADERS = {"X-HDR-Internal-Token": TOKEN}
ARTIFACT = b"test-only-artifact-bytes-not-a-real-checkpoint"


def registry_entry(**overrides):
    identity = BASELINE.identity()
    entry = {"modelId": identity["modelId"], "version": identity["modelVersion"],
             "preprocessVersion": identity["preprocessVersion"], "artifact": "models/m.pt",
             "sha256": hashlib.sha256(ARTIFACT).hexdigest(), "sizeBytes": len(ARTIFACT)}
    entry.update(overrides)
    return entry


def write_registry(root, entries):
    artifact = root / "models" / "m.pt"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(ARTIFACT)
    path = root / "registry.json"
    path.write_text(json.dumps({"models": entries}), encoding="utf-8")
    return path


def png():
    # Fixed synthetic white canvas / black stroke, built using stdlib so auth/form
    # validation can run in an existing Flask-only environment without Pillow.
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(100):
        rows.append(0)
        for x in range(80):
            rows.extend(b"\x00\x00\x00" if 35 <= x <= 44 and 20 <= y <= 80 else b"\xff\xff\xff")
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 80, 100, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def form(**overrides):
    fields = {"workspaceId": "1", "requestId": RID, **BASELINE.identity()}
    fields.update(overrides)
    fields["image"] = (BytesIO(png()), "digit.png", "image/png")
    return fields


@pytest.fixture
def app(tmp_path):
    return create_app({"TESTING": True, "MODEL_INTERNAL_TOKEN": TOKEN,
                       "MODEL_REGISTRY_PATH": write_registry(tmp_path, [registry_entry()]),
                       "WEIGHTS_DIR": tmp_path})


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def fake(app):
    calls = []
    def predict(normalized):
        calls.append(normalized)
        return 7, 0.9
    service = SimpleNamespace(
        slots=threading.BoundedSemaphore(2), predict=predict,
        ensure_ready=lambda: {"status": "UP", **BASELINE.identity(), "sha256": "test"},
        artifact=SimpleNamespace(identity=BASELINE.identity),
    )
    registry = app.extensions["model_registry"]
    registry._service_factory = lambda *args, **kwargs: service
    registry._services = {}
    return calls


@pytest.mark.parametrize("path,method", [("/ready", "get"), ("/predict", "post"), ("/missing", "get")])
@pytest.mark.parametrize("token", [None, "wrong", "x" * 5000, "测试token"])
def test_internal_auth_before_body_parsing(client, path, method, token):
    headers = {} if token is None else {"X-HDR-Internal-Token": token}
    response = getattr(client, method)("/internal/v2" + path, data=b"malformed", headers=headers)
    assert response.status_code == 401
    assert response.json["code"] == 401


@pytest.mark.parametrize("token", ["", "   "])
def test_missing_token_configuration_fails_closed(app, token):
    app.config["MODEL_INTERNAL_TOKEN"] = token
    response = app.test_client().get("/internal/v2/ready", headers=HEADERS)
    assert response.status_code == 503
    assert response.json["data"]["category"] == "NOT_CONFIGURED"


def fake_service(app):
    """取注册表为该模型创建的服务实例（测试里已被替换成假实现）。"""
    identity = BASELINE.identity()
    return app.extensions["model_registry"].service(identity["modelId"], identity["modelVersion"],
                                                     identity["preprocessVersion"])


def test_ready_reports_verified_model(client, fake):
    response = client.get("/internal/v2/ready", headers=HEADERS)
    assert response.status_code == 200
    data = response.json["data"]
    assert data["status"] == "UP" and data["verifiedModels"] == 1
    assert data["registry"] == "registry.json"
    entry = data["models"][0]
    assert {key: entry[key] for key in ("modelId", "modelVersion", "preprocessVersion")} == BASELINE.identity()
    assert entry["verified"] is True


def test_missing_registry_returns_sanitized_503(tmp_path):
    app = create_app({"TESTING": True, "MODEL_INTERNAL_TOKEN": TOKEN,
                      "MODEL_REGISTRY_PATH": tmp_path / "secret-registry.json", "WEIGHTS_DIR": tmp_path})
    response = app.test_client().get("/internal/v2/ready", headers=HEADERS)
    assert response.status_code == 503
    body = response.get_data(as_text=True)
    assert "secret-registry.json" not in body and TOKEN not in body


def test_digest_mismatch_is_not_usable(tmp_path, client=None, fake=None):
    entry = registry_entry(sha256="0" * 64)
    app = create_app({"TESTING": True, "MODEL_INTERNAL_TOKEN": TOKEN,
                      "MODEL_REGISTRY_PATH": write_registry(tmp_path, [entry]), "WEIGHTS_DIR": tmp_path})
    probe = app.test_client()
    assert probe.get("/internal/v2/ready", headers=HEADERS).status_code == 503
    listed = probe.get("/internal/v2/models", headers=HEADERS).json["data"]["models"]
    assert listed[0]["verified"] is False and listed[0]["reason"] == "RegistryInvalid"
    rejected = probe.post("/internal/v2/predict", headers=HEADERS, data=form())
    assert rejected.status_code == 400 and rejected.json["data"]["category"] == "MODEL_NOT_ALLOWED"


def test_models_listing_and_reload(client, fake):
    listed = client.get("/internal/v2/models", headers=HEADERS)
    assert listed.status_code == 200
    assert [entry["verified"] for entry in listed.json["data"]["models"]] == [True]
    reloaded = client.post("/internal/v2/models/reload", headers=HEADERS)
    assert reloaded.status_code == 200 and reloaded.json["data"]["models"][0]["verified"] is True
    with_query = client.post("/internal/v2/models/reload?x=1", headers=HEADERS)
    assert with_query.status_code == 400


def test_unknown_model_version_is_rejected(client, fake):
    response = client.post("/internal/v2/predict", headers=HEADERS,
                           data=form(modelVersion="not-registered"))
    assert response.status_code == 400 and response.json["data"]["category"] == "MODEL_NOT_ALLOWED"
    assert not fake


def test_predict_exact_schema(client, fake):
    response = client.post("/internal/v2/predict", headers=HEADERS, data=form())
    assert response.status_code == 200
    body = response.json
    assert body["code"] == 0 and body["message"] == "ok"
    assert set(body["data"]) == {"requestId", "digit", "confidence", "modelId", "modelVersion", "preprocessVersion", "processingMs"}
    assert body["data"]["requestId"] == RID
    assert body["data"]["digit"] == 7 and body["data"]["confidence"] == 0.9
    assert type(body["data"]["processingMs"]) is int and body["data"]["processingMs"] >= 0
    assert len(fake) == 1 and fake[0].shape == (1, 28, 28)


@pytest.mark.parametrize("key,value", [
    ("workspaceId", "0"), ("workspaceId", "-1"), ("workspaceId", "1.2"),
    ("workspaceId", "9223372036854775808"), ("workspaceId", "../weights"),
    ("requestId", "bad"), ("requestId", RID + "\n"),
    ("modelId", "../../weights/w1-smoke/checkpoint.pt"), ("modelId", "https://attacker/model.pt"),
    ("modelVersion", "w1-smoke"), ("preprocessVersion", "random"),
])
def test_bad_ids_and_allowlist_rejected(client, fake, key, value):
    response = client.post("/internal/v2/predict", headers=HEADERS, data=form(**{key: value}))
    assert response.status_code == 400
    assert not fake


@pytest.mark.parametrize("key", ["image", "workspaceId", "requestId", "modelId", "modelVersion", "preprocessVersion"])
def test_missing_fields(client, fake, key):
    fields = form()
    del fields[key]
    response = client.post("/internal/v2/predict", headers=HEADERS, data=fields, content_type="multipart/form-data")
    assert response.status_code == 400
    assert not fake


@pytest.mark.parametrize("key", ["workspaceId", "image", "path", "url"])
def test_duplicate_or_extra_fields_rejected(client, fake, key):
    fields = MultiDict(form())
    fields.add(key, (BytesIO(png()), "extra.png", "image/png") if key == "image" else "unexpected")
    response = client.post("/internal/v2/predict", headers=HEADERS, data=fields)
    assert response.status_code in (400, 413)
    assert not fake


def test_query_parameters_cannot_supply_paths(client, fake):
    response = client.post("/internal/v2/predict?path=/etc/passwd", headers=HEADERS, data=form())
    assert response.status_code == 400 and not fake


@pytest.mark.parametrize("data,ctype", [(b"{}", "application/json"), (b"broken", "multipart/form-data; boundary=x")])
def test_wrong_or_malformed_multipart(client, fake, data, ctype):
    response = client.post("/internal/v2/predict", headers=HEADERS, data=data, content_type=ctype)
    assert response.status_code in (400, 415) and not fake


def test_file_byte_limit(client, fake):
    fields = form()
    fields["image"] = (BytesIO(b"x" * (IMAGE_MAX_BYTES + 1)), "large.png", "image/png")
    response = client.post("/internal/v2/predict", headers=HEADERS, data=fields)
    assert response.status_code == 413 and not fake


def test_request_byte_limit(client, fake):
    response = client.post("/internal/v2/predict", headers=HEADERS,
                           data=b"x" * (REQUEST_MAX_BYTES + 1), content_type="multipart/form-data; boundary=x")
    assert response.status_code == 413 and not fake


def test_field_memory_limit(client, fake):
    response = client.post("/internal/v2/predict", headers=HEADERS, data=form(workspaceId="1" * (130 * 1024)))
    assert response.status_code == 413 and not fake


def test_large_valid_png_below_five_mib_is_accepted(client, fake):
    # Format/transport test only: a fake predictor deliberately bypasses real input-quality policy.
    # Incompressible 800×800 RGB (~1.9MiB): catches accidental 16KiB multipart limits.
    import numpy as np
    from PIL import Image
    pixels = np.random.default_rng(42).integers(0, 256, (800, 800, 3), dtype=np.uint8)
    stream = BytesIO()
    Image.fromarray(pixels).save(stream, format="PNG")
    fields = form()
    fields["image"] = (BytesIO(stream.getvalue()), "large.png", "image/png")
    response = client.post("/internal/v2/predict", headers=HEADERS, data=fields)
    assert response.status_code == 200 and len(fake) == 1


def test_uncertain_prediction_is_422_without_a_guessed_digit_and_releases_slot(app, client, fake):
    from services.inference_policy import UncertainPrediction, REJECTION_MESSAGE
    service = fake_service(app)
    service.predict = lambda _normalized: (_ for _ in ()).throw(UncertainPrediction("low_score"))
    response = client.post("/internal/v2/predict", headers=HEADERS, data=form())
    assert response.status_code == 422
    assert response.json == {"code": 422, "message": REJECTION_MESSAGE, "data": {"category": "UNRECOGNIZED_INPUT"}}
    assert "digit" not in response.json["data"]
    assert service.slots.acquire(False) and service.slots.acquire(False)
    service.slots.release()
    service.slots.release()


def test_blank_http_error(client, fake):
    from PIL import Image
    stream = BytesIO()
    Image.new("RGB", (30, 30), "white").save(stream, format="PNG")
    fields = form()
    fields["image"] = (BytesIO(stream.getvalue()), "blank.png", "image/png")
    response = client.post("/internal/v2/predict", headers=HEADERS, data=fields)
    assert response.status_code == 400 and response.json["data"]["category"] == "BLANK_IMAGE"
    assert not fake


def test_concurrency_limit_and_slot_release(app, client, fake):
    service = fake_service(app)
    assert service.slots.acquire(False) and service.slots.acquire(False)
    try:
        response = client.post("/internal/v2/predict", headers=HEADERS, data=form())
        assert response.status_code == 429 and response.headers["Retry-After"] == "1"
        assert response.json["data"]["category"] == "MODEL_BUSY"
        assert not fake
    finally:
        service.slots.release()
        service.slots.release()
    # Invalid request also releases its slot.
    assert client.post("/internal/v2/predict", headers=HEADERS, data=form(requestId="bad")).status_code == 400
    assert service.slots.acquire(False) and service.slots.acquire(False)
    service.slots.release()
    service.slots.release()


@pytest.mark.parametrize("exception,status", [(ModelUnavailable("不可用"), 503), (RuntimeError("secret/path.pt"), 500)])
def test_inference_failure_sanitized_and_releases_slot(app, client, fake, exception, status):
    service = fake_service(app)
    def fail(_normalized):
        raise exception
    service.predict = fail
    response = client.post("/internal/v2/predict", headers=HEADERS, data=form())
    assert response.status_code == status
    assert "secret/path.pt" not in response.get_data(as_text=True)
    assert service.slots.acquire(False) and service.slots.acquire(False)
    service.slots.release()
    service.slots.release()


def test_internal_status_and_v1_compatibility(client):
    assert client.get("/internal/v2/nope", headers=HEADERS).status_code == 404
    response = client.get("/internal/v2/predict", headers=HEADERS)
    assert response.status_code == 405 and "POST" in response.headers["Allow"]
    assert client.get("/api/v1/health").json["data"]["status"] == "UP"
    response = client.get("/api/v1/nope")
    assert response.status_code == 200 and response.json["code"] == 404


def test_internal_routes_do_not_enable_browser_cors(client, fake):
    response = client.get("/internal/v2/ready", headers={**HEADERS, "Origin": "https://untrusted.example"})
    assert "Access-Control-Allow-Origin" not in response.headers


def test_app_creation_import_safe_without_torch():
    root = str(Path(__file__).resolve().parents[1])
    script = """
import sys
sys.path.insert(0, sys.argv[1])
class NoTorch:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('torch', 'torchvision'):
            raise AssertionError('Unexpected heavyweight import: ' + fullname)
sys.meta_path.insert(0, NoTorch())
from app import create_app
app = create_app({'MODEL_INTERNAL_TOKEN': 'test', 'MODEL_REGISTRY_PATH': '/missing-registry.json', 'WEIGHTS_DIR': '/'})
assert app.test_client().get('/api/v1/health').status_code == 200
assert app.test_client().get('/internal/v2/ready', headers={'X-HDR-Internal-Token':'test'}).status_code == 503
assert 'torch' not in sys.modules and 'torchvision' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, root], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
