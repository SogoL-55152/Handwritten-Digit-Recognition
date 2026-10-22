from flask import jsonify


def ok(data=None):
    return jsonify({"code": 0, "message": "ok", "data": data})


def fail(message: str, code: int = 400):
    # 业务错误统一返回 HTTP 200，由调用方根据 code 判断，避免 RestClient 抛异常
    return jsonify({"code": code, "message": message, "data": None})
