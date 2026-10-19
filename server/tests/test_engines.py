"""Unit tests for engine registration and the opt-in cain-streaming engine (T12.1).

No GPU work happens here. The streaming engine is built with an injected fake
model/prompt, so no weights are loaded and no inference runs; the lazy loader is
exercised through monkeypatched ``sys.modules`` entries.
"""

import io
import sys
import types
import wave

import numpy as np
import pytest

from engines import _engine_class, cain_streaming, get_engine
from engines.cain_streaming import REF_TXT, REF_WAV, CainStreamingEngine
from engines.stub import StubEngine

SAMPLE_RATE = 24000


@pytest.fixture(autouse=True)
def _no_ambient_optimize(monkeypatch):
    """Keep unit tests independent of the developer's shell.

    The compiled path is opt-in through an environment variable that T13.1 asks
    the user to set; a leftover value must not change what these tests build.
    Tests that exercise the variable set it themselves.
    """
    monkeypatch.delenv(cain_streaming.OPTIMIZE_ENV, raising=False)


class _FakeStreamingModel:
    """Stands in for the fork's Qwen3TTSModel (records calls, yields chunks)."""

    def __init__(self, chunk_sizes=(480, 240, 120), sample_rate=SAMPLE_RATE):
        self.chunk_sizes = chunk_sizes
        self.sample_rate = sample_rate
        self.prompt_calls = []
        self.stream_calls = []
        self.optimize_calls = []
        self.fail_optimize = False

    def enable_streaming_optimizations(self, decode_window_frames=None, **kwargs):
        self.optimize_calls.append({"decode_window_frames": decode_window_frames, **kwargs})
        if self.fail_optimize:
            raise RuntimeError("inductor/triton unavailable")

    def create_voice_clone_prompt(self, ref_audio, ref_text, x_vector_only_mode=False):
        self.prompt_calls.append(
            {
                "ref_audio": ref_audio,
                "ref_text": ref_text,
                "x_vector_only_mode": x_vector_only_mode,
            }
        )
        return {"prompt": "fake"}

    def stream_generate_voice_clone(
        self,
        text,
        language=None,
        voice_clone_prompt=None,
        emit_every_frames=None,
        decode_window_frames=None,
        **kwargs,
    ):
        self.stream_calls.append(
            {
                "text": text,
                "language": language,
                "voice_clone_prompt": voice_clone_prompt,
                "emit_every_frames": emit_every_frames,
                "decode_window_frames": decode_window_frames,
            }
        )
        for index, size in enumerate(self.chunk_sizes):
            value = 0.5 if index == 0 else -0.25
            yield np.full(size, value, dtype=np.float32), self.sample_rate


def _engine(**kwargs):
    kwargs.setdefault("model", _FakeStreamingModel())
    kwargs.setdefault("prompt", {"prompt": "fake"})
    return CainStreamingEngine(**kwargs)


def _wav_frames(wav: bytes) -> int:
    with wave.open(io.BytesIO(wav), "rb") as handle:
        return handle.getnframes()


# --- registration -----------------------------------------------------------


def test_stub_is_registered_and_default():
    assert _engine_class("stub") is StubEngine
    assert get_engine("stub").name == "stub"


def test_unknown_engine_raises_value_error():
    with pytest.raises(ValueError, match="unknown engine"):
        get_engine("does-not-exist")


def test_cain_fallback_class_unchanged():
    from engines.cain import CainEngine

    assert _engine_class("cain") is CainEngine
    assert CainEngine.name == "cain"


def test_cain_streaming_is_opt_in_registered():
    assert _engine_class("cain-streaming") is CainStreamingEngine
    assert CainStreamingEngine.name == "cain-streaming"


# --- construction -----------------------------------------------------------


def test_prompt_is_built_once_from_reference_files():
    model = _FakeStreamingModel()
    engine = CainStreamingEngine(model=model)

    assert engine.prompt == {"prompt": "fake"}
    assert model.prompt_calls == [
        {
            "ref_audio": str(REF_WAV),
            "ref_text": REF_TXT.read_text(encoding="utf-8").strip(),
            "x_vector_only_mode": False,
        }
    ]

    list(engine.stream("hello"))
    assert len(model.prompt_calls) == 1  # cached, not rebuilt per request


