# TTS Refactor Plan

Status: approved, executing.
Current task: 4 (not started).

Scope: stability, bug fixes and MV3 lifecycle correctness only. No new features,
no UI changes, no stylistic refactors. Working code is left alone.

## Tasks

- [x] **1. Replace the reserved keyboard shortcut**
  - Problem: `Ctrl+Shift+S` is now reserved by Chrome for screenshots, so the
    command no longer reaches the extension.
  - Change: bind `read-selection` to **`Alt+Shift+S`** for both `default` and
    `windows`. It keeps the "S" mnemonic, is not a Chrome reserved shortcut, and
    remains rebindable at `chrome://extensions/shortcuts`.
  - Files: `extension/manifest.json`; `README.md` (feature list, diagram,
    usage steps, troubleshooting row).
  - Historical records (`PRD.md`, `TASKS.md`, `NOTES.md`) keep the old binding
    and are not rewritten.
  - Verify: manifest parses; extension tests pass; after reloading the
    extension, `Alt+Shift+S` reads and toggles. Installs that already stored a
    custom binding may keep it until reset on `chrome://extensions/shortcuts`.

- [x] **2. Stop a read that never plays from leaving the active flag set**
  - Problem: `startReading` persists `active = true` before chunking. An empty
    or whitespace-only selection returns early without clearing it, and the
    offscreen-creation failure path clears it even when a newer run has already
    started. In either case the hotkey toggle believes a read is still running.
  - Change: clear the flag on the empty-selection return, and let only the run
    that still owns `runId` modify the flag.
  - Files: `extension/background.js`; `extension/tests/background.test.js`.
  - Verify: empty selection leaves `active` false; a superseded run cannot clear
    a newer run's flag; the existing suite still passes.

- [x] **3. Restore the persisted active flag before the hotkey decides to toggle**
  - Problem: the service worker is terminated during long playback. On wake,
    `restoreActive()` runs without being awaited, so a hotkey press can see
    `active = false` and start a new read instead of stopping the one playing.
  - Change: keep the restore promise and await it at the start of the command
    handler.
  - Files: `extension/background.js`; `extension/tests/background.test.js`.
  - Verify: a test where the persisted flag is `true` after a simulated worker
    restart stops playback instead of starting a read.

- [ ] **4. Recover when the offscreen player cannot start a chunk**
  - Problem: `Audio.play()` rejections and media error events are only logged.
    The item stays current, the queue never advances, no `PLAYBACK_STATE` is
    sent, and `active` stays true, so the extension reports a read that is no
    longer playing.
  - Change: on a play rejection or media error, drop the failed item and advance;
    when nothing remains, report idle. No retry loop.
  - Files: `extension/offscreen.js`; `extension/tests/offscreen.test.js`.
  - Verify: a rejecting play advances to the next item; a failing last item
    sends `PLAYBACK_STATE { playing: false }`; the existing suite still passes.

## Explicitly out of scope

- New UI, settings, voices, engines or permissions.
- Rewriting the chunker, the streaming protocol, the server, or tests that
  already pass.
- The documented iframe selection limitation (the context menu path covers it).
- The 29 stale venv launcher shims, which do not affect the extension.
