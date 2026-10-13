from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["engine"] == "stub"
    assert body["voice"] == "cain"


def test_tts_returns_wav():
    r = client.post("/tts", json={"text": "Stay awhile and listen."})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content[:4] == b"RIFF"


def test_tts_empty_text_422():
    r = client.post("/tts", json={"text": ""})
    assert r.status_code == 422