def test_missing_reference_file_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(cain_streaming, "REF_WAV", tmp_path / "missing.wav")
    with pytest.raises(RuntimeError, match="missing reference file"):
        CainStreamingEngine(model=_FakeStreamingModel(), prompt={})


def test_load_streaming_model_uses_verified_fork_api(monkeypatch):
    import torch

    fake = types.ModuleType("qwen_tts")
    captured = {}

    class _FakeModel:
        @staticmethod
        def stream_generate_voice_clone(*args, **kwargs):  # pragma: no cover
            raise NotImplementedError

        @classmethod
        def from_pretrained(cls, model_id, **kwargs):
            captured["model_id"] = model_id
            captured["kwargs"] = kwargs
            return "MODEL"

    fake.Qwen3TTSModel = _FakeModel
    monkeypatch.setitem(sys.modules, "qwen_tts", fake)

    assert cain_streaming._load_streaming_model() == "MODEL"
    assert captured["model_id"] == cain_streaming.MODEL_ID
    assert captured["kwargs"] == {
        "device_map": "cuda:0",
        "dtype": torch.bfloat16,
        "attn_implementation": "flash_attention_2",
    }


def test_load_streaming_model_rejects_qwen_tts_without_streaming_api(monkeypatch):
    fake = types.ModuleType("qwen_tts")

    class _NoStreamingApi:
        pass

    fake.Qwen3TTSModel = _NoStreamingApi
    monkeypatch.setitem(sys.modules, "qwen_tts", fake)

    with pytest.raises(RuntimeError, match="stream_generate_voice_clone"):
        cain_streaming._load_streaming_model()


# --- input handling ---------------------------------------------------------


@pytest.mark.parametrize("text", ["", "   ", "\n\t"])
def test_stream_rejects_empty_text(text):
    with pytest.raises(ValueError, match="must not be empty"):
        _engine().stream(text)


@pytest.mark.parametrize("text", ["", "   "])
def test_synthesize_rejects_empty_text(text):
    with pytest.raises(ValueError, match="must not be empty"):
        _engine().synthesize(text)


def test_stream_rejects_unsupported_speed():
    with pytest.raises(ValueError, match="speed=1.0"):
        _engine().stream("hello", speed=1.5)


# --- chunk handling ---------------------------------------------------------


def test_stream_yields_pcm16_chunks_with_sample_rate():
    model = _FakeStreamingModel(chunk_sizes=(480, 240, 120))
    engine = CainStreamingEngine(model=model, prompt={"prompt": "fake"})

    chunks = list(engine.stream("hello"))

    assert [len(pcm) for pcm, _ in chunks] == [960, 480, 240]  # 2 bytes/sample
    assert {sample_rate for _, sample_rate in chunks} == {SAMPLE_RATE}
    assert abs(int(np.frombuffer(chunks[0][0], dtype=np.int16)[0]) - 16383) <= 1
    assert abs(int(np.frombuffer(chunks[1][0], dtype=np.int16)[0]) + 8192) <= 1

    assert model.stream_calls == [
        {
            "text": "hello",
            "language": "English",
            "voice_clone_prompt": {"prompt": "fake"},
            "emit_every_frames": 4,
            "decode_window_frames": 80,
        }
    ]


def test_synthesize_returns_valid_wav():
    engine = _engine(model=_FakeStreamingModel(chunk_sizes=(8000, 8000, 8000)))

    wav = engine.synthesize("hello")

    assert wav[:4] == b"RIFF"
    with wave.open(io.BytesIO(wav), "rb") as handle:
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getframerate() == SAMPLE_RATE
        assert handle.getnframes() == 24000


def test_synthesize_applies_speed_to_finished_audio():
    engine = _engine(model=_FakeStreamingModel(chunk_sizes=(24000,)))

    normal = _wav_frames(engine.synthesize("hello"))
    faster = _wav_frames(engine.synthesize("hello", speed=1.5))

    assert normal == 24000
    assert 0 < faster < normal


# --- opt-in compiled path (T12.5) -------------------------------------------
# No GPU work: enable_streaming_optimizations is recorded by the fake model, and
# warm_up() only drives the fake's stream_generate_voice_clone.


