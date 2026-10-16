import io
import os
import sys
import time
import wave
from pathlib import Path

import librosa
import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

from .base import Engine

# Voice-clone model selection. Both IDs use the same 12 Hz Base architecture/API.
# Baseline (all T7.2/T7.4/T8.1 results and prior measurements) = MODEL_ID_1_7B.
# Active = MODEL_ID_1_7B (current baseline). MODEL_ID_0_6B is retained for comparison.
# To run the optional 0.6B latency/voice-quality comparison experiment, change the
# `MODEL_ID =` selector below to MODEL_ID_0_6B.
MODEL_ID_1_7B = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
MODEL_ID_0_6B = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_ID = MODEL_ID_1_7B

SERVER_DIR = Path(__file__).resolve().parent.parent
REF_WAV = SERVER_DIR / "voices" / "cain.wav"
REF_TXT = SERVER_DIR / "voices" / "cain.txt"

# Optional, reversible latency experiment (disabled unless set to 1/true/yes/on).
# When enabled, the nested code-predictor generation is routed through Hugging
# Face's automatic compilation using a static KV cache and the CUDA-graphs
# Dynamo backend ("cudagraphs", which is Triton-free). Sampling settings,
# weights, voice files, and dependencies are unchanged.
CUDAGRAPH_CODE_PREDICTOR_ENV = "CAIN_CUDAGRAPH_CODE_PREDICTOR"


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


class CainEngine(Engine):
    name: str = "cain"

    def __init__(self) -> None:
        for path in (REF_WAV, REF_TXT):
            if not path.exists():
                raise RuntimeError(f"missing reference file: {path}")

        self.model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )

        ref_text = REF_TXT.read_text(encoding="utf-8").strip()
        self.prompt = self.model.create_voice_clone_prompt(
            ref_audio=str(REF_WAV),
            ref_text=ref_text,
            x_vector_only_mode=False,
        )

        # Timing instrumentation (log-only). generate_voice_clone() calls
        # self.model.generate() and self.model.speech_tokenizer.decode()
        # internally, so wrap those two callables to time each stage. The
        # wrappers call the originals unchanged; generate_voice_clone is
        # decorated @torch.no_grad, so no_grad still covers the wrapped calls.
        self._stage: dict[str, float] = {"generate": 0.0, "decode": 0.0}
        self._instrument(self.model.model, "generate", "generate")
        self._instrument(self.model.model.speech_tokenizer, "decode", "decode")

        self._cudagraph_code_predictor = False
        if _env_flag(CUDAGRAPH_CODE_PREDICTOR_ENV):
            self._enable_cudagraph_code_predictor()

    def _enable_cudagraph_code_predictor(self) -> None:
        """Route the nested code-predictor generation through HF auto-compile.

        Wraps `talker.code_predictor.generate` so it receives
        `cache_implementation="static"` and
        `CompileConfig(backend="cudagraphs", dynamic=True, fullgraph=False)`.
        HF then compiles the decode forward (prefill stays eager) with the
        Triton-free CUDA-graphs Dynamo backend. Compilation is lazy and happens
        on the first request. Any setup failure disables the experiment and is
        reported, so the engine never claims an inactive optimization.
        """
        try:
            from transformers import CompileConfig

            backends = torch._dynamo.list_backends()
            if "cudagraphs" not in backends:
                raise RuntimeError(
                    f"dynamo backend 'cudagraphs' is unavailable (available: {backends})"
                )

            code_predictor = self.model.model.talker.code_predictor
            original_generate = code_predictor.generate
            compile_config = CompileConfig(
                backend="cudagraphs", dynamic=True, fullgraph=False
            )

            def generate_with_cudagraphs(*args, **kwargs):
                kwargs.setdefault("cache_implementation", "static")
                kwargs.setdefault("compile_config", compile_config)
                return original_generate(*args, **kwargs)

            code_predictor.generate = generate_with_cudagraphs
        except Exception as exc:  # pragma: no cover - reported loudly below
            print(
                "cain: cudagraph experiment DISABLED "
                f"({CUDAGRAPH_CODE_PREDICTOR_ENV} is set, but setup failed: {exc!r})",
                file=sys.stderr,
            )
            return

        self._cudagraph_code_predictor = True
        print(
            "cain: cudagraph experiment ENABLED "
            f"({CUDAGRAPH_CODE_PREDICTOR_ENV} is set): "
            "talker.code_predictor.generate -> cache_implementation='static' + "
            "CompileConfig(backend='cudagraphs', dynamic=True, fullgraph=False). "
            "torch.compile is lazy (first request); watch stderr for "
            "'skipping cudagraphs due to ...' (means no speedup) or compile errors.",
            file=sys.stderr,
        )

    def _instrument(self, target, attr: str, key: str) -> None:
        original = getattr(target, attr)

        def timed(*args, **kwargs):
            start = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                self._stage[key] = time.perf_counter() - start

        setattr(target, attr, timed)

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        self._stage["generate"] = 0.0
        self._stage["decode"] = 0.0

        model_start = time.perf_counter()
        wavs, sr = self.model.generate_voice_clone(
            text=text,
            language="English",
            voice_clone_prompt=self.prompt,
        )
        model_s = time.perf_counter() - model_start

        encode_start = time.perf_counter()
        audio = np.asarray(wavs[0], dtype=np.float32)
        if audio.ndim > 1:
            audio = np.mean(audio, axis=-1)

        if speed != 1.0:
            audio = librosa.effects.time_stretch(audio, rate=speed)

        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sr)
            wav_file.writeframes(pcm.tobytes())
        encode_s = time.perf_counter() - encode_start

        print(
            f"cain timing: model={model_s:.3f}s "
            f"generate={self._stage['generate']:.3f}s "
            f"decode={self._stage['decode']:.3f}s "
            f"encode={encode_s:.3f}s",
            file=sys.stderr,
        )

        return buffer.getvalue()
