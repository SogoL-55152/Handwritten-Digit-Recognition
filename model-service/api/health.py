from flask import Blueprint

from api.common import ok
from services.model_registry import TORCH_AVAILABLE, registry

bp = Blueprint("health", __name__)


@bp.get("/health")
def health():
    return ok({
        "status": "UP",
        "torchAvailable": TORCH_AVAILABLE,
        "registeredModels": len(registry.list_models()["models"]),
    })
