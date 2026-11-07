"""Java 专用 v2 契约；与 v1 的 HTTP-200 业务错误行为隔离。

多模型：请求里的 modelId/modelVersion/preprocessVersion 必须在服务器本地
registry.json 中注册且摘要校验通过，否则拒绝；不再有"唯一冻结基线"的概念。
"""
import hmac
import re
import time

from flask import Blueprint, current_app, jsonify, request

from services.inference import ModelUnavailable
from services.inference_policy import UncertainPrediction
from services.inference_registry import MAX_REGISTRY_BYTES, RegistryInvalid
from services.inference_manifest import IMAGE_MAX_BYTES, REQUEST_MAX_BYTES
from services.inference_preprocess import InvalidImage, preprocess_image

bp = Blueprint("internal_v2", __name__)
FIELDS = frozenset(("workspaceId", "requestId", "modelId", "modelVersion", "preprocessVersion"))
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\Z")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


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
    request.max_content_length = max(REQUEST_MAX_BYTES, MAX_REGISTRY_BYTES)
    request.max_form_memory_size = 128 * 1024
    request.max_form_parts = 6
    return None


def registry():
    return current_app.extensions["model_registry"]


@bp.get("/ready")
def ready():
    """服务存活 + 注册表里至少有一个可用模型；具体模型就绪由 /models 报告。"""
    try:
        entries = registry().public_entries()
    except RegistryInvalid as exc:
        return error_response(503, f"模型注册表不可用：{exc}", "REGISTRY_INVALID")
    verified = [entry for entry in entries["models"] if entry["verified"]]
    if not verified:
        return error_response(503, "没有通过摘要校验的可用模型", "MODEL_UNAVAILABLE")
    return jsonify({"code": 0, "message": "ok",
                    "data": {"status": "UP", "verifiedModels": len(verified),
                             "models": entries["models"], "registry": entries["registry"]}})


@bp.get("/models")
def models():
    try:
        return jsonify({"code": 0, "message": "ok", "data": registry().public_entries()})
    except RegistryInvalid as exc:
        return error_response(503, f"模型注册表不可用：{exc}", "REGISTRY_INVALID")


@bp.post("/models/reload")
def reload_models():
    if request.args or request.form or request.get_json(silent=True) is not None:
        return error_response(400, "重载接口不接受任何参数", "INVALID_REQUEST")
    try:
        return jsonify({"code": 0, "message": "ok", "data": registry().reload()})
    except RegistryInvalid as exc:
        return error_response(503, f"模型注册表不可用：{exc}", "REGISTRY_INVALID")


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
    if any(not TOKEN_PATTERN.fullmatch(request.form[key])
           for key in ("modelId", "modelVersion", "preprocessVersion")):
        return error_response(400, "模型标识格式无效", "INVALID_REQUEST")
    return None


@bp.post("/predict")
def predict():
    started = time.perf_counter()
    try:
        service = None
        invalid = _validate_form()
        if invalid is not None:
            return invalid
        try:
            service = registry().service(request.form["modelId"], request.form["modelVersion"],
                                         request.form["preprocessVersion"])
        except LookupError:
            return error_response(400, "只允许使用已注册且预处理版本匹配的模型", "MODEL_NOT_ALLOWED")
        if service is None or not service.slots.acquire(blocking=False):
            return error_response(429, "推理并发已满，请稍后以新请求重试", "MODEL_BUSY", retry_after=1)
        try:
            image = request.files["image"]
            payload = image.stream.read(IMAGE_MAX_BYTES + 1)
            normalized = preprocess_image(payload, image.mimetype)
            digit, confidence = service.predict(normalized)
            return jsonify({
                "code": 0, "message": "ok", "data": {
                    "requestId": request.form["requestId"],
                    "digit": digit, "confidence": confidence,
                    **service.artifact.identity(),
                    "processingMs": max(0, round((time.perf_counter() - started) * 1000)),
                },
            })
        finally:
            service.slots.release()
    except UncertainPrediction as exc:
        return error_response(422, str(exc), "UNRECOGNIZED_INPUT")
    except InvalidImage as exc:
        return error_response(exc.status, str(exc), exc.category)
    except ImportError:
        return error_response(503, "推理依赖不可用", "MODEL_UNAVAILABLE")
    except ModelUnavailable as exc:
        return error_response(503, str(exc), "MODEL_UNAVAILABLE")
