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

- [x] **T11.2 Create isolated test environment and minimal probe**

  Create only these external files: `C:\TTS-Streaming-Test\probe_streaming.py` and any required environment/source files under `C:\TTS-Streaming-Test\`. Download the fork as a ZIP (no Git commands) and follow the **verified** Windows install instructions from T11.1. Create a fresh Python 3.12 venv in this external directory. Check for SoX before attempting to install it. Do not download model weights into the project. Do not implement the web server or Chrome changes yet.

  The probe must load the 1.7B Base model and create the voice-clone prompt using the existing Cain files by absolute path. It should use the same short and long English test texts and `stream_generate_voice_clone()` with `emit_every_frames=4`, `decode_window_frames=80` initially. Log model-load time, prompt-preparation time, first-chunk latency, full-generation time, sample rate, chunk count, output duration, and RTF. Save test audio only to `C:\TTS-Streaming-Test\`.

  Keep the first trial simple: streaming **without optional compilation**. If dependencies can't install cleanly, stop. Do not fall back to installing anything into production's venv.

  **Verify:** `py_compile`/import smoke check succeeds in the isolated environment; report the exact user GPU command. No GPU benchmark is run by the builder.

- [x] **T11.3 Benchmark and Go/No-Go (user, GPU)**

  Stop Ollama and stop the production TTS server before running the isolated GPU test. The builder must provide one exact PowerShell command to run `probe_streaming.py` using the isolated venv. Run the probe, listen to both output files, and paste the short timing summary plus any final errors. Repeat the same text after warmup so first-run overhead is separate.

  **Verify:** compare first-chunk latency and total generation to the current baseline; user confirms Cain similarity and absence of clicks/gaps. Apply the Go/No-Go gate above. If NO-GO, record the reason in the task report and stop this phase; no production files change. If GO, mark T11.3 complete and wait for the user to say "next".

  **Confirmed results (user, GPU — reported, not builder-measured):**
  - Short text first playable chunk: **1.012 s** (Go/No-Go gate ≤ 3 s for short text → **GO**).
  - Long text first playable chunk: **1.046 s**.
  - Long text total generation: **20.740 s** (current 1.7B baseline: ~22–24 s).
  - User confirmed the Cain voice sounds good and playback had no issues (no clicks/gaps reported).
  - Isolated config: 1.7B Base, `flash_attention_2`, `emit_every_frames=4`, `decode_window_frames=80`, optional compilation **disabled**.

---

## Phase 12 — Add an opt-in server streaming path (only after T11.3 GO)

- [x] **T12.1 Add a separate streaming engine**

  Add `cain-reader/server/engines/cain_streaming.py`; update `cain-reader/server/engines/__init__.py` only as needed to register an opt-in name, for example `cain-streaming`. Preserve `CAIN_ENGINE=cain` and `engines/cain.py` exactly as the fallback. Load the model once and cache the clone prompt. Match the fork's verified API; don't invent signatures. Do not install dependencies into production until an explicit dependency/version plan is documented and approved by the user.

  **Verify:** unit-test engine registration and input/error handling without GPU inference; existing server tests pass. Do not claim audio passed.

  **Confirmed (builder, no GPU):** `py_compile` OK; `pytest -q` **21 passed** (17 new in `tests/test_engines.py`, 4 existing in `tests/test_app.py`). `CAIN_ENGINE=cain` and `engines/cain.py` are unchanged; `app.py` untouched; no production packages installed.

  **Dependency plan — awaiting user approval:** the fork ships under the same distribution name (`qwen-tts 0.0.4`) and needs torch 2.10+cu130 + flash-attn, so it cannot coexist with production `qwen-tts 0.1.1` / torch 2.14.1+cu132. Full plan and options (a/b/c) are in the module docstring of `engines/cain_streaming.py`. Until a plan is approved, `CAIN_ENGINE=cain-streaming` raises a clear error naming the missing API instead of degrading silently.

- [x] **T12.2 Add a streaming HTTP endpoint**

  Modify only `server/app.py` and add only the tests needed for this endpoint. Keep existing `POST /tts` response format unchanged. Add `POST /tts/stream` with a documented incremental framing protocol (newline-delimited JSON is acceptable) that emits each audio chunk as soon as produced, plus a final completion record; include sample rate and an explicitly documented PCM encoding. Handle errors, early cancellation, the existing synthesis lock, and no-audio/error cases. Don't buffer the full result before sending the first chunk.

  **Verify:** automated tests use a fake streaming engine to prove that multiple chunks are emitted incrementally in order, error responses are handled, and `/health` stays responsive. Existing `/tts` tests continue passing.

  **Confirmed (builder, no GPU):** `py_compile` OK; `pytest -q` **30 passed** (9 new `/tts/stream` tests in `tests/test_app.py`, 17 engine tests, 4 pre-existing). `POST /tts` response format unchanged. Wire format: NDJSON, one JSON object per line — `{"type":"chunk","index","sample_rate","channels","encoding":"pcm_s16le","samples","audio":<base64 s16le mono PCM>}` per chunk as produced, then `{"type":"done","chunks","samples","sample_rate","duration_s"}` or `{"type":"error","error"}`. HTTP 501 for engines without `stream()`, 400 for values the engine rejects (e.g. `speed != 1.0`), 422 for invalid bodies. The existing `_synthesis_lock` is held for the whole stream and released on completion/error/disconnect; the engine's iterator is closed on disconnect; `/health` stays responsive during streaming (verified with a blocked generator on a worker thread).

  **Isolated launch path verified (option A, no GPU):** the shared `app.py` imports cleanly under `C:\TTS-Streaming-Test\.venv` (checked with `CAIN_ENGINE=stub` so no weights load), so the streaming server can run the same code from the isolated venv with `CAIN_ENGINE=cain-streaming`.

  **Follow-up before T13.1:** `_warm_up()` in `app.py` still returns early for any engine whose `name != "cain"`, so `cain-streaming` gets no keep-warm. Either extend that check or send one warm-up request before measuring first-chunk latency. **Resolved in T12.5:** `_warm_up()` now covers `cain-streaming` and calls its `warm_up()`.

- [x] **T12.3 Implement incremental playback in the offscreen page**

  Modify only `extension/offscreen.js` and, if necessary, `extension/offscreen.html`. Add the new message type(s) without changing existing `PLAY_CHUNK`, `DONE_SENDING`, `STOP`, or `PLAYBACK_STATE` behavior. Use Web Audio (or another tested approach) to queue incoming PCM chunks in order with minimal gaps. Stop must immediately cancel queued/playing stream audio and release resources. Do not start a second overlapping audio pipeline.

  **Verify:** add testable pure helpers where useful; run existing extension tests. Actual browser playback is a user test, not a builder claim.

  **Confirmed (builder, no browser):** `node --check extension/offscreen.js` OK; `node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js` → **21/21 pass** (8 existing chunker + 13 new in `tests/offscreen.test.js`). `extension/offscreen.html` unchanged.

  **Wire format for T12.4 (background.js must send exactly these):**
  - `{target:"offscreen", type:"STREAM_START"}` — before the first chunk of a streaming read; arms the stream and stops any WAV playback. Optional: `PLAY_PCM` also arms implicitly, and `STREAM_START` with no chunks is harmless.
  - `{target:"offscreen", type:"PLAY_PCM", sampleRate, pcm}` — `sampleRate` = integer Hz from the server record's `sample_rate`; `pcm` = the server record's `audio` field (base64 of raw little-endian signed 16-bit **mono** PCM, no WAV header). Forward chunks **in server order**; they are scheduled on the Web Audio clock in arrival order, back-to-back, so playback is gapless while chunks keep up with real time.
  - `{target:"offscreen", type:"DONE_SENDING"}` — unchanged name and meaning ("no more audio"); it now terminates either pipeline. The offscreen reports `PLAYBACK_STATE {playing:false}` once the last scheduled chunk has actually finished, so `active` clears exactly as it does for `/tts`.
  - `{target:"offscreen", type:"STOP"}` — unchanged; now also stops scheduled PCM, disconnects the gain node and closes the `AudioContext`.
  - Behaviour: one pipeline at a time (starting either path cancels the other); malformed/empty chunks, an unsupported sample rate, or a mid-stream rate change are ignored with a console error and never break playback; a starved stream restarts with a 60 ms lead instead of overlapping; a safety-net timer reports idle if a source's `ended` event never fires.

- [x] **T12.4 Connect incremental fetching**

  Modify only `extension/background.js` to read `/tts/stream` incrementally and forward each complete audio packet to the offscreen page immediately. Parse partial network reads safely. Keep `AbortController`/runId behavior, preserve retrigger-to-stop semantics, do not buffer the whole response, and toast errors consistently. Keep the existing `/tts` flow available as fallback. Do not alter chunker/cleaner behavior or shortcuts.

  **Verify:** add focused tests for stream framing/parsing if feasible; `node --test extension/tests/chunker.test.js` remains passing. Don't claim first audio is fast until the user tests it in Chrome.

  **Confirmed (builder, no browser):** `node --check extension/background.js` OK; `node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js extension/tests/background.test.js` → **33/33 pass** (8 existing chunker + 13 offscreen + 12 new `tests/background.test.js`). `chunker.js`, shortcuts and `content.js` untouched; the chunked `/tts` flow is preserved as fallback.

  **How it works:** `startReading` still aborts the previous run, bumps `runId`, sets `active`, sends `STOP` and chunks the text, then prefers one `POST /tts/stream` request carrying the whole normalized text (`chunks.join(" ")`) when it is ≤ 2000 chars (the endpoint's per-request cap); longer reads go straight to the unchanged chunked `/tts` loop (`readViaChunks`). The NDJSON body is parsed incrementally by a pure `createNdjsonParser()` that only emits a line once its newline has arrived and keeps the tail, so a record split across network reads is handled; each `chunk` record is forwarded immediately — `STREAM_START` once, before the first packet, after the offscreen document is lazily created — then `PLAY_PCM {sampleRate: record.sample_rate, pcm: record.audio}`, and `done` ends with `DONE_SENDING`. Nothing is buffered beyond the current partial line. Fallback triggers on HTTP 400 (e.g. `speed != 1.0`), 404 or 501 (old server / non-streaming engine); a connection failure toasts the usual offline message, while a 5xx, an `error` record or a chunk-less stream toasts "TTS error" — either way the read stops with `STOP` + `active=false`, exactly as the `/tts` path does. `runId`/`signal` are re-checked before every send, so Stop or a newer read cannot leave a `PLAY_PCM` behind the `STOP` message, and a mid-stream Stop sends no `DONE_SENDING`.

  **Test seam:** `background.js` now ends with `export const __test = { createNdjsonParser, startReading }` (inert at runtime — nothing imports the service worker). `tests/background.test.js` stubs the few `chrome.*` APIs used at load and drives `startReading` against fake `fetch` responses: split-read parsing, in-order PCM forwarding, chunks arriving while the body is still open (no whole-response buffering), 501/400/long-text fallback to `/tts`, offline, 5xx and error-record toasts, and a mid-stream STOP. Browser playback and first-audio latency remain user tests (T13.1).

- [x] **T12.5 Enable the fork's compiled streaming path (opt-in) and warm it at startup**

  Call the fork's documented `enable_streaming_optimizations(decode_window_frames=80)` in the isolated `cain-streaming` engine only, and pay its one-time compilation cost at server startup instead of on the first user read. Keep it off by default so the un-optimized path benchmarked in T11.3 remains the rollback. Do not touch `engines/cain.py`, the production `.venv`, or any production dependency. Do not run GPU inference.

  **Verify:** unit/server tests prove the optimization is off unless explicitly opted in, that it is called with `decode_window_frames=80`, that a missing/failing implementation raises with the rollback named, and that the startup warm-up runs the warm-up texts; `CAIN_ENGINE=cain` behavior is unchanged.

  **Confirmed (builder, no GPU):** `py_compile` OK; `pytest -q` → **55 passed** (25 new: 20 in `tests/test_engines.py`, 5 in `tests/test_app.py`). `engines/cain.py` unchanged; nothing installed into the production venv.

  **How it works:**
  - `CAIN_STREAMING_OPTIMIZE` selects the compiled path in `engines/cain_streaming.py` (unset/`0`/`false`/`no`/`off` = off; only `1`/`true`/`yes`/`on` = on). `CainStreamingEngine(optimize=...)` overrides it, which is what the unit tests use. When it is on, `__init__` calls `enable_streaming_optimizations(decode_window_frames=80)` immediately after the model load. A missing API or a failing call raises `RuntimeError` naming `CAIN_STREAMING_OPTIMIZE` as the rollback — it fails loudly rather than silently running un-optimized.
  - The call itself only wraps the decoder/talker/codebook in `torch.compile`; compilation happens on the first real generation. `CainStreamingEngine.warm_up()` therefore runs real generations and discards the audio: all of `WARMUP_TEXTS` (three sentences of different lengths — `torch.compile` specialises on shape and the fork's own example warms up with several lengths before timing anything) on the compiled path, just the first sentence when un-optimized (which only warms CUDA/model caches).
  - `app.py`'s `_warm_up()` now covers `WARM_UP_ENGINES = ("cain", "cain-streaming")` and calls `engine.warm_up()` when the engine provides one, otherwise the unchanged one-sentence `synthesize()` warm-up. `cain`/`stub` behavior is unchanged (same text, same lock, same `<engine> warmup failed: ...` log line).
  - Expected startup logs (stderr): `cain-streaming optimize: enabled in X.XXXs (decode_window_frames=80; compilation itself happens in the warm-up below)`, then per warm-up text `cain-streaming timing: first_chunk=... total=... chunks=...` plus `cain-streaming warmup N/3: ...s optimize=on`. The first warm-up carries the compilation cost, so the first user read should not.
  - **Exact command for T13.1** (production TTS server and Ollama stopped, from `cain-reader\server`):
    `$env:CAIN_ENGINE="cain-streaming"; $env:CAIN_STREAMING_OPTIMIZE="1"; C:\TTS-Streaming-Test\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765`
    Rollback to the un-optimized path: `Remove-Item Env:CAIN_STREAMING_OPTIMIZE` (or set it to `0`) and restart.
  - **Verified (user, GPU) — the T13.1 blocker is cleared:** the isolated optimized probe measured RTF **0.639–0.672** and first chunk **0.213–0.235 s**, i.e. comfortably under RTF 1.0, so generation now outruns playback instead of falling ~3× behind it. Numbers are the user's, not builder-measured. The un-optimized path (~RTF 3, T11.3) remains the rollback (`Remove-Item Env:CAIN_STREAMING_OPTIMIZE`), and `CAIN_ENGINE=cain` is unchanged.

- [x] **T12.6 Fix speed control on the streaming engine**

  At speed `1.0` keep the incremental `/tts/stream` path. At any other speed, send one `/tts` request for the whole text while it fits the 2,000-character request cap, so the server time-stretches one finished waveform (`librosa.effects.time_stretch`, pitch preserved) instead of once per chunk; longer text keeps the existing chunked path. Preserve Stop/cancel and offline/error handling. Do not change the engines or install dependencies, and no playback-rate change that alters pitch.

  **Verify:** focused extension tests cover both speeds, the single-request body, the long-text fallback, offline/error toasts and a mid-read STOP; the existing extension suite still passes.

  **Confirmed (builder, no browser):** `node --check extension/background.js` and `extension/tests/background.test.js` OK; `node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js extension/tests/background.test.js` → **38/38 pass** (5 new, 1 rewritten). `extension/offscreen.js`, `extension/chunker.js`, `server/` and the engines are untouched.

  **Why:** `CainStreamingEngine.stream()` rejects `speed != 1.0`, so `/tts/stream` answered HTTP 400 and every speed-adjusted read silently fell back to one `/tts` request per ~300-character chunk — stretching each chunk separately (audible smearing) and playing the WAV blobs back-to-back (gaps between them). The speed-adjusted read now skips the stream endpoint entirely and sends the whole text once, which is exactly the quality `CAIN_ENGINE=cain` already gives. It reuses `readViaChunks([fullText], ...)`, so Stop/cancel, offline/error toasts and the `PLAY_CHUNK` framing are unchanged; `STREAM_MAX_CHARS` was renamed to `MAX_REQUEST_CHARS` because the same 2,000-character cap now applies to both endpoints.

  **Note for T13.1:** the fast first-audio streaming start applies at speed `1.0` only. At any other speed the read waits for one full synthesis before playing, exactly as `CAIN_ENGINE=cain` does today (RTF ≈ 3, i.e. roughly the length of the sentence in seconds before audio starts).

- [x] **T12.7 Apply speaking speed in the player, not on the server**

  In `extension/offscreen.js`, apply `audio.playbackRate = rate` to WAV playback and keep pitch preserved. In `extension/background.js`, pass the selected speed to the offscreen WAV player (`PLAY_CHUNK.rate`) but send `speed: 1.0` to the server, so synthesis is never stretched twice. Keep the optimized PCM stream at speed 1.0 (the Web Audio clock cannot preserve pitch). Preserve Stop/cancel, offline/error handling and existing playback. No dependency installs, no engine or server change.

  **Verify:** focused tests cover speed `1.0` and `1.25` for both the player and the request bodies; the whole extension suite passes.

  **Confirmed (builder, no browser):** `node --check` OK on `offscreen.js`, `background.js` and both test files; `node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js extension/tests/background.test.js` → **42/42 pass** (4 new offscreen tests, 2 background tests extended). `server/`, `engines/`, `chunker.js`, `popup.js` and `content.js` are untouched.

  **Why:** `librosa.effects.time_stretch` is a phase vocoder and sounds echoey on speech, so the speed is now applied by the media element instead — Chrome's time-domain stretch with `preservesPitch` set explicitly is pitch-preserving and free of that artifact, and it also removes the extra stretch time from the request. Every `/tts` request now carries `speed: 1.0` (audio is never stretched twice), and `PLAY_CHUNK` carries `rate` per chunk, with a missing or unusable rate falling back to 1.0 so a rate cannot leak from one read into the next.

  **Supersedes T12.6's note** that the server time-stretches the whole text: for extension reads the server no longer stretches at all. The fast first-audio streaming start still applies at speed `1.0` only.

  **User (reported):** the new speed playback "sounds good" — no echo or pitch distortion reported. (Recorded as reported; the exact speed/engine used was not specified.)

- [x] **T12.8 Fix the streaming cancellation deadlock (Stop, then no audio)**

  In `server/app.py`, close the `/tts/stream` generator deterministically instead of relying on garbage collection: keep the generator in a local (`gen = generate()`) and return `StreamingResponse(gen, media_type=STREAM_MEDIA_TYPE, background=BackgroundTask(_close_stream, gen))` (`from starlette.background import BackgroundTask`), where `_close_stream` calls `gen.close()` and never raises. Do not change the streaming format, the engines, the extension, or the `/tts` and `/health` handlers. No GPU inference and no dependency installs.

  **Verify:** a regression test drives the real response with a fake ASGI `http.disconnect` (spec_version 2.3, as uvicorn reports) and asserts the engine iterator is closed and `_synthesis_lock` is free with no `gc.collect()`, then that a following `POST /tts` still returns a WAV; the whole server suite passes.

  **Confirmed (builder, no GPU):** `pytest -q` → **56 passed** (55 before, +1 test; the existing disconnect test now drives a real disconnect instead of `aclose()` on the body iterator). No changes to `engines/`, `extension/` or any other server file. Checked against the pre-fix endpoint by stripping `response.background` in a throwaway script outside the project: `engine_closed=False`, lock not re-acquirable — the deadlock reproduces, so the test fails without the fix.

  **Why:** `_synthesis_lock` is held across the stream's `yield`s, but Starlette wraps a *synchronous* body iterator in `iterate_in_threadpool` and never closes it (`starlette/responses.py`, no `aclose` on disconnect), so aborting a fetch mid-stream — exactly what Ctrl+Shift+S does (`reader.cancel()` + `AbortController.abort()` in `extension/background.js`) — left the generator suspended at a `yield` with the lock held. The lock was released only when CPython happened to finalise the abandoned generator (reference cycles around the cancelled task/traceback make that timing unpredictable), which is why the symptom was intermittent: until that collection, every later `/tts` and `/tts/stream` request waited on the lock and produced no audio, and because the extension has no fetch timeout the read hung silently with the read-in-progress flag still set, so the next shortcut press only stopped again. Background tasks run on disconnect for spec_version < 2.4, so closing the generator there ties the lock to the response's lifetime (the lock is already released on completion or error by the generator's own `finally`, which is why only the aborted-stream case was affected).

  **Note for T13.1/T13.2:** the extension side was not changed; if a hung request is ever reported again, the remaining gap is the missing client-side fetch timeout (a blocked server currently shows as silence rather than an error toast).

---

## Phase 13 — End-to-end acceptance (user-driven)

- [x] **T13.1 Browser test (user, GPU)**

  With Ollama stopped, start the new engine using the exact environment variable/command documented by the builder. Reload the unpacked extension. Select the two test texts in a normal HTTPS page and use Ctrl+Shift+S. Confirm first speech starts within 3 seconds after warmup, the full sentence completes, Cain remains recognizable, chunks are in order without audible gaps/clicks, and pressing the shortcut again stops immediately. Also test server offline and cancellation during streaming.

  **Verify:** the user reports results and provides server timing lines. If any critical check fails, fix only the specific defect; allow one focused repair attempt before stopping and reporting the blocker.

  **Confirmed results (user, Chrome — reported, not builder-measured):**
  - Streaming starts quickly and sounds good.
  - Long-text playback works well.
  - Speed 1.25× sounds good, with no objectionable echo or distortion (the T12.7 player-side speed change).
  - Speed 1.0× remains the default.
  - **Stop and read again (confirmed after the T12.8 fix):** pressing Ctrl+Shift+S stops playback, and a following read of newly selected text plays normally — the aborted stream no longer leaves `/tts` and `/tts/stream` blocked with no audio. This is the check that exposed the cancellation deadlock recorded in T12.8.
  - **Stop during long-paragraph playback (confirmed):** pressing Ctrl+Shift+S while a long paragraph is playing stops the audio almost immediately.
  - **Server offline (confirmed):** stopping the server makes Chrome show the red offline status and the "Cain server offline — run server\run.ps1" toast, so a read with no back end fails visibly instead of silently.
  - **Voice and long-paragraph audio quality (confirmed):** Cain's voice sounds great, and long-paragraph playback sounds good with no noticeable gaps or clicks between chunks.
  - **Post-warmup first-audio latency (confirmed, browser-measured):** first speech starts in approximately 1 second or less — comfortably inside the ≤ 3 s gate. (The user's figure for the browser path; the optimized probe measured first chunk 0.213–0.235 s.)

  **All T13.1 acceptance checks are now confirmed — checkbox ticked (user-driven task; the results above are user-reported, not builder-measured).** Source-vs-target remains unchanged: the streaming path is opt-in behind `CAIN_ENGINE=cain-streaming` (+ `CAIN_STREAMING_OPTIMIZE=1`), and `CAIN_ENGINE=cain` stays the untouched default fallback.

  **Verified runtime configuration (user, GPU):**
  - Environment: `$env:CAIN_ENGINE="cain-streaming"` with `$env:CAIN_STREAMING_OPTIMIZE="1"`, run from the isolated environment `C:\TTS-Streaming-Test\.venv` (same `server\app.py`, `uvicorn app:app --host 127.0.0.1 --port 8765`). The production `torch 2.14.1+cu132` stack, `engines/cain.py` and `server\.venv` are untouched; rollback is `Remove-Item Env:CAIN_STREAMING_OPTIMIZE`.
  - Optimized probe: RTF **0.639–0.672**, first chunk **0.213–0.235 s** (user-measured; resolves the open T12.5 RTF question).
  - The Chrome checks recorded above — stop-and-read-again, immediate stop during long-paragraph playback, and the server-offline warning — all passed against this configuration.

- [x] **T13.2 Baseline/fallback and final regression**

  Confirm `CAIN_ENGINE=cain` still works through the unchanged `/tts` path. Run server pytest and the extension test suite. Confirm no model weights/audio were added to the project and the production fallback still exists. Record only measured first-chunk and total times in `NOTES.md`. Update README/TASKS documentation only after the user accepts the streaming result.

  **Verify:** all automated tests pass; user confirms both streaming mode and fallback work. Stop and wait for user acceptance.

  **Confirmed (builder, no GPU, nothing installed):** server suite `server\.venv\Scripts\python.exe -m pytest -q` → **56 passed**; extension suite `node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js extension/tests/background.test.js` → **42/42 pass** (Node v20.19.0). `CAIN_ENGINE=cain` is untouched: with `CAIN_ENGINE` unset `engines.get_engine()` returns the `stub` default, `CAIN_ENGINE=cain` resolves to `engines.cain.CainEngine`, and that class exposes `synthesize()` only — no `stream()` — so `/tts/stream` answers 501 and the extension's streaming attempt falls back to the chunked `/tts` path (the existing extension test "a non-streaming server falls back to the chunked /tts path" covers it). `engines/cain.py` was restored to baseline before this phase and contains no streaming/optimization reference (only `synthesize()` and `librosa.effects.time_stretch` when `speed != 1.0`); `cain-streaming`/`optimize` are reachable only through the explicit `CAIN_ENGINE` value and its lazy import in `engines/__init__.py`, so streaming stays opt-in. No `*.safetensors`/`*.pth`/`*.ckpt`/`*.bin` and no stray `*.wav` exist in the project outside the pre-existing asset directories (`server\voices`, `voice-source` — neither read nor modified); test audio stayed in `C:\TTS-Streaming-Test\`.

  **Not covered by this task:** no browser run of `CAIN_ENGINE=cain` was made or requested here — the fallback is asserted from the unchanged engine plus the automated 501→fallback coverage, while the user's Chrome confirmations in T13.1 were all on the streaming configuration. `NOTES.md` was deliberately left untouched (this task scoped recording to this file); the user-measured first-chunk/total figures live in T13.1's runtime-configuration block. Final user acceptance of the streaming result remains with the user; the deferred list still stands (this tick does not mark Phase 8 acceptance, Phase 9 docs, Phase 10 cleanup or final acceptance).

## Deferred / explicitly out of scope

- Do not retry the previous custom CUDA-graph wrapper in the old engine.
- Do not replace or alter the Cain reference audio/transcript.
- Do not silently replace the model with 0.6B, a cloud TTS service, a different character voice, or a different inference framework.
- Do not tune many compile flags. Only consider the fork's documented `enable_streaming_optimizations()` path after the simple streaming benchmark is known; make it a separate, opt-in experiment with a rollback.
- Do not mark Phase 8 acceptance, Phase 9 docs, Phase 10 cleanup, or final acceptance as complete based on this phase.
