import io
import wave
from pathlib import Path

import librosa
import numpy as np
import torch
from qwen_tts import Qwen3TTSModel

from .base import Engine

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
SERVER_DIR = Path(__file__).resolve().parent.parent
REF_WAV = SERVER_DIR / "voices" / "cain.wav"
REF_TXT = SERVER_DIR / "voices" / "cain.txt"


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

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        wavs, sr = self.model.generate_voice_clone(
            text=text,
            language="English",
            voice_clone_prompt=self.prompt,
        )

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

        return buffer.getvalue()
