# NOTES

## T7.2 — Probe verified (2026-10-15)

User report: GPU probe succeeded (user ran it with Ollama stopped).
Evidence verified on disk:

- `scratch\probe.wav`: 299,564 bytes, written 2026-10-15 22:35.
  Checked with stdlib `wave`: mono, 24,000 Hz, 16-bit PCM, 149,760 frames (6.24 s).
- Installed (server venv): qwen-tts 0.1.1, torch 2.14.1+cu132,
  torchvision 0.29.1+cu132, transformers 4.57.3, soundfile 0.14.0, accelerate 1.12.0.
- Device: CUDA, NVIDIA GeForce RTX 3090 (bfloat16, sdpa attention).
- Exact API call that worked (`server\probe_tts.py`, ~15-word sentence):
  `Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")`
  then `model.generate_voice_clone(text=..., language="English", ref_audio=voices\cain.wav, ref_text=cain.txt)` → `sf.write(..., wavs[0], sr)`.

Resolved (2026-10-16, user confirmation after playing `scratch\probe.wav`):
- User listening confirmation: the audio is intelligible, "sounds great", and
  resembles the intended Cain voice.
- Generation time: 18.20 seconds for the ~15-word probe sentence. This is
  user-provided console output, not independently verified by the builder.
- Note: 18.20 s/sentence exceeds the 8 s/sentence threshold in T7.2's fallback
  clause; the user accepted the qwen-tts result, so no XTTS-v2/F5-TTS retry was
  triggered.
T7.2's Verify items are now all supported by the evidence above.

T7.1 check passed: `server\voices` contains `cain.wav` (777040 bytes) and `cain.txt` (203 bytes).

## T7.3 — READY (2026-10-15; T7.2 evidenced and closed 2026-10-16)

T7.2's API is proven (see record above); not yet implemented.
Next action (T7.3): create `engines/cain.py` with `CainEngine(Engine)` —
load the model once in `__init__` (API as recorded above), `synthesize` with
the cached reference, map `speed` to the model's rate parameter (or
time-stretch if there is none), return 16-bit PCM mono WAV bytes; add
`"cain"` to `get_engine` in `engines/__init__.py`; add new deps to
`requirements.txt`.
Prerequisites: user says "next" (Rule 1); then T7.3's (user, GPU) verify —
user stops Ollama, runs `.\run.ps1` with `$env:CAIN_ENGINE="cain"`, runs the
T1.4 `/tts` curl, plays the result, checks `/health` shows `"engine":"cain"`,
and stops the server before resuming Qwen.