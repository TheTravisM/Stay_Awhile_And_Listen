# TASKS: Cain Reader

Build instructions for a **local Qwen 3.8 coding model** (49k context window). The user supervises every task.

## How to read this file (context is limited)

- Read `PRD.md` once at the start. After that, open only the PRD section a task names.
- Before each task, read the **Rules** below and **only the current task**. Don't re-read the whole file.
- Keep command output short: add `| Select-Object -Last 20` to anything noisy (`pip install`, `pytest`, builds).
- Keep `NOTES.md` short. For an error, paste only the last ~20 lines.
- After each task, report in at most 5 lines: files created or changed, the Verify result (last lines of output), and that the checkbox is ticked. Then stop and wait for the user to say "next".

## Rules for the builder (read every time)

1. **Do ONE task at a time, in order.** Don't start the next until the current task's **Verify** step passes. Tick the checkbox when done, then stop and wait for "next".
2. **Don't guess APIs.** For any Python package or Chrome API, check the installed version (`pip show X`) or write the smallest probe script first. If unsure, stop, write the question in `NOTES.md`, and ask the user.
3. **Vanilla JS only** for the extension (ES modules OK). No bundler, no framework, no npm runtime deps.
4. **Create only the files listed** in each task. Don't add features, options or abstractions that aren't asked for.
5. **Small files.** Each file does one thing. If a file passes ~150 lines, split it.
6. Match names exactly: port `8765`, host `127.0.0.1`, command `read-selection`, and the message types and `target` field defined at the top of Phase 5.
7. When a command fails, paste the last ~20 lines of the real error into `NOTES.md` and fix the cause. Don't retry the same command blindly. If the same Verify fails twice, stop and ask the user.
8. **No git commands. The user commits.** Never read, move, rename or delete anything in `voice-source\` or `server\voices\` (the user's audio). Never put audio or model weights in the project.
9. **Environment is Windows 10/11, PowerShell, VS Code terminal.** Don't use bash syntax, `afplay`, `/tmp`, `source`, `chmod`, `&&` chains, or `.sh` scripts. Use `curl.exe` (not `curl`, which is a PowerShell alias for something else). Put temp files in `scratch\`. Each terminal command may start in a different folder, so `Set-Location` first or use full paths.
10. **Python: always use the venv's tools directly.** Inside `server\`, run `.\.venv\Scripts\python.exe` (and `-m pip`, `-m pytest`, `-m uvicorn`). Never use bare `python` or `pip` there: the system Python is 3.14, which the TTS packages don't support. Verify lines below write `python` as shorthand for this. Activating the venv is not needed.
11. **Playing a WAV** (run from `server\`; works only for 16-bit PCM WAV):
    `(New-Object Media.SoundPlayer (Resolve-Path "..\scratch\file.wav").Path).PlaySync()`
12. **Steps marked (user) are done by the user.** They need Chrome, speakers, or the GPU. Tell the user exactly what to do, then stop and wait for their result. Never say a (user) step passed without seeing the user's output.
13. **GPU sharing.** The RTX 3090 (24 GB) can't hold Qwen (~21 GB) and the TTS model together. From Phase 7, steps marked **(user, GPU)** are run by the user with Ollama stopped (and the TTS server stopped before Qwen is resumed). The builder writes the code and the exact commands. The user runs them and pastes back the last ~20 lines.

## Target layout

Docs (`PRD.md`, `TASKS.md`) live one level above `cain-reader\`. Run commands from `cain-reader\server` unless a task says otherwise.

```
cain-reader/
  README.md  NOTES.md  .gitignore  .gitattributes
  scratch/              # temp files, gitignored
  voice-source/         # user's raw audio, gitignored, builder never touches
  server/
    requirements.txt
    app.py              # FastAPI: /health, /tts
    engines/
      __init__.py       # get_engine(name)
      base.py           # Engine protocol
      stub.py           # tone WAV, no model
      cain.py           # real voice-clone engine
    voices/             # cain.wav + cain.txt (user supplies; gitignored)
    tests/test_app.py
    run.ps1
  extension/
    package.json        # only {"type":"module"} so node can test ES modules
    manifest.json
    background.js
    chunker.js          # pure function, unit-tested
    cleaner.js          # pure function, unit-tested (Phase 10)
    content.js          # selection + toast
    offscreen.html
    offscreen.js        # audio queue/playback
    popup.html  popup.js  popup.css
    icons/ (16,48,128 png — simple generated placeholders)
    tests/chunker.test.js
    tests/cleaner.test.js
