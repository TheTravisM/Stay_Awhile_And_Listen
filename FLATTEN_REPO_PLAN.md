# Flatten repo — revised plan (move `cain-reader\*` up to the repo root)

Repo root: `C:\GitRepo\Stay_Awhile_And_Listen` (git repo, branch `master`, remote `TheTravisM/Stay_Awhile_And_Listen`)
Goal: move **everything** inside `cain-reader\` up one level, delete the empty `cain-reader\`, keep git history, and leave the only other change being **path references** in the docs/code listed in Step W8.

Verified state this plan is built on (read-only checks, 2026-10-18):

| Fact | Value |
|---|---|
| Working tree | **clean** at `59ddc8a` ("update") — nothing uncommitted, so no checkpoint commit is needed |
| Tracked files | 38 total: `PRD.md`, `TASKS.md` at root + **36 under `cain-reader/`** |
| `cain-reader\` children | `extension\`, `server\`, `scratch\`, `voice-source\`, `.gitattributes`, `.gitignore`, `README.md` (0 B), `NOTES.md`, `TASKS_QWEN_STREAMING.md`, `diablo-icon-02.png` |
| Nested git repo | none — `cain-reader\.git` does not exist |
| Name collisions | none (root has only `PRD.md`, `TASKS.md`, `.git`) |
| Untracked-but-ignored, moves with it | `server\.venv\` (~3.6 GB), `server\__pycache__\`, `server\engines\__pycache__\`, `server\tests\__pycache__\`, `server\.pytest_cache\`, `server\voices\cain.wav`, `scratch\` (1 MB), `voice-source\` (5.6 MB) |
| Volume | everything is on `C:` → the move is a metadata rename, not a copy (instant, no 3.7 GB churn) |
| `server\run.ps1` | uses `$PSScriptRoot` → **no edit needed** |
| `extension\*` + `manifest.json` | no `cain-reader` path references → **no edit needed** |
| Files containing the string `cain-reader` | `TASKS.md` (9 hits), `cain-reader\TASKS_QWEN_STREAMING.md` (5 hits), `cain-reader\server\engines\cain_streaming.py` (1 docstring) — see W8 |
| `TASKS.md` line endings | index LF / worktree CRLF (currently tolerated). `.gitattributes` = `* text=auto` moving to the root is the only reason this could show up as a change — W6 checks it |

## What I changed from the original plan, and why

1. **Do not delete `server\.venv` (original Step 4) and do not rebuild it (original Step 7).** Rebuilding means re-downloading the multi-GB torch/transformers stack for nothing. On a same-volume move, `Scripts\python.exe` keeps working (it finds `pyvenv.cfg` next to it). Only the small `*.exe` console-script launchers (`pip.exe`, `pytest.exe`, `uvicorn.exe`, …) embed the old absolute path and will fail with `Fatal error in launcher`. Every command in your docs uses `python.exe -m …`, which keeps working. W10 verifies this and gives a no-download repair if you want the `.exe` launchers back.
2. **Added a process/lock pre-flight (W3).** A running uvicorn (holding `.venv` DLLs) or a terminal whose `cwd` is inside `cain-reader\` makes the move fail halfway. Checking port 8765 first is one command.
3. **Added a before/after inventory (W4 + W6).** Git can only prove the 36 tracked files moved; the 3.7 GB / ~45k-file ignored tree needs an independent count, otherwise a partial move is invisible.
4. **Replaced `Move-Item` with explicit destinations + `[System.IO.File/Directory]::Move`.** `Move-Item` silently moves *inside* an existing same-named destination folder instead of failing — a nesting trap. The new script hard-stops if a destination exists.
5. **Made the move one atomic script with a log**, instead of 10 hand-typed steps (see "How to run"). Everything else stays step-by-step.
6. **Fixed the original Step 3 collision check.** `Get-ChildItem -Exclude` / `Compare-Object -Include` behave subtly differently than intended; W2 uses an explicit case-insensitive name comparison (Windows path collisions are case-insensitive).
7. **Added the missing rollback recipe (appendix B)** that avoids `git reset --hard` / `git clean`.
8. **Added a post-move ignore re-verification (W6).** `.gitignore` changes scope when it moves to the root; if a rule silently stopped matching, the very next `git add -A` would try to commit 3.7 GB.
9. **Rewrote the reference sweep (W8) as a classified table.** The original Step 6 `Select-String` would also hit *historical records* ("Verify result (recorded …)") and this plan file — those must **not** be rewritten. Also: never blanket-replace the string `cain-reader` (e.g. the extension's display name "Cain Reader" is unrelated).
10. **Added the `.gitattributes` side-effect check (W6)** for `TASKS.md` (CRLF worktree) so a cosmetic line-ending diff isn't mistaken for a real change.
11. **Added the manual Chrome step** (remove + re-add the unpacked extension; its registered path no longer exists) and kept the original `git log --follow` history proof.
12. Dropped the original Step 2 checkpoint commit as unnecessary (**tree is already clean**); kept it as a conditional in W1 plus recording HEAD for rollback.

---

## How to run this

- Steps **W0–W4, W6, W10, W11** are read-only or verification: run them one at a time and compare against the "Expect" line.
- Step **W5 (the move)** is deliberately a single scripted transaction — a log plus a hard stop on the first problem. Do **not** hand-move the ten items one at a time: a half-finished manual move is the only realistic way to make a mess here.
- W8 (reference sweep) is a separate commit after the move, so the move commit stays a pure rename.
- If any step's output differs from "Expect": stop and report; don't improvise.
- Banned throughout: `git reset --hard`, `git clean`, `git checkout .`, and deleting anything not listed here.

---

## W0 — Sanity: current location, HEAD, and scope  *(read-only)*
```powershell
Set-Location C:\GitRepo\Stay_Awhile_And_Listen
git rev-parse HEAD                       # record this SHA: the rollback anchor
git status --short                       # Expect: no output (clean)
Get-ChildItem -Force | Select-Object Mode, Name
Get-ChildItem -Force .\cain-reader | Select-Object Mode, Name
Test-Path .\cain-reader\.git             # Expect: False
```
**Expect** root = `.git`, `cain-reader`, `PRD.md`, `TASKS.md`; `cain-reader\` = the 10 items in the table above. Write down the HEAD SHA from the first command.

- [x] W0 done, HEAD recorded = `59ddc8a` (recorded before the move)

## W1 — (conditional) commit this plan file
The tree is clean, so there is nothing to checkpoint. This plan file is the only untracked addition; committing it now keeps W7 a pure-rename commit.
```powershell
git add FLATTEN_REPO_PLAN.md
git commit -m "Add revised flatten plan"
git status --short                       # Expect: no output
```
*Skip if you'd rather keep the plan out of git.*

- [x] W1 done (user commit ceed777)

## W2 — Collision check (case-insensitive, excluding `.git`)  *(read-only)*
```powershell
$a = (Get-ChildItem -Force . | Where-Object Name -notin @('.git','cain-reader')).Name
$b = (Get-ChildItem -Force .\cain-reader).Name
Compare-Object $a $b -IncludeEqual -ExcludeDifferent
```
**Expect:** no output (no name exists in both places). If anything prints, **stop** and decide how to merge those names first. (Also confirm none of the inner names differ only by case from `.git`/`cain-reader`.)

- [x] W2 done (no collisions, case-insensitive check clean)

## W3 — Stop anything holding the files (do this before W5)
```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue   # Expect: nothing (server stopped)
Get-Process python, chrome -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Path
```
- Stop the Cain/uvicorn server if it is running (close its terminal, or `Stop-Process -Id <pid>`).
- Close any terminal / editor whose current folder is inside `cain-reader\` (including `cain-reader\server`).
- In Chrome you can leave the extension loaded; it will simply fail to load after the move until W10 re-adds it.
**Expect:** no listener on 8765 and no `python.exe` running from `…\cain-reader\server\.venv\`.

- [x] W3 done (4 leftover `uvicorn app:app` processes stopped; one had cwd = `cain-reader\server` - that blocked W5's first attempt, which was rolled back cleanly)

## W4 — Pre-move inventory  *(read-only)*
Writes a per-item file count + byte total to temp, so W6 can prove nothing was lost. PowerShell's recursion can silently skip >260-char paths; the robocopy `/L` variant in appendix A is the long-path-safe fallback if you see errors.
```powershell
$root = "C:\GitRepo\Stay_Awhile_And_Listen"
$tmp  = "C:\Users\travi\AppData\Local\Temp\opencode"
$names = (Get-ChildItem -Force -LiteralPath "$root\cain-reader").Name | Sort-Object
$names | Set-Content "$tmp\flatten_items.txt"          # the 10 item names, reused in W5/W6
$inv = foreach ($n in $names) {
  $p = Join-Path "$root\cain-reader" $n
  if ((Get-Item -LiteralPath $p -Force).PSIsContainer) {
    $f = Get-ChildItem -LiteralPath $p -Recurse -File -Force
    [pscustomobject]@{ Name = $n; Files = $f.Count; MB = [math]::Round((($f | Measure-Object Length -Sum).Sum / 1MB), 1) }
  } else {
    [pscustomobject]@{ Name = $n; Files = 1; MB = [math]::Round(((Get-Item -LiteralPath $p).Length / 1MB), 3) }
  }
}
$inv | Format-Table -AutoSize | Tee-Object "$tmp\flatten_inventory_before.txt"
```
**Expect** roughly: `server` ≈ 45,700 files / ≈ 3,765 MB, `voice-source` 3 files / 5.6 MB, `scratch` 13 files / 1 MB, `extension` 17 files / 0.1 MB, the 6 loose files 1 file each. Keep the printed table.

- [x] W4 done, inventory saved

## W5 — THE MOVE (one script: hard-stops on the first problem, logs every item)
```powershell
$root = "C:\GitRepo\Stay_Awhile_And_Listen"
$src  = Join-Path $root "cain-reader"
$log  = "C:\Users\travi\AppData\Local\Temp\opencode\flatten_move_log.txt"
Remove-Item $log -ErrorAction SilentlyContinue

