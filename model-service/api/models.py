from flask import Blueprint

from api.common import fail, ok
from services.model_registry import registry

bp = Blueprint("models", __name__)


@bp.get("/models")
def list_models():
    return ok(registry.list_models())


@bp.post("/models/<model_id>/activate")
def activate_model(model_id: str):
    try:
        return ok(registry.activate(model_id))
    except KeyError as exc:
        return fail(str(exc), 404)
