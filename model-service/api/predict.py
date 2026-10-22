from flask import Blueprint, current_app, request

from api.common import fail, ok
from services.model_registry import registry
from services.preprocess import preprocess_image

bp = Blueprint("predict", __name__)


@bp.post("/predict")
def predict():
    file = request.files.get("file")
    if file is None:
        return fail("缺少图片文件 file", 400)

    image_bytes = file.read()
    if not image_bytes:
        return fail("图片内容为空", 400)

    model_id = request.args.get("model_id")
    try:
        array = preprocess_image(image_bytes)
        result = registry.predict(array, model_id=model_id)
        return ok(result)
    except ValueError as exc:
        return fail(str(exc), 400)
    except Exception as exc:  # noqa: BLE001 - 对外统一错误信息
        current_app.logger.exception("Prediction failed")
        return fail(str(exc), 500)