$items = Get-ChildItem -Force -LiteralPath $src
foreach ($i in $items) {
  $dest = Join-Path $root $i.Name
  if (Test-Path -LiteralPath $dest) { throw "STOP: destination already exists: $dest" }
  if ($i.PSIsContainer) { [System.IO.Directory]::Move($i.FullName, $dest) }
  else                  { [System.IO.File]::Move($i.FullName, $dest) }
  "moved: $($i.Name)" | Tee-Object -FilePath $log -Append
}

$left = Get-ChildItem -Force -LiteralPath $src
if ($left.Count -eq 0) { Remove-Item -LiteralPath $src; "cain-reader removed" }
else { "cain-reader is NOT empty - left in place:"; $left | Select-Object Name }
```
**Notes**
- Same volume ⇒ each item is a rename; the 3.6 GB `.venv` moves in well under a second.
- If it throws, the log lists exactly what already moved; delete only the moved items from the log's perspective and re-run — the script is re-runnable (it only ever sees what is still inside `cain-reader\`).
- Files move as-is: **no content change, no line-ending change** at this step.

**Expect:** 10 `moved: …` lines, then `cain-reader removed`. If it stops early, report and stop.

- [x] W5 done (10/10 items moved, `cain-reader\` removed)

## W6 — Post-move verification  *(before any commit)*
```powershell
Set-Location C:\GitRepo\Stay_Awhile_And_Listen
Test-Path .\cain-reader                       # Expect: False

