# PRD: Cain Reader — Chrome Extension

Highlight text on any web page and hear it read aloud in the voice of Deckard Cain (Diablo). All speech is generated locally. No cloud services.

## 1. Assumptions (correct me if wrong)

- "Kane" = **Deckard Cain**, the Horadrim sage ("Stay awhile and listen...").
- **Qwen 3.8 is the builder**, a local coding model that writes this project from `TASKS.md`. It is not the voice engine, because an LLM cannot produce audio.
- The voice comes from a **separate local TTS model with voice cloning**, run by a small local server.
- Platform: **Windows 10/11**, PowerShell, Chrome (Manifest V3). The TTS server runs on the same machine at `127.0.0.1`. An NVIDIA GPU (CUDA) is preferred but not required; CPU works if it meets the latency target.
- **Voice source:** the user supplies their own short reference clip (`server/voices/cain.wav`, 10–30 s, clean, no music). The project ships **no Blizzard audio**. The voice is for personal, local use only. Don't redistribute the clip or publish the extension with the voice bundled.

## 2. Problem and goal

Reading long web text is tedious and the default browser TTS is robotic. The goal is a one-gesture "read this to me" experience with a distinctive, characterful voice, fully offline.

**Success =** select text, press a shortcut or right-click, and Cain starts speaking within ~3 s of the first sentence. Playback can be stopped at any time.

## 3. Users and use cases

Single user (the author), on their own Windows PC.
1. Select a paragraph, right-click, **Read with Cain**.
2. Select text, press **Alt+Shift+C**, and it reads.
3. Press the same shortcut again, or click Stop in the popup, and it stops.
4. Open the popup to see server status, change speed, and stop playback.

## 4. Scope

### In scope (v1)
- MV3 extension: content script, service worker, offscreen audio document, popup.
- Triggers: context menu item and keyboard command.
- Sentence-chunked synthesis with prefetch, so audio starts fast and long text works.
- Local Python server (FastAPI) with `/health` and `/tts`.
- Pluggable TTS engine behind one interface. Primary is a voice-cloning model, with a stub engine for tests.
- Popup: server status dot, speed slider (0.8–1.4), Stop button.
- Clear error states (server offline, empty selection, engine failure).

### Out of scope (v1)
- Cloud TTS, accounts, telemetry.
- Chrome Web Store publishing, Firefox/Safari, macOS/Linux support.
- Reading whole pages, PDFs, or text inside iframes you can't script.
- Multiple voices, voice-training UI.
- LLM rewriting into "Cain-speak" (see §9, optional stretch).

## 5. Functional requirements

| ID | Requirement |
|----|-------------|
| F1 | Context menu "Read with Cain" appears only when text is selected. |
| F2 | Command `read-selection` (default Alt+Shift+C) reads the current selection. If audio is already playing, it stops instead (toggle). |
| F3 | Selected text is trimmed, whitespace-collapsed, and capped at 5,000 chars (extra is dropped, with a toast saying so). |
| F4 | Text is split into sentence chunks of ≤ 300 chars. |
| F5 | Chunks are requested from the server in order. Chunk N+1 is prefetched while chunk N plays. |
| F6 | Audio plays gaplessly in order through an offscreen document. |
| F7 | Stop halts playback, aborts in-flight requests, and clears the queue. |
| F8 | Starting a new read while one is active replaces it. |
| F9 | Popup shows server reachability (polls `/health`) and has a speed control and a Stop button. Settings persist in `chrome.storage.sync`. |
| F10 | Errors surface as a small on-page toast (content script) and never fail silently. |

## 6. Non-functional requirements

- **Latency:** first audio ≤ 3 s after trigger for a 1-sentence chunk, on the user's PC.
- **Privacy:** the extension only talks to `http://127.0.0.1:8765`. No other network calls. Selected text never leaves the machine.
- **Permissions (minimum):** `contextMenus`, `storage`, `offscreen`, `activeTab`, `scripting`; `host_permissions`: `http://127.0.0.1:8765/*`.
- **Reliability:** the server restarts without breaking the extension. The next trigger just works.
- **Simplicity:** vanilla JS, no bundler, no framework, no npm dependencies for the extension.

