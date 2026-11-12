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
from services.inference_preprocess import InvalidImage, gray_from_payload, preprocess_image
from services.multidigit import normalize_segment, segments_of, top_guesses

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
    # 表单字段本身也占 part 数：单字请求是 5 字段 + 1 文件 = 6，留出余量给后续字段。
    request.max_form_parts = 8
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


def _validate_form(allow_args=()):
    if request.mimetype != "multipart/form-data":
        return error_response(415, "请使用 multipart/form-data", "UNSUPPORTED_MEDIA_TYPE")
    if (set(request.form) != FIELDS or set(request.files) != {"image"}
            or any(len(request.form.getlist(key)) != 1 for key in FIELDS)
            or len(request.files.getlist("image")) != 1
            or set(request.args) - set(allow_args)):
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


TRAINING_FIELDS = {"epochs", "samples", "batchSize", "learningRate", "seed", "photoRatio",
                   "useEmnist", "initFrom"}
MAX_TASK_ID = 19


def _validate_training_params(params):
    """与前端冻结原型一致的参数边界；返回错误文案或 None。"""
    if not isinstance(params, dict) or set(params) != TRAINING_FIELDS:
        return "训练参数字段必须与约定一致"
    epochs, samples, batch = params["epochs"], params["samples"], params["batchSize"]
    if isinstance(epochs, bool) or not isinstance(epochs, int) or not 1 <= epochs <= 5:
        return "epochs 必须在 1..5"
    if isinstance(samples, bool) or not isinstance(samples, int) or not 1000 <= samples <= 60000:
        return "samples 必须在 1000..60000"
    if isinstance(batch, bool) or batch not in (32, 64, 128):
        return "batchSize 必须是 32/64/128"
    rate = params["learningRate"]
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0 < rate <= 0.1:
        return "learningRate 必须在 (0, 0.1]"
    seed = params["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 4294967295:
        return "seed 必须是 0..4294967295 的整数"
    ratio = params["photoRatio"]
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not 0 <= ratio <= 1:
        return "photoRatio 必须在 0..1"
    if not isinstance(params["useEmnist"], bool):
        return "useEmnist 必须是布尔值"
    init_from = params["initFrom"]
    if init_from is not None and (not isinstance(init_from, str) or not TOKEN_PATTERN.fullmatch(init_from)):
        return "initFrom 必须是已注册的模型版本或 null"
    return None


@bp.post("/training")
def enqueue_training():
    """Java 网关入队训练任务；这里只校验参数并返回 Celery 任务 ID。"""
    if request.args or request.files:
        return error_response(400, "训练入队不接受查询参数或文件", "INVALID_REQUEST")
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or set(body) != {"taskId", "params"}:
        return error_response(400, "训练入队需要 taskId 与 params", "INVALID_REQUEST")
    task_id = body["taskId"]
    if not isinstance(task_id, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", task_id):
        return error_response(400, "taskId 无效", "INVALID_REQUEST")
    invalid = _validate_training_params(body["params"])
    if invalid:
        return error_response(400, invalid, "VALIDATION")
    try:
        from training_tasks import enqueue
        result = enqueue(task_id, body["params"])
    except Exception:  # noqa: BLE001 - Redis 不可用时不能假装入队成功
        current_app.logger.error("Training enqueue failed")
        return error_response(503, "训练队列暂不可用", "QUEUE_UNAVAILABLE")
    return jsonify({"code": 0, "message": "ok", "data": {"celeryTaskId": result.id}})


@bp.post("/predict")
def predict():
    started = time.perf_counter()
    try:
        service = None
        invalid = _validate_form(allow_args=("enhance",))
        if invalid is not None:
            return invalid
        enhance = request.args.get("enhance", "").lower() in ("1", "true", "yes")
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
            normalized = preprocess_image(payload, image.mimetype, enhance=enhance)
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

@bp.post("/predict/multi")
def predict_multi():
    """多位数字预览：切分后逐字识别。是否落库、是否计入统计由调用方决定。"""
    started = time.perf_counter()
    try:
        invalid = _validate_form(allow_args=("maxDigits",))
        if invalid is not None:
            return invalid
        try:
            max_digits = int(request.args.get("maxDigits", "3"))
        except (TypeError, ValueError):
            return error_response(400, "maxDigits 必须是 1–4", "VALIDATION")
        if max_digits not in (1, 2, 3, 4):
            return error_response(400, "maxDigits 必须是 1–4", "VALIDATION")
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
            gray = gray_from_payload(payload, image.mimetype)
            try:
                segments, ink, mask = segments_of(gray)
            except ValueError:
                return error_response(400, "请先书写数字，不能识别空白图片", "BLANK_IMAGE")
            if len(segments) > max_digits:
                return error_response(422, "检测到超过 %d 位数字，请减少一位后重试" % max_digits, "DIGIT_LIMIT")
            digits = []
            for segment in segments:
                normalized = normalize_segment(mask, ink, segment)
                if normalized is None:
                    continue
                digit, confidence, margin = top_guesses(service.probabilities(normalized))
                digits.append({"digit": digit, "confidence": round(confidence, 6), "margin": round(margin, 6),
                               "left": segment.left, "right": segment.right})
            if not digits:
                return error_response(400, "请先书写数字，不能识别空白图片", "BLANK_IMAGE")
            accepted = all(item["confidence"] >= 0.90 and item["margin"] >= 0.85 for item in digits)
            return jsonify({
                "code": 0, "message": "ok", "data": {
                    "requestId": request.form["requestId"],
                    "text": "".join(str(item["digit"]) for item in digits),
                    "digits": digits,
                    "accepted": accepted,
                    "maxDigits": max_digits,
                    **service.artifact.identity(),
                    "processingMs": max(0, round((time.perf_counter() - started) * 1000)),
                },
            })
        finally:
            service.slots.release()
    except InvalidImage as exc:
        return error_response(exc.status, str(exc), exc.category)
    except ImportError:
        return error_response(503, "推理依赖不可用", "MODEL_UNAVAILABLE")
    except ModelUnavailable as exc:
        return error_response(503, str(exc), "MODEL_UNAVAILABLE")

@bp.post("/enhance")
def enhance_preview():
    """返回增强后的图片（PNG），供前端预览"预处理后长什么样"。不落库。"""
    from io import BytesIO

    from PIL import Image

    from services.image_enhance import enhance_photo
    from services.inference_preprocess import InvalidImage, gray_from_payload

    image = request.files.get("image")
    if image is None:
        return error_response(400, "缺少图片", "INVALID_REQUEST")
    try:
        payload = image.stream.read(IMAGE_MAX_BYTES + 1)
        gray = gray_from_payload(payload, image.mimetype)
        enhanced = enhance_photo(gray)
    except InvalidImage as exc:
        return error_response(exc.status, str(exc), exc.category)
    except ValueError:
        return error_response(400, "图片对比度过低，无法分离笔迹", "BLANK_IMAGE")
    buffer = BytesIO()
    Image.fromarray(enhanced).save(buffer, format="PNG")
    return current_app.response_class(buffer.getvalue(), mimetype="image/png")