@pytest.mark.parametrize("value", ["1", "true", "TRUE", " yes ", "on"])
def test_optimize_env_flag_accepts_explicit_on_values(monkeypatch, value):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, value)
    assert cain_streaming._env_flag(cain_streaming.OPTIMIZE_ENV) is True


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "maybe"])
def test_optimize_env_flag_rejects_everything_else(monkeypatch, value):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, value)
    assert cain_streaming._env_flag(cain_streaming.OPTIMIZE_ENV) is False


def test_optimize_env_flag_is_off_when_unset(monkeypatch):
    monkeypatch.delenv(cain_streaming.OPTIMIZE_ENV, raising=False)
    assert cain_streaming._env_flag(cain_streaming.OPTIMIZE_ENV) is False


def test_optimizations_are_off_by_default():
    model = _FakeStreamingModel()

    engine = CainStreamingEngine(model=model, prompt={"prompt": "fake"})

    assert engine.optimize is False
    assert model.optimize_calls == []
    assert model.stream_calls == []  # nothing is generated at construction


def test_optimizations_are_enabled_by_the_environment(monkeypatch):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, "1")
    model = _FakeStreamingModel()

    engine = CainStreamingEngine(model=model, prompt={"prompt": "fake"})

    assert engine.optimize is True
    assert model.optimize_calls == [
        {"decode_window_frames": cain_streaming.DECODE_WINDOW_FRAMES}
    ]


def test_optimizations_can_be_forced_on_or_off(monkeypatch):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, "1")
    forced_off = _FakeStreamingModel()

    assert (
        CainStreamingEngine(model=forced_off, prompt={}, optimize=False).optimize
        is False
    )
    assert forced_off.optimize_calls == []

    monkeypatch.delenv(cain_streaming.OPTIMIZE_ENV, raising=False)
    forced_on = _FakeStreamingModel()

    assert CainStreamingEngine(model=forced_on, prompt={}, optimize=True).optimize is True
    assert forced_on.optimize_calls == [
        {"decode_window_frames": cain_streaming.DECODE_WINDOW_FRAMES}
    ]


def test_missing_optimization_api_raises_with_the_rollback(monkeypatch):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, "1")

    with pytest.raises(RuntimeError, match=cain_streaming.OPTIMIZE_ENV) as excinfo:
        CainStreamingEngine(model=object(), prompt={})

    assert "enable_streaming_optimizations" in str(excinfo.value)


def test_optimization_failure_raises_with_the_rollback(monkeypatch):
    monkeypatch.setenv(cain_streaming.OPTIMIZE_ENV, "1")
    model = _FakeStreamingModel()
    model.fail_optimize = True

    with pytest.raises(RuntimeError, match=cain_streaming.OPTIMIZE_ENV) as excinfo:
        CainStreamingEngine(model=model, prompt={})

    assert "inductor/triton unavailable" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, RuntimeError)


def test_warmup_runs_one_generation_when_unoptimized():
    model = _FakeStreamingModel()
    engine = CainStreamingEngine(model=model, prompt={}, optimize=False)

    engine.warm_up()

    assert [call["text"] for call in model.stream_calls] == [cain_streaming.WARMUP_TEXTS[0]]


def test_warmup_runs_every_text_when_optimized():
    model = _FakeStreamingModel()
    engine = CainStreamingEngine(model=model, prompt={}, optimize=True)

    engine.warm_up()

    texts = list(cain_streaming.WARMUP_TEXTS)
    assert [call["text"] for call in model.stream_calls] == texts
    # Different lengths are the point: torch.compile specialises on shape, so a
    # single short text would not finish building the kernels.
    assert len(texts) >= 3
    assert len({len(text) for text in texts}) == len(texts)


def test_warmup_uses_the_verified_streaming_parameters():
    model = _FakeStreamingModel()
    engine = CainStreamingEngine(model=model, prompt={}, optimize=True)

    engine.warm_up()

    assert {
        (call["emit_every_frames"], call["decode_window_frames"]) for call in model.stream_calls
    } == {(cain_streaming.EMIT_EVERY_FRAMES, cain_streaming.DECODE_WINDOW_FRAMES)}