# 1. inventory must match W4 exactly
$tmp   = "C:\Users\travi\AppData\Local\Temp\opencode"
$names = Get-Content "$tmp\flatten_items.txt"
$inv = foreach ($n in $names) {
  $p = ".\$n"
  if ((Get-Item -LiteralPath $p -Force).PSIsContainer) {
    $f = Get-ChildItem -LiteralPath $p -Recurse -File -Force
    [pscustomobject]@{ Name = $n; Files = $f.Count; MB = [math]::Round((($f | Measure-Object Length -Sum).Sum / 1MB), 1) }
  } else {
    [pscustomobject]@{ Name = $n; Files = 1; MB = [math]::Round(((Get-Item -LiteralPath $p).Length / 1MB), 3) }
  }
}
$inv | Format-Table -AutoSize | Tee-Object "$tmp\flatten_inventory_after.txt"
Compare-Object (Get-Content "$tmp\flatten_inventory_before.txt") (Get-Content "$tmp\flatten_inventory_after.txt")
```
**Expect:** files/bytes identical to W4 for all 10 items (only the file *paths* in the headers differ, so `Compare-Object` may show the two title lines — confirm the numbers match).

```powershell
# 2. git must see renames, nothing else
git add -A
git status --short
git diff --cached --name-status -M | Select-Object -First 50
```
**Expect:** 36 rename lines (`R100 cain-reader/... -> ...`), i.e. every line starts with `R100`. **No** `A`/`D`/`M` lines, and **no** untracked entries such as `server/voices/…wav`, `voice-source/`, `scratch/`, `.venv/`.
If you see `M TASKS.md` → that is the moved `.gitattributes` (`* text=auto`) renormalizing a CRLF worktree file; confirm it is only line endings (`git diff --cached -- TASKS.md`) and say so before committing.

```powershell
# 3. ignore rules still work from the new root
git status --ignored --short | Select-Object -First 20
```
**Expect** the same 8 ignored entries as before, now without the `cain-reader/` prefix: `scratch/`, `server/.pytest_cache/`, `server/.venv/`, `server/__pycache__/`, `server/engines/__pycache__/`, `server/tests/__pycache__/`, `server/voices/cain.wav`, `voice-source/`.
If any heavy folder is **not** shown as ignored, **stop** — `git restore --staged .` and fix `.gitignore` before committing.

- [x] W6 done, inventory identical (10/10 MATCH), 36 x R100 renames + the new plan file, 8 ignored entries intact, no `M TASKS.md`

## W7 — Commit the move (pure rename)
```powershell
git commit -m "Flatten repo: move cain-reader contents to the root (pure rename)"
git status --short          # Expect: no output
git show --stat --oneline HEAD | Select-Object -First 12
```
- [x] W7 done (user commit 12c7d6f - pure rename, 36 x R100)

## W8 — Fix path references (separate commit; reviewed, not blanket-replaced)
Re-run the search after the move, then edit **only** the "current instruction / command / code" hits. The hits found at plan time:
```powershell
Get-ChildItem -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '\\(\.git|\.venv|node_modules|__pycache__|\.pytest_cache|voice-source|scratch)\\' -and
                 $_.Extension -in @('.md','.ps1','.json','.js','.py','.txt','.html','.css','.yml','.cfg','.toml','') } |
  Select-String -Pattern 'cain-reader' -SimpleMatch |
  ForEach-Object { "{0}:{1}: {2}" -f ($_.Path -replace [regex]::Escape((Get-Location).Path + '\'), ''), $_.LineNumber, $_.Line.Trim() }
```

| File | Line(s) | Change |
|---|---|---|
| `TASKS.md` | 32 | "Docs … one level above `cain-reader\`" → "Docs and the project share the repo root"; run commands from `server\` |
| `TASKS.md` | 34–63 | re-draw the target-layout tree rooted at the repo root (no `cain-reader/` level) |
| `TASKS.md` | 74 | `Get-ChildItem -Recurse cain-reader` → `Get-ChildItem -Recurse .\extension, .\server` (or equivalent) |
| `TASKS.md` | 79 | `Set-Location cain-reader\server` → `Set-Location server` |
| `TASKS.md` | 127 | "from `cain-reader\`" → "from the repo root" |
| `TASKS.md` | ~218–246 | **leave untouched** — recorded "Verify result (recorded …)" history |
| `TASKS_QWEN_STREAMING.md` | 20, 21 | drop the `cain-reader\` prefix from the two rule paths |
| `TASKS_QWEN_STREAMING.md` | 28 | "Production project: `…\cain-reader\`" → `…\Stay_Awhile_And_Listen\` |
| `TASKS_QWEN_STREAMING.md` | 83 | `cain-reader/server/...` → `server/...` |
| `TASKS_QWEN_STREAMING.md` | 143 | "from `cain-reader\server`" → "from `server`" |
| `TASKS_QWEN_STREAMING.md` | recorded T12/T13 results | **leave untouched** |
| `server\engines\cain_streaming.py` | 34 | docstring `` `cain-reader/server/.venv` `` → `` `server/.venv` `` |
| `FLATTEN_REPO_PLAN.md` | all | **leave untouched** (it names `cain-reader\` as the move source) |
| `PRD.md`, `NOTES.md`, `README.md`, `extension\*`, `manifest.json`, `run.ps1`, `.gitignore` | — | no hits; no change |
| **anywhere** | — | never blanket-replace `cain-reader`: the extension's display name "Cain Reader" is unrelated |

Optional and recommended: add one line at the top of `TASKS_QWEN_STREAMING.md` (and `NOTES.md` if you like) —
> Layout note (2026-10-18): the repo was flattened — `cain-reader\` contents now live at the repo root. Paths inside recorded results above refer to the pre-flatten layout.

Then:
```powershell
git add -A
git diff --cached --stat
git commit -m "Docs/code: update paths after flattening the repo   (no functional change)"
```
(Changes are documentation/comment-only; no runtime behaviour is touched. `server\` tests in W10 confirm nothing broke.)

- [x] W8 done (paths updated in TASKS.md, TASKS_QWEN_STREAMING.md, cain_streaming.py docstring; pytest 56 + extension 42 pass)

## W9 — Environment check: the server venv from its new path
```powershell
Set-Location C:\GitRepo\Stay_Awhile_And_Listen\server
.\.venv\Scripts\python.exe -c "import sys; print(sys.prefix)"
```
**Expect:** the **new** path `…\Stay_Awhile_And_Listen\server\.venv` — that means the interpreter followed the move.

```powershell
.\.venv\Scripts\python.exe -c "import torch, transformers, fastapi, numpy; print('imports ok')"
.\.venv\Scripts\python.exe -m pytest -q          # Expect: 56 passed
```
**Optional tidy-up (no downloads):** the `*.exe` launchers still hold the old path — check with `.\.venv\Scripts\pip.exe --version`. If it prints `Fatal error in launcher`, repair only if you want them, with:
```powershell
.\.venv\Scripts\python.exe -m pip install --force-reinstall --no-deps pip pytest uvicorn
```
Otherwise just keep using `python.exe -m …` (every documented command already does). You may also update the cosmetic `command = ` line in `server\.venv\pyvenv.cfg`. **Do not delete/recreate `.venv`.**

- [x] W9 done (prefix = new path, torch/transformers/fastapi/numpy import, 56 passed; `.exe` launchers still embed the old path - optional repair)

## W10 — Extension + server end-to-end
```powershell
Set-Location C:\GitRepo\Stay_Awhile_And_Listen
node --test extension/tests/chunker.test.js extension/tests/offscreen.test.js extension/tests/background.test.js   # Expect: 42 pass, 0 fail
node --check extension/background.js; node --check extension/offscreen.js; node --check extension/popup.js
.\server\run.ps1          # in a separate terminal; then:
curl.exe -s localhost:8765/health
```
- **(user, Chrome)** `chrome://extensions` → remove the old Cain Reader card → **Load unpacked** → select `C:\GitRepo\Stay_Awhile_And_Listen\extension` → the popup/icon/Stop-button should behave exactly as before.

- [ ] W10 done

## W11 — Final verification
```powershell
git log --follow --oneline -- server/app.py | Select-Object -First 5   # Expect: pre-move commits listed
git log --oneline -6
git status --short                                                     # Expect: clean
Get-ChildItem -Force | Select-Object Mode, Name                        # Expect the flat layout
```
- [ ] W11 done

---

## Appendix A — long-path-safe inventory (only if W4/W6 recursion errors)
```powershell
robocopy .\server "$env:TEMP\rc_noop" /L /E /BYTES /NFL /NDL /NJH /NP /R:0 /W:0 |
  Select-String '^\s+(Files|Bytes|Dirs) :'
```
Run it before (from inside `cain-reader`) and after (from the root); the `Files`/`Bytes` lines must match. `/L` means "list only — copy nothing". Note: robocopy exit codes 0–7 are all success; `1` just means "files were found", so ignore `$LASTEXITCODE`.

## Appendix B — rollback

**Before W7 (move committed):**
```powershell
Set-Location C:\GitRepo\Stay_Awhile_And_Listen
git restore --staged .                 # unstage, keep files where they are
New-Item -ItemType Directory -Force -Path .\cain-reader | Out-Null
foreach ($n in Get-Content "C:\Users\travi\AppData\Local\Temp\opencode\flatten_items.txt") {
  [System.IO.Directory]::Move((Join-Path (Get-Location) $n), (Join-Path (Get-Location) "cain-reader\$n")) -ErrorAction Ignore
}
# files (not folders) in the list move the same way: [System.IO.File]::Move(...)
git status --short                     # Expect: clean again
```
**After W7:** `git revert <move-commit-sha>` restores the tracked files under `cain-reader/` in a new commit (no `reset --hard`), then run the reverse move above for the untracked folders (`.venv`, `scratch`, `voice-source`, `__pycache__`, `.pytest_cache`, `voices/cain.wav`) and finally re-apply W8's doc edits in reverse (`git revert <sweep-commit-sha>`).

**Renaming the repo folder itself** (a different, optional cleanup — `Stay_Awhile_And_Listen` is the repo root already; do not rename or move `C:\GitRepo\Stay_Awhile_And_Listen` while Chrome/venvs/terminals point at it).
