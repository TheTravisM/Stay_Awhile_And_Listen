"""Opt-in streaming engine backed by the Qwen3-TTS streaming fork (T12.1).

Registered as ``CAIN_ENGINE=cain-streaming``. The default engine stays ``stub``
and ``engines/cain.py`` (``CAIN_ENGINE=cain``) is untouched, so the existing
non-streaming path remains the fallback.

Verified API (isolated probe, T11.2/T11.3 — not guessed):

    Qwen3TTSModel.from_pretrained(model_id, device_map="cuda:0",
                                  dtype=torch.bfloat16,
                                  attn_implementation="flash_attention_2")
    Qwen3TTSModel.create_voice_clone_prompt(ref_audio, ref_text,
                                            x_vector_only_mode) -> prompt
    Qwen3TTSModel.stream_generate_voice_clone(
        text, language, voice_clone_prompt, emit_every_frames,
        decode_window_frames) -> Generator[Tuple[np.ndarray float32, int], ...]

This module imports the fork lazily, inside ``_load_streaming_model()``, so
importing it never loads weights and never breaks the stub/cain engines.

Dependency plan (documented for approval — NOT installed in production):
  The fork is published under the *same distribution name* as production's
  package, so it cannot simply be added next to it:
    * fork       : qwen-tts 0.0.4  (provides stream_generate_voice_clone)
    * production : qwen-tts 0.1.1  (no streaming API)
  Verified-working isolated set (T11.2/T11.3, Go/No-Go GO):
    torch 2.10.0+cu130, torchaudio 2.10.0+cu130 (flash-attn wheel ABI),
    flash-attn 2.8.3+cu130torch2.10 (prebuilt win_amd64),
    triton-windows 3.6.0 (needed only for enable_streaming_optimizations),
    transformers 4.57.3 (== production), accelerate 1.12.0 (== production),
    librosa 1.0.0 / soundfile 0.14.0 / soxr 1.1.0 / sox 1.5.0 / einops 0.8.2.
  Conflicts with production (torch 2.14.1+cu132, qwen-tts 0.1.1): the fork
  needs torch 2.10+cu130 and its own qwen-tts, so installing it into
  ``server/.venv`` would break the existing ``cain`` engine.
  Options needing user approval: (a) dedicated venv + separate streaming
  server process, (b) an explicitly pinned side-by-side plan, or (c) keep
  streaming out of production. Until a plan is approved this engine stays
  opt-in and raises a clear error instead of silently degrading.

Compiled streaming path (T12.5, opt-in):
  The un-optimized path measured RTF ~3.0 in the isolated probe (T11.3), which
  cannot keep a browser stream fed, so the fork's own documented
  ``enable_streaming_optimizations(decode_window_frames=80)`` is wired up
  behind ``CAIN_STREAMING_OPTIMIZE=1``. It stays off by default, so the
  un-optimized path that T11.3 benchmarked remains the rollback: unset the
  variable (or set it to 0/false/no/off) and restart.

  torch.compile is lazy and shape-specialised, so the first generations after
  enabling it cost far more than later ones (the fork's own example warms up
  with several different-length texts before timing anything). ``warm_up()``
  therefore runs those warm-up sentences once at server startup -- ``app.py``
  calls it for this engine -- so the compilation cost is paid there instead of
  on the user's first read. The compiled path needs Triton
  (``triton-windows``, already present in the isolated venv); it is never
  installed in production. Enabling it without a usable Triton fails loudly at
  startup with the rollback named, rather than silently running un-optimized.
"""

from __future__ import annotations

import io
import os
import sys
import time
import wave
from pathlib import Path
from typing import Iterator

import librosa
import numpy as np

from .base import Engine

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
LANGUAGE = "English"

# Streaming parameters verified in the isolated probe (T11.2/T11.3).
EMIT_EVERY_FRAMES = 4
DECODE_WINDOW_FRAMES = 80

# Opt-in compiled path (T12.5). Off unless set to 1/true/yes/on, so the
# un-optimized path benchmarked in T11.3 stays the default and the rollback.
OPTIMIZE_ENV = "CAIN_STREAMING_OPTIMIZE"

# Warm-up sentences, deliberately of different lengths: torch.compile
# specialises on shape, so one short text does not finish building the kernels
# (the fork's own example warms up with several lengths before timing). The
# compiled path runs all of them at startup; the un-optimized path only needs
# the first one to warm CUDA and the model caches.
WARMUP_TEXTS = (
    "Stay awhile and listen.",
    "Stay awhile and listen to one slightly longer warm-up sentence.",
    "Stay awhile and listen. This longer warm-up sentence exists so the "
    "compiled streaming path finishes building its kernels before a real read.",
)

