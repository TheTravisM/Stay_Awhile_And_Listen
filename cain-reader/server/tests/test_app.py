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


def test_tts_unicode_not_422():
    # Emoji, curly quotes and newlines must pass validation, not 422.
    # This exercises the stub engine (no GPU); the real engine's behavior with
    # these characters still needs manual verification.
    text = "Emoji 😀 “curly quotes” and\nnew line\ttab."
    r = client.post("/tts", json={"text": text})
    assert r.status_code == 200
    assert r.content[:4] == b"RIFF"
