"""Flask 模型服务入口。仅内网使用，由 Spring Boot 网关调用。"""
import sys
from pathlib import Path

# 允许 python -I /trusted/source/app.py；不添加调用者 cwd 或数据目录。
SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from flask import Flask, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

from api.health import bp as health_bp
from api.internal_v2 import (
    authenticate_internal, bp as internal_bp, error_response, is_internal_request,
)
from config import Config
from services.inference_policy import AcceptancePolicy
from services.inference_registry import ModelRegistry

API_PREFIX = "/api/v1"


def create_app(config=None) -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)
    if config is not None:
        app.config.update(config)
    app.json.ensure_ascii = False
    CORS(app, resources={r"/api/v1/*": {"origins": "*"}})
    policy = AcceptancePolicy(app.config["RECOGNITION_MIN_CONFIDENCE"], app.config["RECOGNITION_MIN_MARGIN"])
    registry_path = Path(app.config["MODEL_REGISTRY_PATH"])
    app.extensions["model_registry"] = ModelRegistry(
        registry_path, Path(app.config["WEIGHTS_DIR"]), policy
    )
    app.logger.info("Recognition acceptance policy: %s", policy.describe())
    app.logger.info("Model registry: %s", registry_path.name)
    app.before_request(authenticate_internal)
    app.register_blueprint(health_bp, url_prefix=API_PREFIX)
    app.register_blueprint(internal_bp, url_prefix="/internal/v2")

    @app.errorhandler(HTTPException)
    def http_error(error):
        if is_internal_request():
            messages = {
                400: "请求格式无效", 404: "接口不存在", 405: "请求方法不允许",
                413: "请求或表单超过限制", 415: "请求格式不支持",
            }
            response = error_response(error.code, messages.get(error.code, "请求失败"), "HTTP_ERROR")
            if error.code == 405:
                response.headers["Allow"] = ", ".join(error.valid_methods or [])
            return response
        # W1 的 404 / 413 仍保持 HTTP 200，不改变历史调用方约定。
        if error.code == 413:
            return jsonify({"code": 400, "message": "上传文件过大，最大支持 5MB", "data": None})
        if error.code == 404:
            return jsonify({"code": 404, "message": "接口不存在", "data": None})
        return error

    @app.errorhandler(Exception)
    def unexpected_error(error):
        if not is_internal_request():
            raise error
        # 不记录请求正文/密钥/图片；错误包不含内部路径与异常详情。
        app.logger.error("Internal inference request failed (%s)", type(error).__name__)
        return error_response(500, "内部服务暂时不可用", "INTERNAL_ERROR")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host=app.config["HOST"], port=app.config["PORT"], debug=False)