# Matches the verified isolated config. If an approved dependency plan does not
# include flash-attn, change this to "sdpa" (the fork declares _supports_sdpa).
ATTN_IMPLEMENTATION = "flash_attention_2"

SERVER_DIR = Path(__file__).resolve().parent.parent
REF_WAV = SERVER_DIR / "voices" / "cain.wav"
REF_TXT = SERVER_DIR / "voices" / "cain.txt"


def _to_pcm16(chunk) -> bytes:
    """Convert one float32 waveform chunk to mono 16-bit little-endian PCM."""
    audio = np.asarray(chunk, dtype=np.float32).reshape(-1)
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


def _pcm16_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap raw mono 16-bit PCM in a RIFF/WAVE container."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buffer.getvalue()


def _load_streaming_model():
    """Import the fork lazily, verify its streaming API, then load the model."""
    try:
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:  # pragma: no cover - depends on installed packages
        raise RuntimeError(
            "qwen-tts is not importable, so CAIN_ENGINE=cain-streaming cannot "
            "start; see the dependency plan in engines/cain_streaming.py"
        ) from exc

    if not hasattr(Qwen3TTSModel, "stream_generate_voice_clone"):
        raise RuntimeError(
            "the installed qwen-tts has no "
            "Qwen3TTSModel.stream_generate_voice_clone(); CAIN_ENGINE="
            "cain-streaming requires the streaming fork "
            "(dffdeeq/Qwen3-TTS-streaming). Production currently ships "
            "qwen-tts 0.1.1, which has no streaming API — see the dependency "
            "plan in engines/cain_streaming.py. Use CAIN_ENGINE=cain for the "
            "existing non-streaming fallback."
        )

    import torch

    return Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation=ATTN_IMPLEMENTATION,
    )


def _env_flag(name: str) -> bool:
    """True only for an explicit 1/true/yes/on; unset or anything else is off."""
    value = os.environ.get(name)
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


