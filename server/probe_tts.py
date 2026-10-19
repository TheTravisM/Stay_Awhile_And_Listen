import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
SERVER_DIR = Path(__file__).resolve().parent
REF_WAV = SERVER_DIR / "voices" / "cain.wav"
REF_TXT = SERVER_DIR / "voices" / "cain.txt"
OUT_WAV = SERVER_DIR.parent / "scratch" / "probe.wav"
TEXT = "Stay awhile and listen, traveller. The night is young, and the stars are listening too."


def main() -> None:
    for path in (REF_WAV, REF_TXT):
        if not path.exists():
            sys.exit(f"missing reference file: {path}")

    model = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )

    ref_text = REF_TXT.read_text(encoding="utf-8").strip()

    start = time.perf_counter()
    wavs, sr = model.generate_voice_clone(
        text=TEXT,
        language="English",
        ref_audio=str(REF_WAV),
        ref_text=ref_text,
    )
    elapsed = time.perf_counter() - start

    OUT_WAV.parent.mkdir(parents=True, exist_ok=True)
    sf.write(OUT_WAV, wavs[0], sr)

    device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
    print(f"output: {OUT_WAV}")
    print(f"elapsed: {elapsed:.2f} s")
    print(f"device: {device}")


if __name__ == "__main__":
    main()
