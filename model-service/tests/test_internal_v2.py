"""Lightweight Flask contract tests; fake predictor is test-only, not an accuracy claim."""
from io import BytesIO
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
    return create_app({"TESTING": True, "MODEL_INTERNAL_TOKEN": TOKEN, "MODEL_CHECKPOINT_PATH": tmp_path / "missing.pt"})


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
        ensure_ready=lambda: {"status": "UP", **BASELINE.identity(), "sha256": BASELINE.sha256},
    )
    app.extensions["inference_service"] = service
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


def test_ready_exact_schema(client, fake):
    response = client.get("/internal/v2/ready", headers=HEADERS)
    assert response.status_code == 200
    assert response.json == {"code": 0, "message": "ok", "data": {"status": "UP", **BASELINE.identity(), "sha256": BASELINE.sha256}}


def test_missing_checkpoint_returns_sanitized_503(client):
    response = client.get("/internal/v2/ready", headers=HEADERS)
    assert response.status_code == 503
    assert "missing.pt" not in response.get_data(as_text=True)
    assert TOKEN not in response.get_data(as_text=True)


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
    service = app.extensions["inference_service"]
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
    service = app.extensions["inference_service"]
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
    service = app.extensions["inference_service"]
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
app = create_app({'MODEL_INTERNAL_TOKEN': 'test', 'MODEL_CHECKPOINT_PATH': '/missing.pt'})
assert app.test_client().get('/api/v1/health').status_code == 200
assert app.test_client().get('/internal/v2/ready', headers={'X-HDR-Internal-Token':'test'}).status_code == 503
assert 'torch' not in sys.modules and 'torchvision' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, root], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