class CainStreamingEngine(Engine):
    """Streaming voice-clone engine. Loads the model once and caches the prompt.

    ``model``/``prompt`` are optional injection points used by the unit tests so
    they can exercise chunk handling and input validation without a GPU. When
    omitted (the normal path, via ``get_engine``) the fork's model is loaded
    once here and the clone prompt is built once from the Cain reference files.

    ``optimize`` selects the fork's compiled path (T12.5) and defaults to the
    ``CAIN_STREAMING_OPTIMIZE`` environment variable. When it is on, the
    expensive part -- torch.compile building its kernels -- is paid by
    ``warm_up()``, which the server calls once at startup.
    """

    name: str = "cain-streaming"
    # The compiled path builds its kernels on the first generations, so the
    # server pays that cost in warm_up() before serving requests.
    warm_up_at_startup: bool = True

    def __init__(self, model=None, prompt=None, optimize: bool | None = None) -> None:
        for path in (REF_WAV, REF_TXT):
            if not path.exists():
                raise RuntimeError(f"missing reference file: {path}")

        self.optimize = _env_flag(OPTIMIZE_ENV) if optimize is None else bool(optimize)
        self.model = _load_streaming_model() if model is None else model

        if self.optimize:
            self._enable_optimizations()

        if prompt is None:
            ref_text = REF_TXT.read_text(encoding="utf-8").strip()
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(REF_WAV),
                ref_text=ref_text,
                x_vector_only_mode=False,
            )
        self.prompt = prompt

    @property
    def model_loaded(self) -> bool:
        return self.model is not None

    @property
    def optimized(self) -> bool:
        # _enable_optimizations() raises on failure, so reaching this engine
        # with optimize=True means the compiled path really is on.
        return self.optimize

    def _enable_optimizations(self) -> None:
        """Turn on the fork's compiled streaming path (T12.5).

        Called only when ``CAIN_STREAMING_OPTIMIZE`` asks for it. Because that
        is an explicit opt-in, a missing or failing implementation is reported
        loudly with the rollback named instead of silently running the
        un-optimized path.

        The call itself only wraps the decoder/talker/codebook in
        ``torch.compile``; the compilation happens on the first real
        generation, which is why ``warm_up()`` exists.
        """
        enable = getattr(self.model, "enable_streaming_optimizations", None)
        if not callable(enable):
            raise RuntimeError(
                f"{OPTIMIZE_ENV} is set but the installed qwen-tts has no "
                "enable_streaming_optimizations(); the compiled path needs the "
                "streaming fork (dffdeeq/Qwen3-TTS-streaming). Unset "
                f"{OPTIMIZE_ENV} to keep the un-optimized streaming path."
            )

        started = time.perf_counter()
        try:
            enable(decode_window_frames=DECODE_WINDOW_FRAMES)
        except Exception as exc:
            raise RuntimeError(
                f"enable_streaming_optimizations(decode_window_frames="
                f"{DECODE_WINDOW_FRAMES}) failed: {exc!r}. It needs torch.compile "
                "with a working Triton (triton-windows in the isolated venv). "
                f"Unset {OPTIMIZE_ENV} to fall back to the un-optimized "
                "streaming path."
            ) from exc

        print(
            f"cain-streaming optimize: enabled in "
            f"{time.perf_counter() - started:.3f}s "
            f"(decode_window_frames={DECODE_WINDOW_FRAMES}; compilation itself "
            "happens in the warm-up below)",
            file=sys.stderr,
        )

    def warm_up(self) -> None:
        """Pay the one-time setup cost here, at startup, not on a user read.

        The first generations after ``enable_streaming_optimizations()`` build
        the compiled kernels and are much slower than later ones. This runs the
        warm-up sentences through a real generation and discards the audio: all
        of ``WARMUP_TEXTS`` on the compiled path (their different lengths are
        what finishes the shape-specialised compilation), just the first one
        when un-optimized, where it only warms CUDA and the model caches.
        """
        texts = WARMUP_TEXTS if self.optimize else WARMUP_TEXTS[:1]
        for index, text in enumerate(texts, 1):
            started = time.perf_counter()
            self.synthesize(text, 1.0)
            print(
                f"cain-streaming warmup {index}/{len(texts)}: "
                f"{time.perf_counter() - started:.3f}s "
                f"optimize={'on' if self.optimize else 'off'}",
                file=sys.stderr,
            )

    def stream(self, text: str, speed: float = 1.0) -> Iterator[tuple[bytes, int]]:
        """Return an iterator of ``(mono 16-bit PCM chunk, sample rate)``.

        The sample rate is carried on every chunk so the caller never has to
        assume 24 kHz. Validation happens eagerly, before any generation, so an
        HTTP layer can reject bad input before it starts a response.
        ``speed != 1.0`` is rejected: per-chunk time-stretch would introduce
        audible gaps, and the streaming path is kept to the verified config.
        """
        if not text or not text.strip():
            raise ValueError("text must not be empty")
        if speed != 1.0:
            raise ValueError(
                "cain-streaming supports only speed=1.0 (per-chunk time-stretch "
                "would produce audible gaps); use CAIN_ENGINE=cain for speed changes"
            )
        return self._stream(text)

    def _stream(self, text: str) -> Iterator[tuple[bytes, int]]:
        started = time.perf_counter()
        first_chunk_s = None
        chunks = 0
        for chunk, sample_rate in self.model.stream_generate_voice_clone(
            text=text,
            language=LANGUAGE,
            voice_clone_prompt=self.prompt,
            emit_every_frames=EMIT_EVERY_FRAMES,
            decode_window_frames=DECODE_WINDOW_FRAMES,
        ):
            if first_chunk_s is None:
                first_chunk_s = time.perf_counter() - started
            chunks += 1
            yield _to_pcm16(chunk), int(sample_rate)

        print(
            f"cain-streaming timing: first_chunk="
            f"{(first_chunk_s or 0.0):.3f}s total={time.perf_counter() - started:.3f}s "
            f"chunks={chunks}",
            file=sys.stderr,
        )

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        """Engine-protocol fallback: consume the stream and return a full WAV.

        ``speed`` is applied to the finished audio (as ``cain.py`` does) rather
        than per chunk, so the existing ``POST /tts`` contract still holds.
        """
        if not text or not text.strip():
            raise ValueError("text must not be empty")

        parts: list[bytes] = []
        sample_rate: int | None = None
        for pcm, chunk_sr in self.stream(text, 1.0):
            parts.append(pcm)
            sample_rate = chunk_sr

        if sample_rate is None:
            raise RuntimeError("streaming generation produced no audio")

        pcm = b"".join(parts)
        if speed != 1.0:
            audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32767.0
            audio = librosa.effects.time_stretch(audio, rate=speed)
            pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()

        return _pcm16_to_wav(pcm, sample_rate)
