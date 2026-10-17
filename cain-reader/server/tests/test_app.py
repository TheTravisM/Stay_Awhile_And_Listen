import asyncio
import base64
import json
import threading

import numpy as np
import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

import app as app_module
from app import app
from engines.cain_streaming import OPTIMIZE_ENV, CainStreamingEngine
from engines.stub import StubEngine

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_ambient_optimize(monkeypatch):
    """Keep tests independent of the developer's shell: the compiled streaming
    path is opt-in through an environment variable T13.1 asks the user to set."""
    monkeypatch.delenv(OPTIMIZE_ENV, raising=False)


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


# --- POST /tts/stream (T12.2) ------------------------------------------------
# No GPU work here: the streaming engine is built with a fake model, so no
# weights are loaded and no inference runs.

SAMPLE_RATE = 24000


class _FakeModel:
    """Stand-in for the fork's Qwen3TTSModel; yields deterministic chunks."""

    def __init__(self, chunks=((480, 0.5), (240, -0.25), (120, 0.25)), fail_at=None):
        self.chunks = chunks
        self.fail_at = fail_at
        self.yielded = 0

    def stream_generate_voice_clone(
        self,
        text,
        language=None,
        voice_clone_prompt=None,
        emit_every_frames=None,
        decode_window_frames=None,
        **kwargs,
    ):
        for index, (size, value) in enumerate(self.chunks):
            if self.fail_at is not None and index == self.fail_at:
                raise RuntimeError("fake model failure")
            self.yielded += 1
            yield np.full(size, value, dtype=np.float32), SAMPLE_RATE


class _ClosableEngine:
    """Streaming engine whose iterator records that it was closed."""

    name = "fake-streaming"

    def __init__(self):
        self.closed = False

    def stream(self, text, speed=1.0):
        return self._chunks()

    def _chunks(self):
        try:
            yield np.zeros(8, dtype=np.float32), SAMPLE_RATE
            yield np.zeros(8, dtype=np.float32), SAMPLE_RATE
        finally:
            self.closed = True


def _streaming_engine(model=None):
    return CainStreamingEngine(model=model or _FakeModel(), prompt={"prompt": "fake"})


