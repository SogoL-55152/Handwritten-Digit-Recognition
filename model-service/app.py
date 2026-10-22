"""Flask 模型服务入口。仅内网使用，由 Spring Boot 网关调用。"""
from flask import Flask, jsonify
from flask_cors import CORS

from api.health import bp as health_bp
from api.models import bp as models_bp
from api.predict import bp as predict_bp
from api.train import bp as train_bp
from config import Config

API_PREFIX = "/api/v1"


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)
    app.config["MAX_CONTENT_LENGTH"] = Config.MAX_CONTENT_LENGTH
    app.json.ensure_ascii = False
    CORS(app)

    for blueprint in (health_bp, predict_bp, models_bp, train_bp):
        app.register_blueprint(blueprint, url_prefix=API_PREFIX)

    @app.errorhandler(413)
    def payload_too_large(_error):
        return jsonify({"code": 400, "message": "上传文件过大，最大支持 5MB", "data": None})

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({"code": 404, "message": "接口不存在", "data": None})

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=False)
