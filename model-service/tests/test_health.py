from app import create_app


def test_health_endpoint():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.get_json()
    assert body["code"] == 0
    assert body["data"]["status"] == "UP"


def test_unknown_route_returns_business_code():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/v1/not-exists")

    assert response.status_code == 200
    assert response.get_json()["code"] == 404
