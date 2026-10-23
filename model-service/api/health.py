from flask import Blueprint

from api.common import ok

bp = Blueprint("health", __name__)


@bp.get("/health")
def health():
    return ok({"status": "UP"})
