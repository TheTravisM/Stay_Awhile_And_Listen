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

## T7.4 — Latency check (recorded 2026-10-16)

`scratch\body100.json` (~100-char single sentence) and `scratch\body300.json`
(~300 chars) already exist. Commands (run from `server\`, Cain server up,
Ollama stopped):

```
curl.exe -s -o NUL -w "%{time_total}" -X POST localhost:8765/tts -H "content-type: application/json" -d "@../scratch/body100.json"
curl.exe -s -o NUL -w "%{time_total}" -X POST localhost:8765/tts -H "content-type: application/json" -d "@../scratch/body300.json"
```

Measured (user, 2026-10-16):
- 100-char request: **21.096710 s** (~21.10 s).
- 300-char request: not yet confirmed (run the command above, paste the time).

First-chunk 3-second target: **NOT MET** (21.10 s > 3 s). `chunker.js` is set
to `firstMaxChars = 80` (user change, verified on disk). Tests updated to
assert first chunk ≤ 80 and the rest ≤ 300;
`node --test extension/tests/chunker.test.js` → 6/6 pass.

Gap explanation (required by T7.4 Verify): latency is per sentence, not per
character. Qwen3-TTS decodes each sentence autoregressively; the T7.2 probe
measured 18.20 s for a ~15-word sentence on the RTX 3090 (bfloat16, sdpa).
`body100.json` is one ~18-word sentence, so 21.10 s is consistent with that
rate. Shrinking the first chunk from 120 to 80 caps it at roughly one
sentence but cannot make a single sentence synthesize faster. The one-chunk
lookahead fetch (T5.2) overlaps fetch of chunk 2 with synthesis of chunk 1,
but the first audible chunk still waits ~21 s. Mitigations outside T7.4 scope:
T8.1 keep-warm (only helps post-restart overhead, already loaded here), or a
faster/smaller model. Note: final-acceptance item "voice within ~3 s" will
 fail at this rate until the engine is faster.

## T8.1 — Server keep-warm (verified 2026-10-16)

`server\app.py` now calls `_warm_up()` at startup: when the loaded engine is
`cain`, it synthesizes one throwaway sentence ("Stay awhile and listen.")
holding `_synthesis_lock`, then serves requests. A warmup failure is logged to
stderr and does not crash startup. Stub engine is unaffected (skipped).
`app.py` imports cleanly; `pytest -q` → 3 passed.

Verify (user, GPU): restart the Cain server, then measure the first and second
100-char `/tts` requests. Measured (user, 2026-10-16):
- First request: **22.918612 s**
- Second request: **20.077004 s**
- Ratio: **1.14×** (≤ 1.5× required → PASS)

Note: keep-warm shaves ~2.9 s off the post-restart first request (T7.4's
unwarmed first request was 21.096710 s) but the 3-second first-chunk target
remains unmet (22.9 s) — latency is dominated by per-sentence Qwen3-TTS
inference on the RTX 3090, not cold-start overhead.

## T8.2 — Edge cases (builder inspection 2026-10-16; awaiting user manual checks)

Builder read all six scenarios against the current code. No confirmed code
defect found; no `chunkText` fix needed. One consistent test added:
`extension/tests/chunker.test.js` new case "emoji, quotes and newlines
round-trip without losing words" (pure-function round-trip on emoji, straight/
curly quotes, newlines, tabs).

Test results:
- `node --test extension/tests/chunker.test.js` → 8 pass, 0 fail.
- `server\` `.\.venv\Scripts\python.exe -m pytest -q` → 4 passed (includes
  `test_tts_unicode_not_422`: emoji/curly quotes/newline → 200 `RIFF`, no 422,
  on the stub engine).

Scenario assessment:
1. Nothing selected + Ctrl+Shift+S → `background.js` command handler toasts
   "Select some text first" before `startReading` (also guarded for empty
   chunks). Code OK — needs user confirmation.
2. Server off → `fetch` `TypeError` → toast "Cain server offline — run
   server\\run.ps1", `STOP` to offscreen, active=false, loop exits. `prefetch`
   marks promise handled so a stopped run can't leave a console error loop;
   `sendOffscreen` swallows unresponsive-port rejects. Code OK — user checks
   no repeated console errors.
3. 6,000-char selection → chunker caps at 5,000 and sets truncated → warn
   toast "Reading first 5,000 characters". Fetch loop runs with one-chunk
   lookahead, so a synthesis request is always in flight during reading,
   which should keep the MV3 service worker alive. If the user observes the
   SW dying partway (read stops, no toast), the prescribed fallback (move
   fetch loop to `offscreen.js`) is then required.
4. Trigger mid-read → context-menu path calls `startReading` directly: aborts
   old controller (in-flight fetches die), runId++ (old loop's every
   checkpoint bails), `STOP` clears the offscreen queue before new chunks can
   arrive. No overlap path found.
   NOTE: the shortcut (Ctrl+Shift+S) is the T5.3 toggle — it StOPS an in-
   progress read, it does not re-read. This is by design (T5.3), not a T8.2
   defect. To re-read a different selection mid-play: press Ctrl+Shift+S
   (stop), then trigger again, or use the context menu.
5. Emoji/quotes/newlines → `/tts` validation is length-only (1–2000 chars);
   chunks are ≤300 chars so no 422 path exists for these characters. Stub
   server test proves no 422; real-engine audibility is a user check (check
   below). No chunker fix made.
6. `chrome://`/no-content-script page → `readSelection` sendMessage rejects →
   `executeScript` throws → returns null → handler warns "cain: could not
   read selection on this tab" and stops; no uncaught throw. Context menu
   uses `info.selectionText` and works in iframes (menu is registered on
   "selection" context, independent of the content script).

Scratch pages created (open in Chrome by file URL):
- `scratch\longpage.html` — 6,887 visible chars (exceeds the 6,000 cap).
- `scratch\emoji.html` — emoji, straight/curly quotes, newlines, tabs.
- `scratch\iframe.html` — selectable text inside an iframe.
- `server\scratch` not used; voice files untouched.

Manual checklist (user — stop and tick each here as it passes):
[ ] A. Plain page, select nothing, Ctrl+Shift+S → toast "Select some text first".
[ ] B. Kill the Cain server (stop run.ps1). Select text on any https page, Ctrl+Shift+S → toast "Cain server offline — run server\run.ps1"; open the service worker console (chrome://extensions → service worker) and confirm no repeated error loop. Reopen the extension popup → red "Server offline" dot.
[ ] C. Cain server running (Ollama stopped). Open scratch\longpage.html, Ctrl+A, Ctrl+Shift+S → warn toast "Reading first 5,000 characters"; speech plays in order and continues (do not wait for the full ~5,000 chars — after ~2 minutes, press Ctrl+Shift+S to stop; that also serves as check D).
[ ] D. During any playback, Ctrl+Shift+S → audio stops in < 0.5 s. Then select text (any page) and Ctrl+Shift+S again → old read is gone and the new one starts with no overlapping audio.
[ ] E. Open scratch\emoji.html, Ctrl+A, Ctrl+Shift+S → no 422 (server console shows a 200), no service-worker error, and the speech is intelligible (emoji not spoken as garbage).
[ ] F. Open scratch\iframe.html, select the text inside the frame, right-click → "Read with Cain" → it plays. Then open a chrome:// page (e.g. chrome://extensions), press Ctrl+Shift+S → service worker console shows the warning "cain: could not read selection on this tab" and does not throw.

## T8.2 — Edge cases (builder pass 2026-10-16; USER VERIFICATION PENDING)

Status: **NOT complete.** T8.1's implementation and recorded results are
untouched. T8.2's checkbox stays unticked until the user checks all six lines.

Files inspected, unchanged: `extension/offscreen.js`, `content.js`,
`chunker.js`, `popup.js`, `popup.html`, `manifest.json`, `server/app.py`,
`engines/*`, `tests/*`.
Files changed: `extension/background.js`, `extension/tests/chunker.test.js`,
`server/tests/test_app.py`.

Confirmed fixes (all in `background.js`, smallest safe change):
1. Empty-selection toast now reads **"Select some text first"** (was
   "Select Some Text And Listen"), matching T4.2/T8.2. Two call sites.
2. The one-chunk-lookahead fetch could reject **unhandled** when a run exits
   early (server offline, or a newer read aborts it) → an avoidable
   service-worker console error. Added `prefetch()` which attaches a no-op
   rejection handler; the awaited path still surfaces errors to the existing
   toast logic.

No `chunkText` change: emoji/curly quotes/newlines verified fine at the pure
level (new test); emoji/control-char cleanup is explicitly Phase 10.
The fetch loop was **not** moved to `offscreen.js` — no confirmed SW death.

Tests (builder, 2026-10-16):
- `node --test extension/tests/chunker.test.js` → **7/7 pass** (added unicode test).
- `python -m pytest -q` (from `server\`) → **4 passed, 1 warning** (added unicode test).

Manual checklist for the user — every line is USER-ONLY; browser/GPU behavior
is NOT covered by the automated tests above:
- [ ] 1. Select nothing, press Ctrl+Shift+S → toast **"Select some text first"**, no audio, no error.
- [ ] 2. Stop the Cain server, select text, press Ctrl+Shift+S → toast
      "Cain server offline — run server\run.ps1". In the service-worker console
      (chrome://extensions → service worker) confirm no repeating error loop /
      unhandled-rejection spam. (One `net::ERR_CONNECTION_REFUSED` per attempt
      is browser-level and expected.)
- [ ] 3. Select ~6,000 characters, trigger a read → toast "Reading first 5,000
      characters"; exactly 5,000 chars read; audio plays to the end with the
      service worker alive throughout. Report if the SW dies partway (then, and
      only then, the fetch loop moves to `offscreen.js`).
- [ ] 4. While reading, trigger a NEW read. Use the **context menu** ("Read with
      Cain"): the Ctrl+Shift+S shortcut is a documented toggle (T5.3), so it
      stops instead of restarting. Old audio stops, new audio starts, no overlap.
- [ ] 5. Select text with emoji (😀), curly quotes (“ ” ‘ ’) and newlines, read
      it → no HTTP 422 and no server crash/traceback in the server terminal.
- [ ] 6. Page inside an iframe: select text, use the context menu → reads via
      `info.selectionText`. On a `chrome://` page press Ctrl+Shift+S →
      service-worker console logs "cain: could not read selection on this tab";
      no thrown error.

Record each result here and tick the T8.2 checkbox in `TASKS.md` only when all
six pass.

## Core Cain TTS playback — diagnosis & fix (2026-10-16)

Status: **fix applied, NOT yet verified by the user.** T8.2 stays unchecked and
the edge-case tests (6,000 chars etc.) must wait until basic playback passes.

Playback path traced: selection/shortcut -> `content.js` `GET_SELECTION` ->
`background.js` `readSelection` -> `chunkText` -> `ensureOffscreen` ->
`fetch POST /tts` (one-chunk lookahead) -> base64 -> `PLAY_CHUNK` ->
`offscreen.js` (`base64ToBlob` -> object URL -> `Audio.play`) -> `ended` ->
`PLAYBACK_STATE {playing:false}` -> `setActive(false)`. The code path itself is
correct; `pytest` (server) and the pure chunker tests pass, and the base64
round-trip was checked byte-for-byte against real 24 kHz Cain WAVs.

Two confirmed findings:

1. **Engine selection is not visible from the extension.** `engines/__init__.py`
   defaults `CAIN_ENGINE` to `"stub"`; the Cain engine only loads when the
   server is started with `$env:CAIN_ENGINE="cain"`. A server left on the
   default would play tones (stub), not Cain's voice, and the extension has no
   way to tell — except `/health` (`"engine"`) and the popup status text
   ("Server online (cain)" vs "(stub)"). **This is the first thing to check.**

2. **Confirmed code defect — offscreen document outlives its 30 s lifetime
   window.** Chrome force-closes an offscreen document created with reason
   `AUDIO_PLAYBACK` **30 s after creation if it has not started playing audio**
   (and 30 s after it later goes silent). Source: Chromium
   `extensions/browser/api/offscreen/audio_lifetime_enforcer.cc`
   (`g_audio_timeout = base::Seconds(30)`), and the `chrome.offscreen` docs
   ("AUDIO_PLAYBACK ... closed after 30 seconds without audio playing").
   `background.js` created that document **before** the first `/tts` fetch, and
   Cain synthesis is ~20-23 s per sentence on this PC (T7.2/T7.4/T8.1). Any
   run where the first synthesis exceeded ~30 s let Chrome close the document
   before the first `PLAY_CHUNK` arrived; `sendOffscreen` swallows the failure,
   so the read produced **no audio and no error**, and `active` stayed true.
   This never showed with the stub engine (instant synthesis), which is why
   T5.2's tone test passed.

Fix (smallest safe change, `extension/background.js` only): create the
offscreen document lazily, immediately before the first `PLAY_CHUNK` is sent
(i.e. after the first chunk has been synthesized), so the 30 s clock starts
when audio is imminent. Also clear `active` on the offscreen-creation failure
path so a failed trigger can't leave the shortcut stuck in "stop" mode.
Nothing else changed; T8.1's warm-up and its recorded results are untouched.

Tests run (builder, 2026-10-16):
- `node --check extension/background.js` -> OK.
- `node --test extension/tests/chunker.test.js` -> **8/8 pass**.
- `python -m pytest -q` (from `server\`) -> **4 passed, 1 warning**.
- base64 round-trip against `scratch\cain-server-test.wav` (24 kHz mono) ->
  byte-identical, header `RIFF`/`WAVE`.

### Diagnostic (paste into the service-worker console: chrome://extensions -> service worker)

```js
// 1. which engine / is the server up?
console.log("health:", await (await fetch("http://127.0.0.1:8765/health")).json());

// 2. does the server return real audio? (takes ~20 s with Cain; a ~1 s tone = stub)
const r = await fetch("http://127.0.0.1:8765/tts", { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Stay awhile and listen.", speed: 1.0 }) });
const buf = await r.arrayBuffer();
console.log("tts:", r.status, r.headers.get("content-type"), buf.byteLength,
  String.fromCharCode(...new Uint8Array(buf.slice(0, 4))));

// 3. isolate offscreen playback (bypasses selection + chunking)
let b = new Uint8Array(buf), b64 = "";
for (let i = 0; i < b.length; i += 0x2000) b64 += String.fromCharCode.apply(null, b.subarray(i, i + 0x2000));
b64 = btoa(b64);
if (!(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length)
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "diag" });
await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" });
await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_CHUNK", index: 0, wav: b64 });
await chrome.runtime.sendMessage({ target: "offscreen", type: "DONE_SENDING" });
console.log("offscreen: listen now");

// 4. is the selection being read?
const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
console.log("selection:", await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION" }));
```

Reading the results: step 1 `engine:"stub"` = wrong server; step 2 non-200 or
non-`RIFF` = server error/invalid audio; step 3 silent while step 2 returned
valid Cain audio = playback/offscreen problem; step 4 empty while text is
selected = selection problem.

### Exact manual test to run next (user; GPU)

1. In `server\`: stop Ollama, then `$env:CAIN_ENGINE="cain"; .\run.ps1`.
2. `curl.exe -s localhost:8765/health` -> must show `"engine":"cain"`.
3. Reload the unpacked extension, then reload the test page.
4. Select one short sentence on an https page; press Ctrl+Shift+S.
5. Report whether the sentence plays in Cain's voice (first audio is expected
   ~20-25 s per T7.4), and whether pressing the shortcut again stops it.
6. If it does not play, paste the four diagnostic logs above.

## Repeat-playback failure (2nd read silent) — cause & fix (2026-10-16)

Symptom (user, live): `/health` = `engine:"cain"`; the first selected sentence
played in Cain's voice; a second read produced **no audio**. The server terminal
only showed `Setting pad_token_id to eos_token_id:2150 for open-end generation.`

Confirmed cause (code inspection): **stale `offscreenPromise` cache in
`background.js`.** `ensureOffscreen()` cached the `chrome.offscreen.createDocument()`
promise forever — it was cleared only on failure, never on success. Chrome
auto-closes an `AUDIO_PLAYBACK` offscreen document ~30 s after it goes silent
(platform fact already recorded in the previous section). Timeline:

- First read: no document -> `getContexts()` empty -> `createDocument()` -> the
  resolved promise is cached and never cleared -> audio plays.
- Playback ends; the document goes silent; **~30 s later Chrome closes it**.
- Second read: `getContexts()` now returns empty (document gone), but
  `offscreenPromise` is still a resolved promise, so `if (!offscreenPromise)`
  skips recreation. `await offscreenPromise` resolves against the dead document
  and `sendOffscreen(PLAY_CHUNK)` rejects (no receiver) and is swallowed by
  design -> **no audio and no toast**. The `/tts` request is still made (the lazy
  fix runs `ensureOffscreen` *after* the fetch), which is why the server logged
  generation activity: the WAV was produced but had nowhere to play.

This explains why only the second (not the first) read fails, and why stub tests
never caught it.

Fix (smallest targeted change, `extension/background.js` only): keep
`offscreenPromise` only while creation is in flight and clear it once it settles,
so `getContexts()` stays the source of truth and a closed document is recreated on
the next read. The earlier lazy-creation fix is preserved.

Regression test: **not feasible** with the current test setup — `background.js`
cannot be imported under `node --test` without adding `chrome.*` mock
infrastructure, which is out of scope (the suite covers pure functions only).
Verified with `node --check` and the existing suite instead.

Tests (builder, 2026-10-16):
- `node --check extension/background.js` -> OK.
- `node --test extension/tests/chunker.test.js` -> **8/8 pass**.

### Diagnostic if the 2nd read is still silent (service-worker console, BEFORE the 2nd attempt)

```js
console.log("contexts:", (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
console.log("active:", (await chrome.storage.session.get("active")).active);
```

`contexts: 0` = the offscreen document had already been closed (the case this fix
addresses). `active: true` before the attempt = the shortcut would toggle to stop
instead of reading (would mean `PLAYBACK_STATE` did not clear the flag).

### Next manual test (user; GPU)

Repeat the live test with a pause: read one sentence, wait more than 30 s, then
read a second sentence. The second read should now play. T8.2 stays unchecked
until this passes.

## Cain TTS latency — stage timing instrumentation (2026-10-16; log-only)

Approved minimal instrumentation to split the ~20 s/sentence latency into
stages. No behavior, response-format, or model-setting change; no new deps.
Files changed: `server/engines/cain.py`, `server/app.py`.

- `cain.py` `synthesize` times three stages with `time.perf_counter()`:
  `generate` (`model.generate`), `decode` (`speech_tokenizer.decode`), and
  `encode` (array conversion + optional time-stretch + PCM quantize + WAV
  write). `generate_voice_clone()` calls the first two internally, so they are
  wrapped transparently at engine init (`_instrument`); the enclosing
  `@torch.no_grad` still covers the wrapped calls. It also logs `model` = the
  whole `generate_voice_clone` call (≈ generate + decode + text tokenization).
- `app.py` `/tts` logs `request` = end-to-end handler time (includes the
  synthesis-lock wait), also on error.
- All output goes to **stderr only**; no text or request content is logged.
  Example lines:
  `cain timing: model=19.05s generate=18.21s decode=0.82s encode=0.03s`
  `tts timing: request=19.12s`

How to interpret:
- `generate` ≈ `decode` and both dominate → autoregressive talker/sub-talker
  is the bottleneck (a smaller model, e.g. 0.6B, is the lever).
- Large `model − (generate + decode)` → library/tokenization overhead.
- Large `request − model − encode` → FastAPI/threading/lock overhead.
- Large `encode` (only when speed ≠ 1.0) → `librosa` time-stretch cost.

Measure with (from `server\`, Cain server up, Ollama stopped):
`curl.exe -s -o NUL -w "%{time_total}" -X POST localhost:8765/tts -H "content-type: application/json" -d "@../scratch/body100.json"`
then read the two `timing:` lines printed in the server terminal.

Tests (builder, 2026-10-16): `python -m py_compile app.py engines\cain.py` → OK;
`python -m pytest -q` → 4 passed, 1 warning. Instrumentation only — T8.2 stays
unchecked; T8.1, lazy offscreen creation, and the repeat-playback fix are
untouched.