def _records(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_stream_emits_chunks_in_order_then_done(monkeypatch):
    monkeypatch.setattr(app_module, "engine", _streaming_engine())

    r = client.post("/tts/stream", json={"text": "Engineer with 10+ years"})

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    records = _records(r)
    assert [rec["type"] for rec in records] == ["chunk", "chunk", "chunk", "done"]
    assert [rec["index"] for rec in records[:3]] == [0, 1, 2]
    assert [rec["samples"] for rec in records[:3]] == [480, 240, 120]
    for rec in records[:3]:
        assert rec["sample_rate"] == SAMPLE_RATE
        assert rec["channels"] == 1
        assert rec["encoding"] == "pcm_s16le"

    pcm = [np.frombuffer(base64.b64decode(rec["audio"]), dtype=np.int16) for rec in records[:3]]
    assert [len(chunk) for chunk in pcm] == [480, 240, 120]
    assert abs(int(pcm[0][0]) - 16383) <= 1  # +0.5 * 32767
    assert abs(int(pcm[1][0]) + 8191) <= 1  # -0.25 * 32767

    done = records[-1]
    assert done["chunks"] == 3
    assert done["samples"] == 840
    assert done["sample_rate"] == SAMPLE_RATE
    assert done["duration_s"] == pytest.approx(840 / SAMPLE_RATE)


def test_stream_is_incremental_not_buffered(monkeypatch):
    model = _FakeModel()
    monkeypatch.setattr(app_module, "engine", _streaming_engine(model))

    response = app_module.tts_stream(app_module.TTSRequest(text="hello"))
    assert isinstance(response, StreamingResponse)

    async def read_two_records():
        iterator = response.body_iterator
        first = await iterator.__anext__()
        yielded_after_first = model.yielded
        second = await iterator.__anext__()
        await iterator.aclose()
        return first, second, yielded_after_first

    first, second, yielded_after_first = asyncio.run(read_two_records())

    # The first record was already sent while the model had produced only one
    # chunk, i.e. the endpoint streams record-by-record instead of buffering.
    assert yielded_after_first == 1
    assert json.loads(first)["index"] == 0
    assert json.loads(second)["index"] == 1


def test_stream_releases_lock_and_closes_engine_on_disconnect(monkeypatch):
    engine = _ClosableEngine()
    monkeypatch.setattr(app_module, "engine", engine)

    response = app_module.tts_stream(app_module.TTSRequest(text="hello"))

    async def read_one_then_disconnect():
        iterator = response.body_iterator
        await iterator.__anext__()
        await iterator.aclose()

    asyncio.run(read_one_then_disconnect())

    assert engine.closed is True  # engine iterator closed, not left to GC
    assert app_module._synthesis_lock.acquire(blocking=False) is True
    app_module._synthesis_lock.release()


def test_stream_501_for_engine_without_streaming(monkeypatch):
    monkeypatch.setattr(app_module, "engine", StubEngine())

    r = client.post("/tts/stream", json={"text": "hello"})

    assert r.status_code == 501
    assert "does not support streaming" in r.json()["error"]


def test_stream_400_for_unsupported_speed(monkeypatch):
    monkeypatch.setattr(app_module, "engine", _streaming_engine())

    r = client.post("/tts/stream", json={"text": "hello", "speed": 1.5})

    assert r.status_code == 400
    assert "speed=1.0" in r.json()["error"]


def test_stream_422_for_empty_text(monkeypatch):
    monkeypatch.setattr(app_module, "engine", _streaming_engine())

    r = client.post("/tts/stream", json={"text": ""})

    assert r.status_code == 422


def test_stream_error_record_on_mid_stream_failure(monkeypatch):
    monkeypatch.setattr(app_module, "engine", _streaming_engine(_FakeModel(fail_at=2)))

    r = client.post("/tts/stream", json={"text": "hello"})

    assert r.status_code == 200
    records = _records(r)
    assert [rec["type"] for rec in records] == ["chunk", "chunk", "error"]
    assert "fake model failure" in records[-1]["error"]


def test_stream_error_record_when_no_audio(monkeypatch):
    monkeypatch.setattr(app_module, "engine", _streaming_engine(_FakeModel(chunks=())))

    r = client.post("/tts/stream", json={"text": "hello"})

    assert r.status_code == 200
    records = _records(r)
    assert [rec["type"] for rec in records] == ["error"]
    assert "no audio" in records[0]["error"]


def test_health_stays_responsive_while_streaming(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    class _BlockingModel(_FakeModel):
        def stream_generate_voice_clone(self, *args, **kwargs):
            started.set()
            release.wait(timeout=30)
            yield from super().stream_generate_voice_clone(*args, **kwargs)

    engine = _streaming_engine(_BlockingModel())
    monkeypatch.setattr(app_module, "engine", engine)

    result = {}

    def run_stream():
        result["response"] = client.post("/tts/stream", json={"text": "hello"})

    worker = threading.Thread(target=run_stream)
    worker.start()
    try:
        assert started.wait(timeout=30), "stream never started"
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["engine"] == engine.name
    finally:
        release.set()
        worker.join(timeout=30)

    assert not worker.is_alive()
    assert result["response"].status_code == 200
    assert [rec["type"] for rec in _records(result["response"])] == [
        "chunk",
        "chunk",
        "chunk",
        "done",
    ]


# --- startup warm-up (T12.5) -------------------------------------------------
# No GPU work: the fake engines only record which warm-up path was used.


class _WarmUpEngine:
    """Engine that records whether the server used its ``warm_up()``."""

    def __init__(self, name):
        self.name = name
        self.warm_ups = 0
        self.synth_calls = []

    def synthesize(self, text, speed):
        self.synth_calls.append((text, speed))
        return b"RIFF"

    def warm_up(self):
        self.warm_ups += 1


class _SynthesizeOnlyEngine:
    """Stands in for ``engines/cain.py``: synthesize, but no ``warm_up()``."""

    name = "cain"

    def __init__(self):
        self.synth_calls = []

    def synthesize(self, text, speed):
        self.synth_calls.append((text, speed))
        return b"RIFF"


@pytest.mark.parametrize("name", ["cain", "cain-streaming"])
def test_warm_up_prefers_the_engine_warm_up(monkeypatch, name):
    engine = _WarmUpEngine(name)
    monkeypatch.setattr(app_module, "engine", engine)

    app_module._warm_up()

    assert engine.warm_ups == 1
    assert engine.synth_calls == []


def test_warm_up_uses_one_sentence_without_an_engine_warm_up(monkeypatch):
    engine = _SynthesizeOnlyEngine()
    monkeypatch.setattr(app_module, "engine", engine)

    app_module._warm_up()

    assert engine.synth_calls == [(app_module.WARMUP_TEXT, 1.0)]


def test_warm_up_skips_engines_that_do_not_need_it(monkeypatch):
    engine = _WarmUpEngine(StubEngine.name)
    monkeypatch.setattr(app_module, "engine", engine)

    app_module._warm_up()

    assert engine.warm_ups == 0
    assert engine.synth_calls == []


def test_warm_up_failure_does_not_stop_startup(monkeypatch, capsys):
    class _Failing:
        name = "cain-streaming"

        def warm_up(self):
            raise RuntimeError("no triton")

    monkeypatch.setattr(app_module, "engine", _Failing())

    app_module._warm_up()  # must not raise

    assert "cain-streaming warmup failed" in capsys.readouterr().err