```

---

## Phase 0 — Setup

- [x] **T0.1 Project skeleton**
  Create the directories and empty files above, plus:
  - `.gitignore` containing: `.venv/`, `__pycache__/`, `scratch/`, `voice-source/`, `server/voices/*.wav`, `*.pt`, `*.safetensors`, `node_modules/`
  - `.gitattributes` containing: `* text=auto`
  - `extension/package.json` containing exactly: `{"type": "module"}`
  **Verify:** `Get-ChildItem -Recurse cain-reader` matches the layout.

- [x] **T0.2 Python env**
  In PowerShell:
  ```
  Set-Location cain-reader\server
  py -3.12 -m venv .venv
  .\.venv\Scripts\python.exe --version
  ```
  The version must be 3.12.x. If `py -3.12` isn't found, stop and ask the user to install Python 3.12.
  Put `fastapi`, `uvicorn`, `numpy`, `pytest`, `httpx` in `requirements.txt` (no pins yet). Run `.\.venv\Scripts\python.exe -m pip install -r requirements.txt | Select-Object -Last 20`.
  **Verify:** `.\.venv\Scripts\python.exe -c "import fastapi, uvicorn, numpy; print('ok')"` prints `ok`.

## Phase 1 — Server with a stub engine (no model yet)

- [x] **T1.1 Engine interface** — `engines/base.py`
  Define `class Engine(Protocol)` with `name: str` and `def synthesize(self, text: str, speed: float) -> bytes` (returns a complete WAV file as bytes).
  **Verify:** from `server\`, `python -c "from engines.base import Engine"` succeeds.

- [x] **T1.2 Stub engine** — `engines/stub.py`
  `StubEngine`: returns a mono 16-bit 22050 Hz WAV (use the stdlib `wave` + `numpy`). A 440 Hz sine tone lasting `0.05 s × len(text)`, capped at 10 s, faded in/out over 10 ms. `name = "stub"`. Ignore `speed`.
  **Verify:** write the bytes to `..\scratch\stub.wav`. **(user)** plays it with the Rule 11 command and confirms a tone is heard.

- [ ] **T1.3 Engine registry** — `engines/__init__.py`
  `get_engine(name: str) -> Engine`. Supports `"stub"` now. Raise `ValueError` for unknown names. Read the name from env `CAIN_ENGINE`, default `"stub"`.
  **Verify:** `python -c "from engines import get_engine; print(get_engine('stub').name)"` prints `stub`.

- [ ] **T1.4 FastAPI app** — `app.py`
  - `GET /health` → `{"ok": true, "engine": <name>, "voice": "cain"}`. It must never wait on the synthesis lock.
  - `POST /tts` with JSON `{"text": str (1–2000 chars), "speed": float 0.5–2.0, default 1.0}` → `Response(content=wav, media_type="audio/wav")`. Return 422 on empty text (pydantic validation). Return 500 with `{"error": "..."}` if the engine raises.
  - Define the `/tts` handler with plain `def` (not `async def`) so FastAPI runs it in a worker thread and `/health` stays responsive.
  - Wrap the `synthesize` call in one module-level `threading.Lock`, because the extension can have two requests in flight and the GPU model must not run two at once.
  - **Do not add CORS middleware.** The extension's service worker and popup have `host_permissions`, so they don't need it, and leaving it off stops web pages from calling the server.
  - Load the engine once at startup, not per request.
  **Verify:** create `..\scratch\body.json` containing `{"text":"Stay awhile and listen."}`. Start the server in a separate terminal (it blocks): `python -m uvicorn app:app --host 127.0.0.1 --port 8765`. Then from `server\`:
  ```
  curl.exe -s localhost:8765/health
  curl.exe -X POST localhost:8765/tts -H "content-type: application/json" -d "@../scratch/body.json" -o ../scratch/out.wav
  ```
  `/health` returns `ok:true` and `out.wav` starts with `RIFF`. **(user)** plays `out.wav` and confirms a tone.

- [ ] **T1.5 Server tests** — `tests/test_app.py`
  Using `fastapi.testclient.TestClient`: health returns ok; `/tts` returns 200, `audio/wav`, and bytes starting with `RIFF`; empty text returns 422.
  **Verify:** from `server\`, `python -m pytest -q` → all pass.

- [ ] **T1.6 Run script** — `run.ps1`
  Does `Set-Location $PSScriptRoot`, then runs `& "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8765`. No venv activation. It must work when launched from any directory. If PowerShell blocks the script, the user runs once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
  **Verify:** `.\run.ps1` starts and `curl.exe -s localhost:8765/health` responds.

## Phase 2 — Extension skeleton

- [ ] **T2.1 Manifest** — `extension/manifest.json`
  MV3. `name: "Cain Reader"`, `version: "0.1.0"`, `minimum_chrome_version: "116"`. Permissions: `contextMenus`, `storage`, `offscreen`, `activeTab`, `scripting`. `host_permissions: ["http://127.0.0.1:8765/*"]`. `background: {"service_worker": "background.js", "type": "module"}`. `action: {"default_popup": "popup.html"}`. `commands: {"read-selection": {"suggested_key": {"default": "Alt+Shift+C", "windows": "Alt+Shift+C"}, "description": "Read selected text aloud"}}`. `icons` 16/48/128.
  **Verify:** from `cain-reader\`, `.\server\.venv\Scripts\python.exe -m json.tool extension\manifest.json` succeeds.

- [ ] **T2.2 Placeholder icons**
  Generate three solid-colour PNGs (16/48/128) with a small Python script using only the stdlib (`zlib`+`struct`), or Pillow if installed. Save to `extension\icons\` as `icon16.png`, `icon48.png`, `icon128.png`. Delete the script afterwards.
  **Verify:** `Get-ChildItem extension\icons` shows the three files, each larger than 0 bytes, and the manifest `icons` paths match those names.

- [ ] **T2.3 Load check**
  Create a minimal `background.js` (`console.log('cain: up')`) and a minimal `popup.html`.
  **Verify (user):** in Chrome, `chrome://extensions` → Developer mode → Load unpacked → select the `extension` folder. The card shows no "Errors" button. The user reports the result.

## Phase 3 — Text handling (pure, testable)

- [ ] **T3.1 Chunker** — `extension/chunker.js`
  `export function chunkText(raw, {maxChars = 300, firstMaxChars = 120, cap = 5000} = {})` → `{chunks: string[], truncated: boolean}`.
  Rules, in order:
  1. Collapse all whitespace runs to a single space and trim. Empty → `{chunks: [], truncated: false}`.
  2. If longer than `cap`, cut at `cap` and set `truncated = true`.
  3. Split into sentences on `.`, `!`, `?`, `…` or newline, followed by whitespace, keeping the punctuation.
  4. Pack sentences greedily into chunks ≤ `maxChars`. The **first chunk** limit is `firstMaxChars`.
  5. Any single sentence longer than the limit is split at the last space before the limit (hard-cut if there's no space).
  **Verify:** Task T3.2 passes.

- [ ] **T3.2 Chunker tests** — `extension/tests/chunker.test.js`
  Use `node:test` + `node:assert`. Cases: empty/whitespace → `[]`; one short sentence → 1 chunk; first chunk ≤ 120 and the rest ≤ 300 on long text; a 400-char sentence with no punctuation is split into pieces ≤ the limit; 6000-char input → `truncated: true` and total length ≤ 5000; joined chunks contain no lost words.
  **Verify:** `node --test extension/tests/chunker.test.js` → all pass. (Naming the file avoids Windows directory-glob problems.)

## Phase 4 — Triggers and selection

- [ ] **T4.1 Content script** — `extension/content.js`
  Listens for `chrome.runtime.onMessage`:
  - `{type: "GET_SELECTION"}` → respond `{text: window.getSelection().toString()}`.
  - `{type: "TOAST", text, kind}` → show a fixed-position div (bottom-right, dark background, z-index max, auto-removes after 3 s). Use a Shadow DOM so page CSS can't interfere.
  Register it in the manifest via `content_scripts` on `<all_urls>` at `document_idle`.
  **Verify (user):** reload the extension and a page. The page's DevTools console shows no errors from the script.

- [ ] **T4.2 Trigger wiring** — `extension/background.js`
  - `chrome.runtime.onInstalled`: create the context menu `{id: "cain-read", title: "Read with Cain", contexts: ["selection"]}`.
  - `contextMenus.onClicked` → use `info.selectionText` → call `startReading(text, tabId)`.
  - `commands.onCommand("read-selection")` → get the active tab and send `GET_SELECTION` inside try/catch. Tabs opened before the extension loaded have no content script, so on failure fall back to `chrome.scripting.executeScript` returning `window.getSelection().toString()`. If that also fails (for example `chrome://` pages), log a warning and stop. If the text is empty, send a TOAST "Select some text first".
  - Stub `startReading` for now: `console.log(chunkText(text))`.
  **Verify (user):** select text, press Alt+Shift+C, and see the chunks logged in the service worker console (`chrome://extensions` → "service worker" link). If the shortcut does nothing, check `chrome://extensions/shortcuts` for a conflict.

## Phase 5 — Synthesis + playback

**Message types (use exactly):** `PLAY_CHUNK` (background → offscreen), `DONE_SENDING` (background → offscreen), `STOP` (popup or background → offscreen and background), `PLAYBACK_STATE` (offscreen → background), plus `GET_SELECTION` and `TOAST` from Phase 4. There is no `SET_RATE`.
**Every message carries `target`:** `"offscreen"` or `"background"`. A handler ignores any message not addressed to it.

- [ ] **T5.1 Offscreen document** — `offscreen.html` + `offscreen.js`
  `offscreen.js` holds a queue and an `Audio` element.
  - On `{target:"offscreen", type: "PLAY_CHUNK", index, wav: base64 string}`: decode to a Blob (`audio/wav`), `URL.createObjectURL`, push to the queue. Start playing if idle.
  - On `ended`: revoke the URL, play the next in the queue. When the queue is empty **and** `DONE_SENDING` has been received → send `PLAYBACK_STATE {playing:false}`.
  - On `STOP`: pause, clear the queue, revoke URLs, send `PLAYBACK_STATE {playing:false}`.
  **Verify (user):** from the service worker console, create the offscreen doc and send it a base64 WAV (the builder supplies a ready-to-paste snippet using the stub WAV). The user hears the tone and reports.

- [ ] **T5.2 Background pipeline** — `background.js`
  Implement `startReading(text, tabId)`:
  1. Stop any current read (abort via `AbortController`, send `STOP` to offscreen). Bump a `runId`. Set `active = true`.
  2. `chunkText(text)`. If empty, toast and return. If truncated, toast "Reading first 5,000 characters".
  3. `ensureOffscreen()`: if `chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})` is empty, call `chrome.offscreen.createDocument({url:"offscreen.html", reasons:["AUDIO_PLAYBACK"], justification:"Play synthesized speech"})`. Keep the creation promise so two reads can't create it twice.
  4. Fetch chunks **sequentially with one-chunk lookahead**: start chunk 0, and as soon as it resolves, send it to offscreen and start fetching chunk 1 (and so on). Keep at most 2 requests in flight. Stop early if `runId` changed.
  5. `fetch("http://127.0.0.1:8765/tts", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({text, speed}), signal})`. Convert the response to base64 (in slices, never the spread operator on a large array). Send to offscreen as `PLAY_CHUNK`.
  6. After the last chunk, send `DONE_SENDING`.
  7. On fetch failure: toast "Cain server offline — run server\run.ps1" (network error) or "TTS error" (HTTP ≥ 400), send `STOP` to offscreen, set `active = false`. Ignore `AbortError` (it comes from Stop).
  `speed` comes from `chrome.storage.sync` (default 1.0) and is applied by the **server**. Don't use `playbackRate`.
  **Verify (user):** with the stub server running, select a long paragraph on any https page and press Alt+Shift+C. Tones play in order and the first starts quickly. The user reports.

- [ ] **T5.3 Toggle + stop** — `background.js`
  Keep `active` (a read is in progress, from trigger until playback ends, stops, or errors) in `chrome.storage.session`, so it survives the service worker sleeping. Set it false on `PLAYBACK_STATE {playing:false}`. The command handler: if `active` → `stopReading()`, otherwise read. `stopReading()` aborts requests, bumps `runId`, sends `STOP` to offscreen and sets `active = false`. `STOP` messages from the popup call `stopReading()`.
  **Verify (user):** press the shortcut during playback and audio stops in under 0.5 s with no more chunks fetched (the server log shows no further requests).

## Phase 6 — Popup

- [ ] **T6.1 Popup UI** — `popup.html`, `popup.js`, `popup.css`
  Elements: title "Cain Reader"; a status dot + text (green "Server online (<engine>)" / red "Server offline"); a speed slider 0.8–1.4 step 0.05 with a value label; a **Stop** button.
  - On open, `fetch /health` (2 s timeout) to set the dot.
  - Speed is saved to `chrome.storage.sync` as `speed` on `input`.
  - Stop sends `{target:"background", type:"STOP"}`.
  Fixed width 260px, no external fonts/CDNs.
  **Verify (user):** open the popup with the server on → green. Kill the server and reopen → red. Moving the slider and reopening keeps the value.

## Phase 7 — Real voice (GPU steps: see Rule 13)

- [ ] **T7.1 Voice assets (user action — builder: stop and ask)**
  Confirm `server\voices\cain.wav` (10–30 s, mono, ≥16 kHz) and `cain.txt` (exact transcript) exist. Check only that the two files are there. If not, write "WAITING ON USER: reference clip" in `NOTES.md` and **don't proceed to T7.2**.
  **Verify (user):** `Get-ChildItem server\voices` shows both, and the clip plays clean using the Rule 11 command.

- [ ] **T7.2 Engine probe**
  The builder has no web access, so before installing, stop and ask the user for two things: (a) the exact PyTorch install command from the pytorch.org selector (Windows, Pip, Python 3.12, CUDA), and (b) the usage / voice-clone section of the Qwen3-TTS README pasted into `NOTES.md` (just that section, to save context). Don't guess either.
  Then, with `| Select-Object -Last 20` on every install: install PyTorch, then the primary engine per its README (**Qwen3-TTS voice-clone**, see PRD §8). Write a throwaway `server\probe_tts.py` (not part of the final tree) that generates one sentence using `cain.wav` + `cain.txt` to `..\scratch\probe.wav` and prints the elapsed seconds and device.
  **Verify (user, GPU):** the user stops Ollama, runs `python probe_tts.py` from `server\`, plays `probe.wav`, and pastes the output. Record in `NOTES.md`: package name, version, device (CUDA/CPU), seconds for a ~15-word sentence, and the exact API call that worked.
  Installs on Windows can fail (missing C++ build tools, unsupported Python version). If the install fails or generation is slower than 8 s per sentence, record the last ~20 lines of the error and repeat with **XTTS-v2**, then **F5-TTS**. The result must be intelligible speech in a voice resembling the reference.

- [ ] **T7.3 Cain engine** — `engines/cain.py`
  Implement `CainEngine(Engine)` using the API proven in T7.2. Load the model **once** in `__init__`. `synthesize` runs the model with the cached reference, maps `speed` to the model's rate parameter (or time-stretches if there's none), and returns **16-bit PCM mono WAV bytes** (convert float output if needed). Add `"cain"` to `get_engine`. Add the new deps to `requirements.txt`.
  **Verify (user, GPU):** with Ollama stopped, from `server\`: `$env:CAIN_ENGINE="cain"; .\run.ps1`. In a second terminal, run the `/tts` curl from T1.4 and play the result. `curl.exe -s localhost:8765/health` shows `"engine":"cain"`. Stop the server before resuming Qwen.

- [ ] **T7.4 Latency check**
  The builder creates `..\scratch\body100.json` (a ~100-char sentence) and `..\scratch\body300.json` (~300 chars), and writes out these commands for the user:
  `curl.exe -s -o NUL -w "%{time_total}" -X POST localhost:8765/tts -H "content-type: application/json" -d "@../scratch/body100.json"` (and the same for `body300.json`).
  **Verify (user, GPU):** the user runs them with the Cain server up and pastes the times. Record them in `NOTES.md`. If the 100-char time is > 3 s, lower `firstMaxChars` in `chunker.js` to 80 and re-run `node --test extension/tests/chunker.test.js`. The first-chunk time is ≤ 3 s, or the NOTES entry explains the gap.

## Phase 8 — Hardening

- [ ] **T8.1 Server keep-warm**
  On startup, the Cain engine synthesizes one throwaway short sentence so the first real request isn't slow.
  **Verify (user, GPU):** the first `/tts` after a restart takes within 1.5× the time of the second.

- [ ] **T8.2 Edge cases (manual checklist; fix anything failing)**
  - Select nothing + shortcut → toast "Select some text first".
  - Server off → offline toast; no console error loops.
  - 6,000-char selection → truncation toast; plays 5,000 chars; the service worker stays alive to the end. If it dies partway, move the fetch loop from `background.js` into `offscreen.js` (extension pages can fetch the server too).
  - Trigger again mid-read → the old read stops, the new one starts, no overlapping audio.
  - Text with emoji, quotes and newlines → no 422 or crash. If something breaks, make the smallest fix in `chunkText`. Full cleanup comes in Phase 10.
  - A page inside an iframe or `chrome://` → the context-menu path still works with `info.selectionText`, and the shortcut logs a warning rather than throwing.
  **Verify (user):** each line checked off in `NOTES.md`.

## Phase 9 — Docs

- [ ] **T9.1 README.md**
  Sections: What it is; Requirements (Windows 10/11, Python 3.12, Chrome, optional NVIDIA GPU); Setup (venv, install, put `cain.wav`/`cain.txt` in `server\voices\`); Run the server (`.\run.ps1`); Load the extension (steps from T2.3); Usage (context menu, Alt+Shift+C, popup); Offline use (the model downloads once; afterwards set `HF_HUB_OFFLINE=1` before running the server); Troubleshooting (offline toast, no audio, slow first sentence, PowerShell execution policy, shortcut conflicts); Legal note: personal use, bring your own reference clip, no Blizzard audio is shipped.
  **Verify:** a fresh reader can follow it from a clean checkout to hearing audio.

## Phase 10 — Text cleanup (after v1 passes final acceptance)

- [ ] **T10.1 Cleaner** — `extension/cleaner.js`, `extension/tests/cleaner.test.js`
  `export function cleanText(raw)` → string. Pure function, no other imports. Apply in order:
  1. Remove URLs (`https?://\S+`, `www.\S+`).
  2. Remove citation markers like `[12]`, `[1,2]`, `[a]`.
  3. Remove markdown symbols: leading `#`, `*`, `_`, backticks, `>` and `-`/`*` list bullets. Keep the words.
  4. Replace emoji and control characters with a space.
  5. Expand a short fixed list of abbreviations: `e.g.` → `for example`, `i.e.` → `that is`, `etc.` → `et cetera`, `vs.` → `versus`.
  6. Collapse whitespace and trim.
  Don't change any other text. Tests (`node:test`): each rule above has one case, and plain text passes through unchanged.
  **Verify:** `node --test extension/tests/cleaner.test.js` → all pass.

- [ ] **T10.2 Wire it in** — `extension/background.js`
  In `startReading`, call `cleanText(text)` **before** `chunkText`. If the result is empty, toast "Nothing to read" and return.
  **Verify (user):** select text containing a URL and `[3]` on a page and press Alt+Shift+C. The URL and citation aren't spoken.

---

## Final acceptance (all must be true — see PRD §10)

- [ ] `python -m pytest -q` passes (server, run from `server\`).
- [ ] `node --test extension/tests/chunker.test.js` passes.
- [ ] Extension loads with zero errors. (user)
- [ ] Select → Alt+Shift+C → Cain's voice within ~3 s, in order, on an https page. (user)
- [ ] Shortcut again stops in < 0.5 s. (user)
- [ ] Offline server → toast + red popup dot. (user)
- [ ] 5,000-char read completes. (user)
- [ ] With Wi-Fi off and `HF_HUB_OFFLINE=1`, a read still works. (user)

## Stretch (only after all of the above; ask the user first)

- [ ] **S1 "Cain-ify" toggle:** a popup checkbox. When on, `background.js` POSTs the text to the local Qwen 3.8 OpenAI-compatible endpoint (URL in the popup settings) with the system prompt "Lightly rephrase in the warm, archaic voice of Deckard Cain. Keep all facts. Return only the text." Falls back to the original text on any error.