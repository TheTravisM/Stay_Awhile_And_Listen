# TASKS: Cain Reader — Qwen3-TTS Streaming Trial

**Supplement to the existing `TASKS.md`; do not replace or rewrite the existing plan.** Add this as a separate performance phase and keep all old task statuses unchanged. The user supervises every task.

## Goal

Test whether [`dffdeeq/Qwen3-TTS-streaming`](https://github.com/dffdeeq/Qwen3-TTS-streaming) can make Cain Reader start speaking quickly on Windows 11 + an RTX 3090 while retaining the user's existing Cain reference voice. **Prove it in isolation before integrating it.**

Current baseline: Qwen3-TTS 12Hz Base 1.7B; roughly 22–24 seconds to synthesize the longer test sentence. The attempted CUDA-graph wrapper in the existing engine was slower and has been removed. Keep the current engine as a working fallback.

**Important evidence caveat:** the fork advertises about 6× faster inference and offers `stream_generate_voice_clone()` / `stream_generate_pcm()`, but its README's RTX 5090 benchmark headings do not show usable benchmark numbers. Treat the speedup as an unverified claim, not a guarantee. Its example measures first-chunk latency separately and uses `emit_every_frames=4` for lower latency. Sources: [fork README](https://github.com/dffdeeq/Qwen3-TTS-streaming/blob/main/README.md), [streaming example](https://github.com/dffdeeq/Qwen3-TTS-streaming/blob/main/examples/test_streaming_optimized.py), [official Qwen3-TTS repo](https://github.com/QwenLM/Qwen3-TTS).

## Builder rules (read before every task)

1. Do **one task at a time, in order**. Complete its Verify step, tick its checkbox, report in at most 5 lines, then stop and wait for the user's “next”.
2. Don't guess APIs. Check the currently downloaded fork's source, `pyproject.toml`, and the installed package versions before implementing against them.
3. **Do not modify the production engine, server, extension, existing `TASKS.md`, or `NOTES.md` until the isolated proof passes the Go/No-Go gate in T11.3.**
4. Do not run GPU inference, start/stop processes, or claim an audio test passed. GPU/model tests are marked **(user, GPU)**; write the exact command and stop for the user's result.
5. Use PowerShell on Windows 10/11. No bash syntax, `&&`, `source`, `chmod`, `/tmp`, or Git commands. Use `curl.exe` rather than PowerShell's `curl` alias. Keep commands and output short.
6. Use Python 3.12 and the existing server venv only to inspect its versions. **Never install or upgrade packages in `cain-reader\server\.venv` for this experiment.** A separate environment is mandatory.
7. Never read, move, rename, delete, overwrite, or modify `cain-reader\voice-source\` or `cain-reader\server\voices\`. Use the existing `cain.wav` and `cain.txt` by absolute path; don't copy them. Never save model weights or generated audio inside the project. Put temporary code/results in the external test directory below.
8. Use a hard stop if dependency installation needs unsupported wheels/source builds, fails twice, or requires changing the production Python/CUDA stack. Don't troubleshoot endlessly; report the blocker and ask.
9. Keep the current 1.7B baseline available. Don't reduce model size, change voice assets, or change sampling settings without explicit approval.
10. After each task, record only confirmed results. Never tick a user/GPU verification until the user reports it.

## Test paths and comparison

- Production project: `C:\GitRepo\Stay_Awhile_And_Listen\cain-reader\`
- Isolated experiment: `C:\TTS-Streaming-Test\` (outside the production project)
- Reuse the same Cain `cain.wav` + exact matching `cain.txt` transcript by path; don't use the fork's sample voice.
- Use the same texts for all comparisons:
  - Short: `Engineer with 10+ years of experience`
  - Long: `Engineer with 10+ years of experience in crafting mobile-first, interactive websites and applications.`
- Measure **time to first playable audio chunk**, total synthesis time, audio duration, and real-time factor (total generation time ÷ output audio duration). Separate one-time model-load and voice-prompt setup time from request latency. Do one warmup before recording repeat-request times.

### Go/No-Go gate

Do not integrate unless the isolated run produces audible, acceptable Cain-like speech and the **warmed time to first playable audio is at most 3 seconds** for the short text. Prefer under 2 seconds, but do not promise near-zero latency. Also compare total generation time with the current ~22–24 second baseline for the long text.

If first audio remains over 3 seconds, the voice is unacceptable, or install/compile problems require extended debugging, stop after **one** documented fix attempt and report **NO-GO**. Do not wire the fork into the extension. A streaming API only helps if the browser can actually play chunks before the entire request finishes.

---

## Phase 11 — Isolated streaming proof

- [ ] **T11.1 Read-only compatibility audit**

  Inspect the current project and the fork's current `README.md`, `pyproject.toml`, `qwen_tts` implementation, and example. Inspect—not change—the existing server's Python, PyTorch, CUDA, Transformers, and `qwen-tts` versions; confirm the reference audio's format using metadata only. Verify the exact signatures/return types for `Qwen3TTSModel.from_pretrained`, `create_voice_clone_prompt`, and `stream_generate_voice_clone`; determine Windows requirements for PyTorch, FlashAttention, Triton, and SoX. Do not run GPU inference or install anything.

  **Verify:** report exact versions, exact callable signatures, safe Windows dependency set, any blockers, and the proposed isolated install command. If the fork only supports a conflicting runtime, stop and ask rather than altering production.

- [ ] **T11.2 Create isolated test environment and minimal probe**

  Create only these external files: `C:\TTS-Streaming-Test\probe_streaming.py` and any required environment/source files under `C:\TTS-Streaming-Test\`. Download the fork as a ZIP (no Git commands) and follow the **verified** Windows install instructions from T11.1. Create a fresh Python 3.12 venv in this external directory. Check for SoX before attempting to install it. Do not download model weights into the project. Do not implement the web server or Chrome changes yet.

  The probe must load the 1.7B Base model and create the voice-clone prompt using the existing Cain files by absolute path. It should use the same short and long English test texts and `stream_generate_voice_clone()` with `emit_every_frames=4`, `decode_window_frames=80` initially. Log model-load time, prompt-preparation time, first-chunk latency, full-generation time, sample rate, chunk count, output duration, and RTF. Save test audio only to `C:\TTS-Streaming-Test\`.

  Keep the first trial simple: streaming **without optional compilation**. If dependencies can't install cleanly, stop. Do not fall back to installing anything into production's venv.

  **Verify:** `py_compile`/import smoke check succeeds in the isolated environment; report the exact user GPU command. No GPU benchmark is run by the builder.

- [ ] **T11.3 Benchmark and Go/No-Go (user, GPU)**

  Stop Ollama and stop the production TTS server before running the isolated GPU test. The builder must provide one exact PowerShell command to run `probe_streaming.py` using the isolated venv. Run the probe, listen to both output files, and paste the short timing summary plus any final errors. Repeat the same text after warmup so first-run overhead is separate.

  **Verify:** compare first-chunk latency and total generation to the current baseline; user confirms Cain similarity and absence of clicks/gaps. Apply the Go/No-Go gate above. If NO-GO, record the reason in the task report and stop this phase; no production files change. If GO, mark T11.3 complete and wait for the user to say “next”.

---

## Phase 12 — Add an opt-in server streaming path (only after T11.3 GO)

- [ ] **T12.1 Add a separate streaming engine**

  Add `cain-reader/server/engines/cain_streaming.py`; update `cain-reader/server/engines/__init__.py` only as needed to register an opt-in name, for example `cain-streaming`. Preserve `CAIN_ENGINE=cain` and `engines/cain.py` exactly as the fallback. Load the model once and cache the clone prompt. Match the fork's verified API; don't invent signatures. Do not install dependencies into production until an explicit dependency/version plan is documented and approved by the user.

  **Verify:** unit-test engine registration and input/error handling without GPU inference; existing server tests pass. Do not claim audio passed.

- [ ] **T12.2 Add a streaming HTTP endpoint**

  Modify only `server/app.py` and add only the tests needed for this endpoint. Keep existing `POST /tts` response format unchanged. Add `POST /tts/stream` with a documented incremental framing protocol (newline-delimited JSON is acceptable) that emits each audio chunk as soon as produced, plus a final completion record; include sample rate and an explicitly documented PCM encoding. Handle errors, early cancellation, the existing synthesis lock, and no-audio/error cases. Don't buffer the full result before sending the first chunk.

  **Verify:** automated tests use a fake streaming engine to prove that multiple chunks are emitted incrementally in order, error responses are handled, and `/health` stays responsive. Existing `/tts` tests continue passing.

- [ ] **T12.3 Implement incremental playback in the offscreen page**

  Modify only `extension/offscreen.js` and, if necessary, `extension/offscreen.html`. Add the new message type(s) without changing existing `PLAY_CHUNK`, `DONE_SENDING`, `STOP`, or `PLAYBACK_STATE` behavior. Use Web Audio (or another tested approach) to queue incoming PCM chunks in order with minimal gaps. Stop must immediately cancel queued/playing stream audio and release resources. Do not start a second overlapping audio pipeline.

  **Verify:** add testable pure helpers where useful; run existing extension tests. Actual browser playback is a user test, not a builder claim.

- [ ] **T12.4 Connect incremental fetching**

  Modify only `extension/background.js` to read `/tts/stream` incrementally and forward each complete audio packet to the offscreen page immediately. Parse partial network reads safely. Keep `AbortController`/runId behavior, preserve retrigger-to-stop semantics, do not buffer the whole response, and toast errors consistently. Keep the existing `/tts` flow available as fallback. Do not alter chunker/cleaner behavior or shortcuts.

  **Verify:** add focused tests for stream framing/parsing if feasible; `node --test extension/tests/chunker.test.js` remains passing. Don't claim first audio is fast until the user tests it in Chrome.

---

## Phase 13 — End-to-end acceptance (user-driven)

- [ ] **T13.1 Browser test (user, GPU)**

  With Ollama stopped, start the new engine using the exact environment variable/command documented by the builder. Reload the unpacked extension. Select the two test texts in a normal HTTPS page and use Ctrl+Shift+S. Confirm first speech starts within 3 seconds after warmup, the full sentence completes, Cain remains recognizable, chunks are in order without audible gaps/clicks, and pressing the shortcut again stops immediately. Also test server offline and cancellation during streaming.

  **Verify:** the user reports results and provides server timing lines. If any critical check fails, fix only the specific defect; allow one focused repair attempt before stopping and reporting the blocker.

- [ ] **T13.2 Baseline/fallback and final regression**

  Confirm `CAIN_ENGINE=cain` still works through the unchanged `/tts` path. Run server pytest and the extension test suite. Confirm no model weights/audio were added to the project and the production fallback still exists. Record only measured first-chunk and total times in `NOTES.md`. Update README/TASKS documentation only after the user accepts the streaming result.

  **Verify:** all automated tests pass; user confirms both streaming mode and fallback work. Stop and wait for user acceptance.

## Deferred / explicitly out of scope

- Do not retry the previous custom CUDA-graph wrapper in the old engine.
- Do not replace or alter the Cain reference audio/transcript.
- Do not silently replace the model with 0.6B, a cloud TTS service, a different character voice, or a different inference framework.
- Do not tune many compile flags. Only consider the fork's documented `enable_streaming_optimizations()` path after the simple streaming benchmark is known; make it a separate, opt-in experiment with a rollback.
- Do not mark Phase 8 acceptance, Phase 9 docs, Phase 10 cleanup, or final acceptance as complete based on this phase.