## 7. Architecture

```
 Web page ──(selection)── content.js ──┐
                                       │ chrome.runtime messages
 context menu / shortcut ──► background.js (service worker)
                               │  split text → chunks
                               │  fetch POST /tts (host_permission, avoids mixed-content/CORS)
                               ▼
                       offscreen.html/js  ── plays WAV blobs in order (Audio element)
                               ▲
 popup.html/js ── status, speed, stop ─┘

 Local server (Python, FastAPI) @ 127.0.0.1:8765
   GET  /health  → {"ok":true,"engine":"<name>","voice":"cain"}
   POST /tts     → body {"text":str,"speed":float} → audio/wav
   engine interface: synthesize(text:str, speed:float) -> bytes (WAV)
```

Key decisions:
- **Fetch in the service worker, not the content script.** HTTPS pages block requests to `http://localhost` (mixed content). The service worker with `host_permissions` is exempt.
- **Playback in an offscreen document.** MV3 service workers can't play audio and are killed when idle.
- **Server returns one WAV per chunk.** This is simple, stateless, and easy to test. No streaming protocol in v1.
- **Engine behind an interface.** The stub engine (tone/silence) lets the whole extension be built and tested before any model is installed.

## 8. TTS engine

Primary: a local open-weights **voice-cloning TTS** conditioned on `server/voices/cain.wav` plus its transcript (`cain.txt`).
- First choice: **Qwen3-TTS** (voice-clone mode).
- Fallback if it won't run on this hardware or won't install on Windows: **XTTS-v2** or **F5-TTS**.

The builder must **verify the real package name and API at build time** (`pip show`, read the model card or README) and not guess from memory. If the primary engine isn't installable, implement the fallback behind the same interface and note it in `README.md`.

Windows notes: installs can fail on missing C++ build tools or an unsupported Python version. If the PC has an NVIDIA GPU, install the CUDA build of PyTorch first. Record any install error in `NOTES.md` before moving to the fallback.

Voice quality is judged by ear by the user. There is no automated test for "sounds like Cain".

## 9. Optional stretch (not v1)

Toggle "Cain-ify": send the text to the local Qwen 3.8 LLM endpoint with a prompt to lightly rephrase it in Cain's archaic, warm sage voice before speaking. Off by default, because it changes the meaning of what's read.

## 10. Acceptance criteria (v1 done when)

All commands are PowerShell. Use `curl.exe`, not `curl`.

1. `curl.exe -s localhost:8765/health` returns `ok:true`.
2. With `scratch/body.json` containing `{"text":"Stay awhile and listen."}`, this produces a playable WAV:
   `curl.exe -X POST localhost:8765/tts -H "content-type: application/json" -d "@scratch/body.json" -o scratch/out.wav`
3. Extension loads unpacked in Chrome with zero errors on `chrome://extensions`.
4. On a normal HTTPS page, selecting a paragraph and pressing Alt+Shift+C plays it in order, with first audio ≤ 3 s.
5. Pressing the shortcut again stops audio within 0.5 s.
6. With the server stopped, a trigger shows an "offline" toast and the popup dot is red.
7. A 5,000-char selection plays fully without the service worker dying mid-read.
8. `pytest` passes for the server. The extension's pure functions (chunker) pass `node --test extension/tests/chunker.test.js`.

## 11. Risks

| Risk | Mitigation |
|------|------------|
| Service worker sleeps mid-read | Keep playback and queue state in the offscreen doc, and keep the worker's job short-lived per message. |
| TTS too slow for the first chunk | Make the first chunk short (≤ 120 chars), prefetch the rest. |
| Voice clone sounds poor | A clean reference clip matters most. Try 10–30 s, and provide the transcript. |
| IP / licensing of the voice | Personal use, user-supplied clip, nothing bundled (see §1). |
| Local builder model drifts | `TASKS.md` is atomic, with a verify step per task. |
| TTS install fails on Windows | Log the error in `NOTES.md`, then use the fallback engines in §8. |
| Slow synthesis on CPU only | Use CUDA if available; otherwise shorten the first chunk (T7.4). |
| Shortcut conflicts with another app or extension | Check `chrome://extensions/shortcuts` and rebind if needed. |
