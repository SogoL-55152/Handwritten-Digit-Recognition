"""Java 专用 v2 契约；与 v1 的 HTTP-200 业务错误行为隔离。"""
import hmac
import re
import time

from flask import Blueprint, current_app, jsonify, request

from services.inference import ModelUnavailable
from services.inference_manifest import BASELINE, IMAGE_MAX_BYTES, REQUEST_MAX_BYTES
from services.inference_preprocess import InvalidImage, preprocess_image

bp = Blueprint("internal_v2", __name__)
FIELDS = frozenset(("workspaceId", "requestId", "modelId", "modelVersion", "preprocessVersion"))
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\Z")


def is_internal_request():
    return request.path == "/internal/v2" or request.path.startswith("/internal/v2/")


def error_response(status, message, category, retry_after=None):
    data = {"category": category}
    if retry_after is not None:
        data["retryAfterSeconds"] = retry_after
    response = jsonify({"code": status, "message": message, "data": data})
    response.status_code = status
    if retry_after is not None:
        response.headers["Retry-After"] = str(retry_after)
    return response


def authenticate_internal():
    if not is_internal_request():
        return None
    # 先鉴权再解析 multipart；未配置密钥时 fail closed。
    token = current_app.config.get("MODEL_INTERNAL_TOKEN", "")
    if not token or not token.strip():
        return error_response(503, "内部认证尚未配置", "NOT_CONFIGURED")
    provided = request.headers.get("X-HDR-Internal-Token", "")
    if len(provided) > 4096 or not hmac.compare_digest(provided.encode("utf-8"), token.encode("utf-8")):
        return error_response(401, "内部认证失败", "UNAUTHORIZED")
    request.max_content_length = REQUEST_MAX_BYTES
    request.max_form_memory_size = 128 * 1024
    request.max_form_parts = 6
    return None


@bp.get("/ready")
def ready():
    try:
        result = current_app.extensions["inference_service"].ensure_ready()
        return jsonify({"code": 0, "message": "ok", "data": result})
    except ModelUnavailable as exc:
        return error_response(503, str(exc), "MODEL_UNAVAILABLE")


def _validate_form():
    if request.mimetype != "multipart/form-data":
        return error_response(415, "请使用 multipart/form-data", "UNSUPPORTED_MEDIA_TYPE")
    if (set(request.form) != FIELDS or set(request.files) != {"image"}
            or any(len(request.form.getlist(key)) != 1 for key in FIELDS)
            or len(request.files.getlist("image")) != 1 or request.args):
        return error_response(400, "表单字段必须唯一且与内部接口约定一致", "INVALID_REQUEST")
    workspace_id = request.form["workspaceId"]
    request_id = request.form["requestId"]
    if (not re.fullmatch(r"[1-9][0-9]{0,18}", workspace_id)
            or int(workspace_id) > 9223372036854775807
            or not UUID_PATTERN.fullmatch(request_id)):
        return error_response(400, "workspaceId/requestId 无效", "INVALID_REQUEST")
    if any(request.form[key] != value for key, value in BASELINE.identity().items()):
        return error_response(400, "只允许已冻结的可信基线及预处理版本", "MODEL_NOT_ALLOWED")
    return None


@bp.post("/predict")
def predict():
    started = time.perf_counter()
    service = current_app.extensions["inference_service"]
    if not service.slots.acquire(blocking=False):
        return error_response(429, "推理并发已满，请稍后以新请求重试", "MODEL_BUSY", retry_after=1)
    try:
        invalid = _validate_form()
        if invalid is not None:
            return invalid
        image = request.files["image"]
        payload = image.stream.read(IMAGE_MAX_BYTES + 1)
        normalized = preprocess_image(payload, image.mimetype)
        digit, confidence = service.predict(normalized)
        return jsonify({
            "code": 0, "message": "ok", "data": {
                "requestId": request.form["requestId"],
                "digit": digit, "confidence": confidence,
                **BASELINE.identity(),
                "processingMs": max(0, round((time.perf_counter() - started) * 1000)),
            },
        })
    except InvalidImage as exc:
        return error_response(exc.status, str(exc), exc.category)
    except ImportError:
        return error_response(503, "推理依赖不可用", "MODEL_UNAVAILABLE")
    except ModelUnavailable as exc:
        return error_response(503, str(exc), "MODEL_UNAVAILABLE")
    finally:
        service.slots.release()
