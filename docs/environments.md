# Python environments

This project uses two isolated Python 3.12 environments. They exist because the
production voice engine and the streaming fork pin different, incompatible
versions of PyTorch and of the `qwen-tts` package.

Snapshot: **2026-10-19**, Python **3.12.10**, Windows 11, PowerShell. Versions
below come from `python -m pip list --format=freeze` in each environment.

| Goal | Environment | Engine |
|------|-------------|--------|
| Normal use, the default fallback | `server\.venv` | `cain` |
| Fast, streaming playback | `C:\TTS-Streaming-Test\.venv` (outside this repo) | `cain-streaming` |
| No GPU, just check the plumbing | `server\.venv` | `stub` (the default when `CAIN_ENGINE` is unset) |

## Production environment: `server\.venv`

Created and used by `server\run.ps1`, `start-cain-server.cmd` and the test suite.
PyTorch is installed first, from the CUDA 13.2 wheel index, exactly as recorded
in `server\NOTES.md`; `requirements.txt` deliberately does not list it.

```powershell
Set-Location server
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu132
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Recorded versions:

| Package | Version |
|---------|---------|
| fastapi | 0.143.0 |
| uvicorn | 0.54.0 |
| pydantic | 2.14.1 |
| starlette | 1.7.0 |
| numpy | 2.5.4 |
| httpx | 0.28.1 |
| pytest | 9.1.1 |
| torch | 2.14.1+cu132 |
| torchvision | 0.29.1+cu132 |
| torchaudio | 2.11.0 |
| transformers | 4.57.3 |
| qwen-tts | 0.1.1 |
| accelerate | 1.12.0 |
| librosa | 1.0.0 |
| soundfile | 0.14.0 |
| soxr | 1.1.0 |
| sox | 1.5.0 |
| einops | 0.8.2 |
| huggingface_hub | 0.36.2 |
| tokenizers | 0.22.2 |
| numba | 0.68.0 |
| llvmlite | 0.50.0 |
| scipy | 1.18.1 |

Verify it:

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -c "import torch, transformers, fastapi, numpy; print(torch.__version__)"
.\.venv\Scripts\python.exe -m pytest -q
```

Last recorded result: `pip check` clean, **56 passed**.

## Streaming environment: `C:\TTS-Streaming-Test\.venv`

This environment runs the same `server\app.py` with the community fork
[dffdeeq/Qwen3-TTS-streaming](https://github.com/dffdeeq/Qwen3-TTS-streaming),
which can emit audio while it is still generating. It lives outside the repo on
purpose: installing it into `server\.venv` would replace the working `cain`
stack. It has no `pytest`; the tests run in the production environment.

The fork was not installed from `requirements.txt`, so this table is the record
of the set that passed the Go/No-Go gate. The install history and the measured
results are in `TASKS_QWEN_STREAMING.md`.

| Package | Version |
|---------|---------|
| torch | 2.10.0+cu130 |
| torchaudio | 2.10.0+cu130 |
| flash_attn | 2.8.3+cu130torch2.10 (prebuilt win_amd64) |
| triton-windows | 3.6.0.post26 |
| transformers | 4.57.3 |
| accelerate | 1.12.0 |
| qwen-tts | 0.0.4 (the fork, same distribution name as production) |
| librosa | 1.0.0 |
| soundfile | 0.14.0 |
| soxr | 1.1.0 |
| sox | 1.5.0 |
| einops | 0.8.2 |
| fastapi | 0.143.3 |
| uvicorn | 0.54.0 |
| pydantic | 2.14.1 |
| starlette | 1.8.0 |
| numpy | 2.5.4 |
| httpx | 0.28.1 |
| huggingface_hub | 0.36.2 |
| tokenizers | 0.22.2 |
| numba | 0.68.0 |
| llvmlite | 0.50.0 |
| scipy | 1.18.1 |

Run the streaming server from `server\`:

```powershell
$env:CAIN_ENGINE = "cain-streaming"
$env:CAIN_STREAMING_OPTIMIZE = "1"
C:\TTS-Streaming-Test\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
```

`C:\TTS-Streaming-Test\.venv\Scripts\python.exe -m pip check` is clean.

Rollback to the production engine: remove `CAIN_STREAMING_OPTIMIZE` (or set it
to `0`, `false`, `no` or `off`) and run `server\.venv` with
`CAIN_ENGINE=cain`. `start-cain-server.cmd` does this detection for you: it
prefers the streaming environment when that folder exists and otherwise starts
`server\.venv` with `cain`.

## Environment variables

| Variable | Values | Effect |
|----------|--------|--------|
| `CAIN_ENGINE` | `stub` (default), `cain`, `cain-streaming` | Selects the engine. Unset means `stub`, which only plays a test tone. |
| `CAIN_STREAMING_OPTIMIZE` | `1`, `true`, `yes`, `on` | Enables the compiled streaming path. Anything else keeps it off. |
| `CAIN_CUDAGRAPH_CODE_PREDICTOR` | `1`, `true`, `yes`, `on` | Experimental, off by default, and only for the non-streaming engine. |
| `HF_HUB_OFFLINE` | `1` | Stops Hugging Face network calls once the model is cached. |

## What is deliberately not in either environment

- Model weights. They are downloaded to the Hugging Face cache outside this repo
  (normally `%USERPROFILE%\.cache\huggingface`) on first use.
- The reference voice. `server\voices\cain.wav` and `cain.txt` are gitignored and
  user-supplied.
- Generated audio and test files. They belong in `scratch\`, which is gitignored.

## Known quirk in this checkout

The repository was flattened on 2026-10-18, moving `server\.venv` to a new path.
The interpreter and packages still work because `pyvenv.cfg` sits beside
`python.exe`, but 29 of the 37 `.exe` launcher shims in
`server\.venv\Scripts\` still embed the old absolute path, so they exit
silently. Every documented command uses `python -m ...`, which is unaffected,
and a future `pip install` into the venv regenerates the shims.

## Keeping this file honest

`requirements.txt` is intentionally unpinned, so a fresh install today can pick
newer versions than the tables above. After you reinstall or upgrade anything,
capture the working set and update this file:

```powershell
.\.venv\Scripts\python.exe -m pip list --format=freeze > ..\docs\pip-freeze-production.txt
```

Then re-run `pip check` and `pytest` before recording the result here. To print
the full set instead of writing a file:

```powershell
.\.venv\Scripts\python.exe -m pip freeze
```
