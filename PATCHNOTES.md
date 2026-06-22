# Freq.Phull — Patch Notes

> Cynphull · Hood Knights ©
> Solo-developed by Cynphull

A chronological record of every significant change since the BPM detector
became the foundation. Each entry covers what shipped, why, and what broke
along the way.

---

## v0.3.4 (2026-06-21)

**Setup-failure forensics — `exit 1` is no longer a dead end**

The beta tester's log showed `setup-engines: exit 1` with ZERO diagnostic info about what actually failed. Pip output was being written to the script's local log file (`$env:TEMP\freqphull-setup.log`) but never reached either the server log or the renderer. Setup could fail for any of 20+ reasons (offline, AV blocking pip, corporate proxy, missing VC++ runtime, broken Python install, low disk space) and we'd see the same useless "exit 1".

Three new diagnostic paths, all firing automatically:

1. **PowerShell side:** `EmitError` now reads the tail of the script's local log file (last 40 lines, includes pip stderr + stdout) and ships it in the error event's `log_tail` field. So when the script fails at any explicit `EmitError` call, the actual cause travels in the same JSON message that triggers the error UI.

2. **Server side:** On ANY non-zero setup exit (including hard crashes where `EmitError` never fired — parser explosion, OOM, kill -9), the server reads `freqphull-setup.log` directly from `%TEMP%` and dumps its last 50 lines into the server log with `[setup-log]` prefix. This is the belt+suspenders: even if every other diagnostic mechanism failed, the actual error STILL lands in the log file we already collect.

3. **Renderer side:** The setup error modal now has a collapsible "Show diagnostic log (for support)" `<details>` section. Hidden by default so the modal stays clean. Click to expand → monospace pre with the log tail and the source file path. "Copy to clipboard" button so users can paste it into a Discord support thread in one tap, no screenshots of 200-line traces needed.

When the next beta tester hits a setup failure, we'll see exactly which command exited non-zero and exactly what pip said about it. The next pip-fails-because-X bug will be a one-shot fix.

**Loop icon fuzzy at 14px**
- Player's loop button used a 24x24 viewBox rendered at 14x14 with stroke-width 1.8 — effective stroke ~1.05px that didn't snap to the pixel grid, geometry that ran right to the viewBox edges. At a glance it looked broken/blurry.
- Redrawn with a 16x16 viewBox (matches the rendered size more closely) and stroke-width 1.6, geometry pulled in from the edges so antialiasing doesn't clip. Same metaphor (two arrows forming a loop), crisper render.


**Installer + first-launch hardening pass — triple-checked for new-user reliability**

**Python launcher args got dropped at spawn time.** discoverPython() correctly cached `{cmd: 'py', args: ['-3']}` when the Windows Python launcher was the chosen interpreter, but EVERY spawn() call site was just passing the bare `pythonCmd` (`py`) without the cached args. Result: running `py` instead of `py -3`. Most machines have one Python so it works by accident, but on any machine with Python 2 still installed (or with the launcher configured to default to a specific older version), `py` resolves wrong and analysis fails with cryptic syntax errors from Python 2 trying to run Python 3 code. Fixed at all SEVEN spawn sites: analyze, fingerprint, bg-analyze, transcribe via inner pipeline, stems, mastering, and the main analyze script. Each now does `spawn(pythonCmd, [...getPythonArgs(), ...scriptArgs], opts)` so the launcher gets every flag it was given.

**Fatal-marker parsing could corrupt the error dialog.** main.js was doing `msg.split('__FREQPHULL_FATAL__')[1].trim()` to extract the failure reason from server stdout. But stdout data events can deliver multiple log lines per chunk; if the marker happens to be followed by other lines in the same buffer flush, the dialog message would include subsequent log noise (file paths, IPs, internal state). Now grabs only up to the first newline so the dialog shows exactly the marker payload and nothing else.

**Readiness handshake — stricter signal.** Old check was `msg.includes('47891')` against the entire stdout chunk. Worked because only the readiness log line happens to mention the port, but fragile: any future log line incidentally mentioning 47891 (e.g. a debug dump of the env) would fire a false ready event. New signal requires BOTH `47891` AND `/ready/i` in the message — the readiness line is the only one with both. Also added a `!backendReady` guard so duplicate matches don't re-fire the IPC event.

**Backend crash-restart loop — capped.** A permanently broken backend (corrupt server.js, missing native module, antivirus quarantine of a critical .dll) was respawning every 2 seconds forever, filling logs and burning CPU with zero user feedback. Now caps at 5 consecutive crash restarts. On the 6th, shows a real error dialog: "The backend process has crashed 5 times in a row. This usually means the install is corrupted or an antivirus has quarantined a required file. Try: 1) Reinstall, 2) Add the install folder to Windows Defender exclusions, 3) Check the log file." Counter resets to 0 on a clean exit so a single crash later in the session uses the full retry budget.

**Triple-check audit results — everything else verified solid:**

| Check | Status |
|---|---|
| `bin/` resolution: RES + __dirname + asar.unpacked fallback chain | OK |
| Missing binary handler: PATH fallback + AV quarantine hint logged | OK |
| Integrity manifest: graceful skip on missing or check error | OK |
| DB corruption recovery: backup-and-fresh-start path | OK |
| Port collision detection: `__FREQPHULL_FATAL__` marker -> dialog | OK |
| EPIPE feedback loop guards: server.js + main.js | OK |
| Python alias filter: rejects WindowsApps + <50KB python.exe | OK |
| Engines-broken breaker: trips on 9009 / MS Store / ModuleNotFoundError / ImportError | OK |
| Breaker reset on setup-engines exit 0 | OK |
| Setup script: top-level try/catch with structured JSON error reporting | OK |
| Setup script: numpy preflight before torch (catches base failures early) | OK |
| Setup script: pure ASCII + CRLF (PowerShell parser strict requirement) | OK |
| Setup script: marker file written as UTF-8 without BOM | OK |
| Setup process: keeps running across renderer disconnects | OK |
| Setup process: spawn error -> user-visible "Cannot launch PowerShell" message | OK |
| Renderer: IPC `backend-ready` + polling fallback + 2.5s anti-FOUC | OK |
| Renderer: textContent guard against SVG-as-text bugs | OK |
| All Node syntax checks pass | OK |
| Python AST parse passes | OK |
| EN/FR i18n parity 489/489 | OK |


## v0.3.3 (2026-06-21)

**Analyzer header SVG-as-text: belt + suspenders fix**
- Audited every textContent assignment in app.js + index.html that contains an SVG markup substring. Result: zero remaining sites in source — the previous fix is in place at line 1759. The screenshot was from a stale build.
- Made the analyzer badge construction bulletproof anyway: rebuilt as a clean array of plain text segments (`['Professional analysis', 'Camelot 4A', 'Bass-heavy']`) joined with a middle dot. Each segment is now a plain literal with zero possibility of markup creep, even from future edits.
- New defensive runtime guard wraps `Node.prototype.textContent`. Any assignment of a string containing `<svg` triggers a `console.warn` with stack trace AND strips the markup to its raw text so the user never sees raw HTML in the page. Fast-path (1 ns) on the common case where the string doesn't contain `<svg`. This catches the entire CLASS of bug going forward — not just the specific site we already fixed.

**Engines-broken circuit breaker — actually defined this time**
- Critical latent bug: v0.3.3 added call sites for `tripPythonMissingBreaker()` and `_pythonMissingBreaker` but never added the function/variable definitions. The moment exit-9009 fired anywhere, the server would have thrown `ReferenceError` and crashed. Hidden because the new `discoverPython` + `py -3` launcher finds Python on nearly every Windows machine, so exit-9009 never actually fired in user testing.
- Built the breaker for real with a widened concept: "engines broken" covers BOTH "Python missing" AND "Python found but dependencies missing" (the new failure mode from the user's log). State carries a `reason` (`python-missing` | `deps-missing`) and a `detail` (the specific missing module name, when known).
- New `classifyEngineFailure(exit_code, stderr)` extracts the reason + detail from any Python failure:
  - Exit 9009 / "Python was not found" / "Microsoft Store" -> `python-missing`
  - `ModuleNotFoundError: No module named 'X'` -> `deps-missing`, detail=X
  - `ImportError: cannot import name 'X'` -> `deps-missing`, detail=X
  - Exit 1 with ImportError/ModuleNotFoundError on the first line -> `deps-missing`, detail=null
- bg-analyze worker, `/transcribe`, and the breaker reset (on `setup-engines exit 0`) all route through this classifier. `/bg-analyze/status` now returns `breaker_tripped` + `breaker_reason` + `breaker_detail` so the renderer can drive its UI without a separate roundtrip.
- Backward-compat: kept the old `tripPythonMissingBreaker` / `_pythonMissingBreaker` names as aliases so the existing call sites still work without changes.

**Renderer: distinct toast variant + persistent diagnostic strip**
- Different message for each breaker reason:
  - `python-missing` -> "Python engine not detected - click to set it up" (existing)
  - `deps-missing` -> "Engine dependencies missing - click to run setup again (numpy)" (NEW; shows the missing module name when known)
- De-duplication keyed on `reason:detail` so a different failure mode after the same session re-shows the toast. Previously a single boolean flag suppressed all subsequent notifications.
- New diagnostic row in Settings -> AI engines section. Hidden by default; visible only when the breaker is tripped. Shows the title + description for whichever reason fired, plus a "Re-run setup" button so the user has a clear path forward even after dismissing the toast. Driven by polling `/bg-analyze/status` on settings render and after each `engines-*` SSE event.
- EN/FR parity 489/489 with five new keys for the diagnostic row strings.

**setup-engines.ps1: numpy preflight + better diagnostics**
- New Step 2.5 between "upgrade pip" and "install PyTorch": explicit `pip install numpy scipy scikit-learn soundfile` with proper version bounds. These were transitive deps of torch, but installing them up front means:
  - If they fail (offline, blocked corporate network, missing VC++ runtime for numpy native extensions), we see a small clear error within 30 seconds instead of a cryptic torch error 200 MB into a 250 MB download.
  - If torch later fails, analysis still works for users who don't need stems — graceful degradation instead of all-or-nothing.
  - Each install has its own `$LASTEXITCODE` check that surfaces a clear EmitError with the specific failed package + actionable hint.
- Dropped `--quiet` from all four `pip install` calls. Pip prints ~5 lines on success and the full traceback on failure; keeping that in the log file makes post-mortem debugging actually possible.
- Sanitized the script back to pure ASCII + CRLF after edits (3 em-dash bytes had crept in during editing; PowerShell parser is strict about non-ASCII and fails with cryptic "Missing closing parenthesis" errors — known trap from v0.2.5).



**Analyzer header showed raw SVG markup**
- Bug from the emoji-to-SVG sweep: nine sites where the result of an emoji replacement was being assigned via `.textContent` instead of `.innerHTML`, so the SVG strings rendered as literal text in the page (`<svg class="ic" width=...>...</svg> Bass-heavy`). Fixed all nine:
  - Analyzer "Professional analysis" label — switched to plain text labels ("Melodic" / "Bass-heavy") since the text is already self-explanatory in this context; no icon needed for a small inline status line.
  - Eight button-state update sites (manual yt-dlp update, repair-files button, stockpile-label refresh, etc.) — converted `textContent` → `innerHTML`. Content is fully under our control (no user input interpolated), so it's safe.
- Audited every remaining `class="ic"` occurrence against `.textContent =`, `.innerText =`, `.title =`, `.placeholder =`, `alert(` — zero true positives left.

**Beat-switch detector accuracy pass**
- Tightened thresholds across the board because false positives are worse than false negatives: a flagged switch is an authoritative claim (the UI marks it on the waveform), so a wrong flag costs more trust than a missed real one. Six changes:
  1. **Wider novelty window (W=12 vs 8).** 12 seconds of context is closer to the verse-length scale of modern hip-hop; ignores single-bar transition spikes that fooled the 8s view.
  2. **Higher sigma threshold (1.7 vs 1.4).** Drops borderline noise peaks. Forced mode (filename/user request) eased from 1.0 to 1.2 — still permissive but no longer surfacing pure noise.
  3. **Larger min peak distance (30s vs 20s).** Real beat switches don't come more than once per verse.
  4. **Minimum section length (20s vs 12s).** Collapses cluster artifacts from peaks too close together — these were almost always transition fills mistaken for switches.
  5. **Two-of-four change requirement (was: any-one).** A single feature changing happens during fills, breakdowns, and verse builds. A real beat switch reorganizes multiple dimensions at once. New dimensions: BPM (half/double-aware), key+mode, chroma harmony (cosine < 0.72, was 0.80), spectral texture (cosine < 0.65, NEW — catches drum-pattern shifts that leave chroma alone), and RMS energy (>8 dB delta, was >5 dB).
  6. **Cross-window validation.** Every surviving boundary gets re-tested with a wider lens — expand 25s on each side, re-compute the change vector, confirm it STILL shows >=2 changes. A single-block novelty spike that doesn't replicate across this wider view is noise.
- Added a `texture` dimension to the changes vector: detects drum-pattern shifts (spectral profile reorganizing) that the chroma harmony test would miss — a common case in hip-hop where one beat ends and another starts but the producer kept similar harmony.
- Result: dramatically fewer false positives on tracks with fills, builds, and energy modulations. Real beat switches still flagged with high confidence (now bottoming at 0.40 instead of 0.30 since the criteria are stricter).



**Professional iconography — emojis removed app-wide**
- 235 emoji uses across renderer replaced with monochrome stroke SVG icons (Heroicons/Lucide style). 41 unique emojis mapped to 27 named icons (folder, trash, pencil, search, tag, box, drive, broom, refresh, wrench, image, download, upload, arrow-down, globe, book, sparkles, shuffle, note, mic, volume, sliders, heart, heart-filled, warn, clock, plus x and check for state).
- Decorative emoji PREFIXES in notification messages (e.g. `✓ Database loaded`, `📦 Sent to ...`, `⚡ Forcing`) — REMOVED. The notification system already shows a type icon (check/x/warn/info bubble); the prefix was redundant noise. Cleaner text reads more professionally.
- Heart icons (`♥` favorited, `♡` unfavorite) replaced with SVG — Windows renders these as bright red emoji which clashed with the monochrome aesthetic. Now they inherit currentColor like every other icon.
- Diagnostics text-equivalents: `✓ FOUND` → `OK`, `✗ missing` → `NOT FOUND`. State indicators in waiting/running/done/error use ASCII strings instead of Unicode glyphs.
- New `.ic` CSS utility class for all inline icons: vertical-align baseline-aware, currentColor inheritance, automatic 4px/6px margin when adjacent to text in buttons.

**Updater window — compact, modern, polished**
- Rewrote `renderer/updater/updater.html` from scratch to feel like a focused product window, not a popup:
  - Slimmer 620x720 footprint with tighter padding (28px body padding vs 32px, 12-13px font sizes throughout)
  - Compact 22px topbar (was 28px), smaller logo monogram, light topbar buttons
  - Status badge gets a colored dot pseudo-element (currentColor) — clean state indicator
  - Version cards downscaled: 24px Bebas Neue numbers (was 30px), tighter padding, subtle 1.8% top-edge gradient for depth
  - Arrow between versions is now an inline SVG instead of `->` text
  - "What's new" list shows up to 12 bullets with custom dot markers (5px circles, muted color)
  - Footer buttons more compact (10px padding vs 12px), with proper hover/active/focus states matching the desktop UI
  - Installing-takeover screen: HK monogram tile downscaled to 72x72 (was 88x88), softer 14px corner radius, 36px hero title (was 42px), thinner 2px progress shimmer (was 3px)
  - WCAG focus rings on every interactive element, matches the rest of the app
  - All Unicode artifacts removed — file is now pure ASCII for max codepage compatibility

**Bug-proof install verification — 10x audit**
- DB corruption recovery: confirmed present (backs up + starts fresh)
- Port collision: confirmed `__FREQPHULL_FATAL__` marker → main.js dialog → app exit code 2
- Python alias filter: confirmed `discoverPython` rejects WindowsApps paths + files <50KB
- Python missing circuit breaker: confirmed trips on exit 9009, resets on setup success
- EPIPE feedback loop: confirmed both `server.js` (`_stdoutDead` + `_safeWrite`) and `main.js` (`_mainStdoutDead`)
- Updater benign-error filter: confirmed downgrades `Cannot find latest.yml` / `ENOTFOUND` / etc. to "up to date"
- Backend-ready handshake: confirmed renderer listens for `backend-ready` IPC
- Notification type fallback: confirmed unknown type falls through to `info`
- File integrity: confirmed all expected assets present (fonts, logos, updater HTML, preload scripts)
- Package config sanity: confirmed electron pinned to 28.3.3, oneClick install enabled, electronVersion set
- i18n parity: confirmed EN/FR 488/488, zero missing on either side
- SVG markup: confirmed balanced across all source files



**Install-proofing pass — real users mean real edge cases**

**DB corruption recovery.** `new sqlJs.Database(fs.readFileSync(DB_PATH))` was a single point of failure: if the SQLite file got malformed (incomplete write from a crash, antivirus scan mid-write, OneDrive sync conflict), the server-wide init throws and the app never starts. Now wraps the constructor in try/catch — on failure, backs up the corrupt file to `freqphull.db.corrupt.{timestamp}.bak` (forensics), deletes the bad file, and starts with a fresh empty DB. User loses history once instead of being permanently locked out.

**Port-collision detection.** EADDRINUSE on 47891 (another Freq.Phull running, port hijacked by something else, port reserved by Windows networking) used to silently fail the listen() call. The renderer would just see "server not ready" forever — no diagnosis, no path forward. Now the server emits a `__FREQPHULL_FATAL__ port-in-use` marker on stdout, exits code 2, and `main.js` parses it to show a proper error dialog: "Port 47891 is already in use — Open Task Manager, end any Freq.Phull / node.exe processes, then restart." Clean failure mode instead of mystery hang.

**Periodic temp-sweep moved out of the listen callback** — was previously coupled to the listen() success path, meaning if startup ever moved to a retry-on-different-port model the periodic cleanup would skip. Now lives at module scope with `.unref()` so it doesn't keep the process alive on shutdown.

**Subtle UI polish (NOT a redesign)**
- Sharper Windows ClearType rendering via `-webkit-font-smoothing: antialiased`
- WCAG-compliant focus rings everywhere (3px white at 32% alpha, with 1px dark inset so it never blends with the button surface)
- Clearer disabled states: opacity .42 + 50% saturate so disabled buttons read distinctly dead instead of just dim
- Setting rows get a hair more lift on hover (white at 1.2% alpha)
- Refined scrollbar: slimmer thumb, monochrome only, hover/active states tightened
- Selection color muted to brand-white (was bright Windows blue)
- Active nav button gets a clean 2px white accent bar that scales in (220ms ease-out-quart) — visible but never garish
- History badges (BPM/KEY/WAV chips) get a subtle inner top highlight — looks bevelled without adding chroma
- Headers tightened to -0.01em letter-spacing for the "product" feel; Bebas Neue keeps its 0.02em opening
- Buttons brighten down to 92% on press (consistent feedback across the app)
- Modal cards get a soft 1.8% top-edge gradient for depth without adding color
- Tab pane fade-in shifted to ease-out-quart (260ms) — feels more deliberate than the previous quick fade



**Microsoft Store Python alias trap — fixed**
- User log showed `bg-analyze id=1 python exit=9009` with message "Python was not found; run without arguments to install from the Microsoft Store" repeating every download. Smoking gun: Windows ships a fake `python.exe` at `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` that does nothing but open the MS Store. Our old `getPythonCmd()` fallback returned the bare string `'python'`, which resolves to that alias on every fresh Windows machine. Cue endless 9009 failures and zero analysis ever running.
- New `discoverPython()` with auto-detection, ordered fallback chain:
  1. `engines-ready.json` marker (post-setup, full absolute path)
  2. `py -3` launcher — official Python launcher, NEVER the alias
  3. Common install dirs: `%LOCALAPPDATA%\Programs\Python\Python3*\python.exe`, `C:\Python3*\python.exe`, `%PROGRAMFILES%\Python3*\python.exe`, `%PROGRAMFILES(X86)%\Python3*\python.exe` (versions 3.13 down to 3.9)
  4. `where python` output, with WindowsApps alias filtered out
  5. Last-resort bare `'python'` (preserved old behavior; will fail but at least we tried)
- Each candidate validated with a quick `import sys; print(sys.version_info)` spawn (timeout 3.5s) so we don't return a path that exists but is broken or too old. Requires Python 3.9+.
- Alias filter is two-pronged: (a) reject any path containing `WindowsApps`, (b) reject any python.exe under 50 KB (real python.exe is multi-MB; aliases are reparse-point stubs ~5 KB).
- Result cached for the session, re-checked at most every 60s so a fresh install is picked up.

**Circuit breaker: bg-analyze stops hammering missing Python**
- Even with discovery, some users genuinely don't have Python. Without a breaker, every download → ingest event re-triggered the worker → 3 retries on the SAME track → MS Store alias error → repeat for next track → log fills with the same error message hundreds of times.
- New global breaker: on the first exit 9009 / "Python was not found" / "Microsoft Store" in stderr, the breaker trips and:
  - Stops `nudgeAnalysisWorker()` from running — no more spawns
  - Returns 503 from `/transcribe` with `reason: 'python-missing'` instead of trying to spawn
  - Broadcasts an `engines-unavailable` SSE event
- Breaker resets when `/engines/setup` exits 0. Also clears the Python-discovery cache so the freshly-installed Python is picked up immediately without waiting for the 60s cache.

**Renderer: sticky engines-missing notification with Run-setup CTA**
- New SSE listener fires once per session (idempotent via `_enginesUnavailableShown`) for the `engines-unavailable` event. Shows a sticky warn-toast (no auto-dismiss) with text: "Python engine not detected. Click to set it up — automatic BPM/key analysis is paused until then." Clicking jumps to Settings tab, scrolls to the AI engines section, and expands it if collapsed. Translated EN/FR.
- Matching `engines-available` event shows a brief ✓ "Python engine ready. Background analysis resumed." once setup completes successfully — confirmation for the user that the fix worked.

**Transcribe also routes through the discovered Python**
- Old code hard-coded `await run('python', ['-m', 'whisper', ...])` which fell into the same alias trap. Now uses `getPythonCmd()` and short-circuits on the breaker.


## v0.3.2 (2026-06-19)

**Settings sections actually collapse now**
- The Grid `grid-template-rows: 1fr -> 0fr` trick only works on ONE grid child. The previous markup had multiple `<div class="setting-row">` siblings directly inside `.settings-section-body`, so the grid auto-generated extra rows for them that didn't respond to the 0fr collapse — that's the giant empty black gap under the collapsed "Performance" header in the screenshot. Now every section's rows live inside one `.settings-section-body-inner` wrapper, which IS the lone grid child, and collapses cleanly.
- Result: a collapsed section shrinks to just its header height. No residual padding, no dangling border, no wasted scroll space.

**NSIS install dialog killed — branded window is now the only visible UI**
- `quitAndInstall(false, true)` was the smoking gun. `false` means "run installer non-silently" — that's what spawned the standard Windows "Freq.Phull Setup / Installing, please wait..." dialog with the green progress bar (the one in the screenshot). Switched both call sites (`updater.js` line 208 and `main.js` line 69) to `quitAndInstall(true, true)`:
  - `true` (isSilent) — NSIS runs completely silently in the background, no install dialog at all
  - `true` (isForceRunAfter) — app relaunches automatically on the new version when install completes
- Combined with our branded "INSTALLING UPDATE" window from v0.3.0, the user now sees: small in-app banner -> click INSTALL NOW -> branded HK takeover screen with pulsing logo + indeterminate progress -> app reappears on new version. NSIS dialog: gone.
- Also bumped the click->install handoff beat from 250ms -> 500ms so the branded window's hero title + pulse animation have fully rendered before the app quits. Avoids a quick flash where the user might catch the window mid-render.

## v0.3.1 (2026-06-19)

**Build config: electron pinned**
- `electron-builder --publish` was failing with `Electron version "^28.0.0" is a range, not a fixed version`. The caret range works for `npm install` (gets you the latest 28.x) but electron-builder needs an EXACT version because it downloads platform-specific binaries for one specific release — a range can't be resolved without electron installed in node_modules (which the publish step doesn't necessarily have at that point).
- Pinned `devDependencies.electron` to `28.3.3` (the latest stable in the 28.x line) and added `build.electronVersion: "28.3.3"` to electron-builder config as a fallback so even if someone touches the devDep range later, the builder still has a fixed reference.
- After pulling this fix: `rm -rf node_modules package-lock.json && npm install` to make sure the exact version is downloaded, then `npx electron-builder --win --x64 --publish always` should run clean.


**Settings page reorganized into categories**
- 22 flat rows replaced with 9 collapsible sections, each with an icon, title, and short description on the header. Sections persist their open/collapsed state in localStorage so the user's layout choices survive across sessions. Default opens: General, Library, Maintenance, Updates — the high-traffic ones. Default collapsed: Performance, AI engines, Extension, Diagnostics, About — present but not in the way.
- The categories:
  - **General** — Language, Stockpile folder
  - **Library** — Auto-analyze, Auto-tag, Auto-send to folder, Watch folder, Write tags to files, Download autoclear
  - **Maintenance** — Storage breakdown, Find duplicates, Repair history, Fix file locations, Clean temp files
  - **Performance** — CPU-only for stem separation, Hardware acceleration
  - **AI engines** — Engines setup (Python, Demucs, Whisper)
  - **Updates** — Check for app updates, yt-dlp version
  - **Browser extension** — Link to repo + how-to-install modal
  - **Diagnostics** — Diagnose paths, View logs
  - **About** — Version, Cynphull / Hood Knights credit
- Open/close uses the CSS Grid `grid-template-rows: 0fr -> 1fr` trick — buttery smooth animation on dynamic content with no JS height measurement. Chevron rotates 90 degrees on toggle. Honors `prefers-reduced-motion`.
- Each section header has a 30x30 bordered icon tile that brightens on hover; whole header is keyboard-accessible with focus ring meeting WCAG contrast, `aria-expanded` and `aria-controls` properly wired.
- Section icons: globe (general), stacked-books (library), wrench (maintenance), lightning (performance), CPU chip (engines), down-arrow (updates), puzzle piece (extension), stethoscope (diagnostics), info-circle (about). All monochrome stroke SVG, inherit current color, ~150 bytes each.
- EN/FR parity 487/487; new keys translated for all 9 sections + their subtitles.


## v0.3.0 (2026-06-19)

**Updater stops crying wolf on benign errors**
- The "Cannot find latest.yml in the latest release artifacts" toast in the screenshot was electron-updater complaining that the GitHub release exists but doesn't ship the YAML manifest electron-updater uses to detect new versions. Common when a release is published manually (just the .exe attached, no auto-generated assets). Functionally there's no update the user can install, but we were surfacing it as a scary red error.
- New benign-error classifier in both `updater.js` (main side) and `app.js` (renderer side). Matches: "no published versions", "Cannot find latest.yml", `ENOTFOUND`/`ETIMEDOUT`/`EAI_AGAIN`, and `net::ERR_INTERNET_DISCONNECTED`/`NAME_NOT_RESOLVED`/`CONNECTION_REFUSED`. When any of these fire:
  - Main: `autoUpdater.on('error')` downgrades the event from `update-error` to `update-not-available`, so the renderer treats it as "up to date" everywhere automatically.
  - Renderer manual-check button now shows `✓ You're up to date` for benign errors instead of `✕ Cannot find latest.yml...`. Still logged to the diag panel as `info` for diagnostics.
- Genuine errors (auth failures, malformed updates, signature mismatches) still surface as `err` toasts so real problems aren't masked.

**Branded updater now fronts the install-restart sequence (the actual ask)**
- v0.2.8 misread the request and built the branded updater as a Settings-launched preview window. That entry point is gone. The branded window now appears at the **exact moment that used to show a Windows-y "1988 wizard"** — between the user clicking INSTALL NOW and the app quitting to relaunch on the new version.
- Flow: Update banner -> INSTALL NOW -> branded HK takeover window opens (720x520, `alwaysOnTop`, `closable:false`, no minimize) -> 250ms beat so it's actually visible -> `autoUpdater.quitAndInstall(false, true)` runs silent NSIS in the background -> app relaunches on new version. The user never sees a Windows dialog.
- Takeover screen shows: pulsing HK monogram tile, big "INSTALLING UPDATE" title in Bebas Neue, version subtitle, indeterminate progress shimmer, and "PLEASE DO NOT CLOSE THIS WINDOW" hint. Fully translated EN/FR. Honors `prefers-reduced-motion`.
- Removed: Settings "Open updater" row, the `openBrandedUpdaterFromSettings` helper, and the auto-open-on-update-available behavior (the existing corner banner stays as the "an update is available" surface — it's small and unobtrusive, which is what users want for the *notification*; the full branded window is reserved for the *install moment*).

**Back-to-top arrow on History (accessibility)**
- Floating button bottom-right of #main, fades in past 400px scroll. Click smooth-scrolls to top; reduced-motion users get an instant jump. Sits at `bottom:96px` so it's always above the mini player without overlap. Proper `aria-label="Back to top"`, keyboard-focusable, focus ring meets WCAG contrast. Scroll observation is `passive: true` + rAF-throttled so it doesn't thrash on high-DPI wheel events.


## v0.2.9 (2026-06-19)

**Remove button hidden outside Select mode**
- Row layout is cleaner now: in normal browsing mode every row shows play, thumb, info, badges, and the similar (≈) button — no Remove. Remove appears only when Select mode is active, so it's there when you're actually about to delete things. Stops cluttering the right edge during normal scrolling.

**Cleaner Select button**
- Dropped the empty-checkbox glyph that was sitting next to "Select" (looked like a tiny outlined square; the user called it "ugly", they were right). Plain "Select" text now. The i18n strings lost their leading "☐" too.

**Real HK monogram as the fallback thumbnail**
- Previous fallback was a crude line drawing of "HK" in stroke. Replaced with the actual gothic Hood Knights brand mark from `assets/hk-logo.png`, composited onto a 256x256 dark tile at 45% alpha so it reads as a quiet placeholder rather than shouting brand on every empty row. Encoded as base64 PNG inside the JS bundle (~10 KB) so there's no network request, no file resolution, and the browser caches one decoded bitmap that every row reuses.

**Extension repo link fixed**
- `https://github.com/CodePhull/FreqPhull-realease/tree/main/freqpull-ext` was 404ing — that folder doesn't live on the main branch. The extension is published as a .zip on the Releases page (per the repo README). All references updated:
  - Settings -> "Open page" button now goes to `/releases`
  - "How to install" step 1 text updated to "Open the Releases page and download the latest freqpull-ext zip" (EN + FR)
  - Step 1 button label flipped from "Open GitHub repo" to "Open Releases page"
  - Step 4 description tweaked since users now extract a versioned zip
- Extension self-update check also fixed (was polling `/commits?path=freqpull-ext` which 404'd) — now polls `/releases/latest` and tracks the release tag instead of a commit SHA. Banner shows the tag name instead of the SHA short hash.


## v0.2.8 (2026-06-18)

**Notifications: monochrome polish**
- Toasts redesigned to feel less "popup ad" and more "product chrome":
  - Removed every bright color washes from `ok`/`info`/`warn` — they share the same UI-white left accent line, white-tinted icon bubble, and white progress strip as the rest of the app.
  - `err` is the only type that keeps a color (`#ff5e5e` red) so failures still stand out instantly — same intent as the rest of the interface (red is reserved for "something is wrong").
  - Background now has a subtle internal gradient sheen (top-to-transparent rgba white at 2.2%) instead of a flat tile — catches light without adding chroma.
  - Drop shadow deepened slightly (12px -> 16px on hover) and gains an inset black ring for the floating glass feel.
  - Spring entry softened: 380ms ease-out-quart with a slight scale-from-0.985, no aggressive overshoot. Hover lifts the surface with a quick background brightness bump and tighter shadow.
  - Exit collapses with a 32px drift right + scale-down so the stack reflow looks smooth, not snappy.
  - Icon glyphs (check / cross / i / triangle) carry the type recognition load now that color isn't doing it.

**Branded updater window restored**
- The screenshot the user had been showing (HK logo, "FREQ.PHULL Updater" header, big "SOFTWARE UPDATE" title, EN/FR toggle, INSTALLED → THIS UPDATE version cards with arrow, status badge, WHAT'S NEW section, INSTALL NOW / CLOSE buttons) wasn't in the codebase anywhere — somewhere along the way it had been lost. Rebuilt as a dedicated 620x720 frameless BrowserWindow with full HK styling, drag-to-move topbar, EN/FR language toggle, bundled Bebas Neue font (no network dep), composite-only hover animations.
- Bridge between `updater.js` and the new window: every autoUpdater event (`checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`) gets translated into the window's state vocabulary (`checking`/`none`/`available`/`downloading`/`ready`) and pushed via `webContents.send`. Release notes get split into bullet items for the "WHAT'S NEW" list. Progress bar with speed (MB/s) during download.
- Auto-opens once when an update is detected. Also available manually from a new Settings row ("🔔 Open updater"). Window closes with the existing in-app banner still working in parallel for users who prefer that.
- Install button calls `autoUpdater.quitAndInstall(false, true)` — same code path as the banner, so the actual NSIS install step (already `oneClick: true` since v0.2.8) takes over silently. End-to-end: branded window → progress bar → small NSIS progress dialog → app relaunches. No 1988 wizard at any step.

**Main process hardened against EPIPE too**
- Same audit applied to `main.js` which had the IDENTICAL vulnerability: `log()` called `console.log()` unguarded, and there was NO `uncaughtException` handler at all (any thrown error silently killed the entire app, including the in-flight update install). Now: wrapped `console.log` in try/catch with the dead-stream flag pattern, added `process.stdout.on('error')` and `process.stderr.on('error')` listeners, added global `uncaughtException` and `unhandledRejection` handlers that filter EPIPE specifically. The on-disk log path continues working when stdout is dead.

**EPIPE feedback loop fixed**
- Catastrophic server crash discovered post-release: when Electron closed our stdout pipe (window closed, app quitting), the next call to `slog()` threw EPIPE. The global `uncaughtException` handler caught it and called `slog()` again to log the error - which threw EPIPE again - which the handler caught - looping forever at ~5000 iterations per second, filling the on-disk log file until the process was killed. Several users had multi-gigabyte log files after a few seconds.
- Three layers of fix: (1) `slog()` no longer calls `process.stdout.write` unguarded - wrapped in `_safeWrite()` which catches EPIPE and flags the stream dead so we don't bother trying again; (2) added stream-level `error` listeners on stdout/stderr so EPIPE errors that arrive asynchronously don't reach uncaughtException at all; (3) the uncaughtException handler now filters EPIPE errors and never tries to log their stack trace - it just marks the stream dead and returns. File logging path (which was already wrapped in try/catch) continues working, so logs are preserved on disk even when stdout is dead.
- Smoke-tested: simulated a dead stdout by overriding `process.stdout.write` to throw EPIPE, called slog 5 times - no exceptions thrown, no recursion, all 5 messages reached the log file.

**Hardware acceleration toggle**
- New Settings row. Stored in a tiny `boot-flags.json` next to the app's userData, read SYNCHRONOUSLY at main.js startup before `app.ready` (which is when Electron requires `disableHardwareAcceleration()` to be called). Toggling pops a restart-now confirm; the change is invisible until restart so we make that explicit. Honors EN/FR.

**Browser-extension link + install how-to**
- New Settings row: "Open page" button goes straight to the freqpull-ext folder on the releases repo; "How to install" pops a 5-step modal with the Chrome flow (Open repo -> chrome://extensions -> Developer mode -> Load unpacked -> Pin). Each step in its own bordered card with a numbered medallion; tip box at the bottom about the 127.0.0.1:47891 link. Fully translated EN/FR.

**Thumbnail bug-proof**
- New `HK_FALLBACK_THUMB` (inline SVG of the HK monogram, dark tile background) and a `resolveThumb()` helper used by every `<img>` render path: History rows, Stockpile folder-view rows, Similar-tracks modal. Plus a global `window._thumbFail()` onerror handler that swaps a broken URL to the fallback and self-clears so a bad fallback can't loop. Existing rows render with `loading="lazy" decoding="async"`. Visually the fallback is muted and desaturated so users can tell at a glance which rows lost their thumb.

**History refresh stutter fixed**
- The old `_renderHistoryImpl` did `list.innerHTML = rows.map(...).join('')` which destroyed every row on every render, throwing away decoded image bitmaps and forcing tag strips to lazy-load again. Replaced with row-level DOM reconciliation:
  - Build per-row fingerprint (id+title+bpm+key+thumb+favorite+tags+playstate)
  - First render or huge delta (>80 rows): full innerHTML rewrite (fastest)
  - Otherwise: skip untouched rows entirely, patch changed rows in place, preserve already-decoded `<img>` nodes when src is unchanged
  - New rows insert with the existing pulse animation; gone rows fade out (180ms transform+opacity, collapses max-height to zero)
- Net effect: no flash, no layout reflow on static rows, no tag re-hydrate jiggle when the data hasn't moved.

**Installer no longer looks like 1988**
- Switched NSIS to `oneClick: true` — modern silent install with a small branded progress dialog (Chrome/Discord style). No more wizard pages, no Next/Next/Finish. The app launches automatically when install completes. `runAfterFinish: true`. Custom installer artifact name: `Freq.Phull-Setup-${version}.exe`.

EN/FR i18n parity 468/468.


## v0.2.7 (2026-06-18)

**Brand fonts now bundled in the package**
- Bebas Neue and Inter (weights 300/400/500/600) are now shipped as local .woff2 files in `renderer/fonts/` (~110 KB total). Loaded via @font-face — no network dependency, no Google Fonts CDN, fully offline-proof. The Google Fonts <link> has been removed.
- Strengthened the system-font fallback chain stays in place for the first frame: `'Oswald','Anton','Impact','Haettenschweiler','Arial Narrow'` for Bebas Neue, `'Segoe UI Variable','Segoe UI',system-ui,...` for Inter. `font-display:swap` means the real fonts replace them within ~5ms once decoded.

**Visible boot update check**
- The auto-update boot check now fires at 1500ms (was 8000ms) and surfaces a small "Checking for updates..." toast on launch so users see it happening instead of a silent background check. A confirmation toast ("You're up to date") flashes briefly if no update is found - but ONLY on the boot check, not on every 4-hour interval (would be spammy). Found-update banner unchanged.

**Extension self-update banner (v4.3.0)**
- Extension now polls GitHub's commits API every 6 hours for the latest commit SHA of the `freqpull-ext` folder in the releases repo. When it differs from the user's last-seen SHA, a soft top banner appears in the panel: "A new version of the extension is available - <commit message>" with a "View update" link to the repo and a dismiss button. Dismissing marks the SHA as seen until the NEXT change. Rate-limited well under GitHub's 60 req/hr unauthenticated cap.

**Performance pass for huge histories**
- `content-visibility: auto` on `.hist-row` and `.sp-folder-card` - off-screen rows skip layout, style, AND paint entirely. With the LIMIT 500 lifted in this same release, users can have 5,000+ rows and scrolling stays buttery (browser-native virtualization, zero JS overhead).
- `contain: layout style paint` on rows so transitions don't repaint neighbors.
- `contain-intrinsic-size` placeholder so the scroll-bar dimensions are correct before rows materialize.
- GPU promotion (`will-change` + `translateZ(0)`) on the mini player, notification stack, and modal backdrops - the elements that animate every frame.
- Mousedown ripple listener marked `passive: true` so the browser dispatches it on the compositor thread.
- Smooth-scroll behavior globally; honors `prefers-reduced-motion`.

**Design polish**
- Soft top-edge gradient on cards (lit-from-above feel).
- Inner highlight on primary buttons - catches the light like a real key.
- History row inset bottom line that brightens on hover (cleaner than a flat divider).
- Sidebar gets a faint vertical highlight gradient with falloff at top/bottom for depth.
- Mini player gets a subtle 1px top edge + soft drop shadow lifting it off the page.
- Inputs get a soft top-inset shadow when not focused; sharpen on focus.

**History cap lifted**
- The `/history` endpoint had a hardcoded `LIMIT 500` — older downloads weren't deleted, just silently invisible to the renderer once you crossed 500 tracks. Removed. The endpoint now returns every row by default; an optional `?limit=N` query parameter is honored if any caller wants a slice. Safety ceiling at 50,000 to bound the response payload size.

**Repair missing thumbnails + duration**
- New "Fix missing thumbnails" button in Storage Breakdown for rows that arrived through the watch folder before v0.2.5's duplicate-prevention shipped — they had a file_path but no thumbnail and no duration (the empty rows in the screenshot). Two strategies stacked: (1) twin merge — if a YouTube-original row exists with the same basename and full metadata, copy thumbnail+duration from it instantly; (2) ffprobe — for rows with no twin, shell out to ffprobe and read the real duration from the file. Dry-run preview shows per-strategy counts before applying. New endpoint: `POST /history/repair-metadata`.

**Premium micro-interactions**
- Spotify-grade motion polish, composite-only (opacity/transform/filter — no reflow). Every duration <=240ms so nothing feels sluggish. Resting state is byte-identical to before; motion only fires on :hover, :active, focus, or animation triggers.
- Nav buttons: slide right on hover, scale-down on press, springy icon scale on active. New sliding accent bar on the active tab (240ms ease-out-quart).
- Buttons: composite-only lift + press-depth + radial ripple at click origin (computed in 5-line JS, no DOM injection).
- History rows: tightened hover transition, scale-spring on the play button.
- Mini player: spring-bounce on all extra buttons, heart-pop animation when favoriting (keyframed scale), thumb grows on seek-bar hover.
- Tab switches: opacity + 4px upward slide.
- Modals: backdrop fades in with blur, card scales in from 96% with 8px lift.
- Toasts: slide in from the right, fade out with smaller offset on dismiss.
- Inputs: subtle outer glow on focus (3px low-alpha white ring).
- Switch toggles: knob slides on cubic-bezier spring.
- Skeleton-loader class added (shimmering placeholder) for any future loading state.
- All animations honor `prefers-reduced-motion: reduce` and disable cleanly.



## v0.2.6 (2026-06-17)

**Scroll-lock toggle on the mini player**
- New anchor-icon button in the mini player's extras row (next to the favorite heart). Click to switch between "follow the playing track in History" (default, locked anchor) and "browse freely while the queue plays" (slashed anchor). Persists across sessions in localStorage; respected by both arrow-key skips and the prev/next buttons. The v0.2.5 scroll-follow behavior is unchanged when locked — this just gives users who want to dig through History during long play sessions an opt-out.
- Translated EN/FR, button has proper `aria-pressed` state and tooltip that reflects the current mode.


## v0.2.5 (2026-06-17)

**Stockpile move no longer duplicates rows**
- Moving a track into a Stockpile folder (auto-send, auto-organize, repair) used to race the watch-folder daemon: it saw the file appear at the destination, fired its adopt-watched debounce, and sometimes won the race against the DB UPDATE that remaps the original row's file_path — producing a phantom duplicate without thumbnail or duration. Now every intentional move registers its destination in a 30s "recent moves" set the watcher consults first; plus a basename safety-net catches anything that slipped through. Three layers, no more duplicates.

**Play indicator persists when paused**
- The active row's play button used to lose its white-background highlight the moment you paused — you literally lost track of which track you were on. Now the row stays highlighted while the track is LOADED (active), and the icon alone flips between play-triangle and pause-bars to indicate audio state. Legacy mode already behaved this way; mirror mode now matches.

**History scroll-follows arrow navigation**
- Pressing ←/→ to walk through tracks now scrolls the active row into view if it's off-screen. Comfortable middle band: only scrolls when the row is within 80px of the top or 200px of the bottom (so the mini player and the next-row preview stay visible). Respects `prefers-reduced-motion` — instant jump instead of smooth.

**Python setup: robust download + retry counters**
- `setup-engines.ps1` had 653 non-ASCII UTF-8 bytes (em-dashes, box-drawing) with no BOM. PowerShell's default codepage misread them, sometimes producing apparent parenthesis chars that broke the parser — the "Missing closing parenthesis" crash users reported. Sanitized to pure ASCII + CRLF, same as Download-Binaries.bat got last patch.
- New `Invoke-RobustDownload` helper: 4 retries with exponential backoff, configurable mirror list, minimum-size sanity check, file-exists short-circuit (resume across crashed setups), TLS 1.2 forced. Wired into both download sites (Python installer, VC++ Redist). New `Try-Step` wrapper for non-fatal steps — partial setup is now graceful instead of catastrophic.

**Optimization**
- Renderer: `renderHistory()` is now rAF-coalesced. A playlist of 30 grabs used to trigger 30 full innerHTML rewrites within 100ms (history-changed + bg-analyze events); now all events within one frame collapse to a single render.
- Server: new `requestDeferredSave()` for hot loops. Bulk operations like Auto-organize (200+ tracks) and adopt-orphans (479 files) no longer write to disk on every row — a single flush 500ms after the last call. With `beforeExit` flush so nothing is lost on quit.
- Note on the ffmpeg.dll error: that's Electron's bundled Chromium media DLL, not our code. If it goes missing it usually means antivirus quarantined it or it was deleted from the install folder. Reinstall the app to restore.


## v0.2.4 (2026-06-15)

**Keyboard shortcuts fixed + bare arrows for prev/next**
- v0.2.2's Space-from-anywhere shortcut never actually worked. Two reasons: (1) a separate, mode-aware mini-player keyboard handler had been quietly handling Space since long before — my new handler double-fired with it, the two toggles cancelled, and the user saw nothing change. (2) When the mini player was hidden, the fallback called `togglePlayPause()` — a function that doesn't exist in this codebase. The new handler has been removed entirely; the existing mini-player handler is now the only source of truth and it correctly drives both mirror mode (Analyzer audio path) and legacy mode (HTMLAudioElement path).
- Previous/Next promoted from Ctrl+← / Ctrl+→ to **bare ← / →** — what users actually expect from a media player. Alt+← / Alt+→ continue to seek 5s within the current track, unchanged.
- Stuck-input fix: clicking the YouTube URL field at the top of Download trapped focus there indefinitely, so subsequent Space presses just typed into the field. A body-level mousedown listener now drops focus from inputs when you click anywhere non-interactive (body, cards, dividers), so global shortcuts wake back up after the very first outside click.
- Mini-player tooltips corrected — they previously claimed `Ctrl+←` / `Ctrl+→` for prev/next, but no such binding ever existed.

Active shortcuts (when mini player is visible and you aren't typing):
- `Space` — play / pause
- `←` / `→` — previous / next track
- `Alt+←` / `Alt+→` — seek 5s back / forward
- `Esc` — close top modal
- `Ctrl+Alt+←` / `Ctrl+Alt+→` — tab history back / forward


## v0.2.3 (2026-06-15)

**Build: Download-Binaries.bat works reliably**
- The bundled binary fetcher had UTF-8 multi-byte characters (em-dashes, box-drawing) AND LF-only line endings — a bad combination for Windows CMD. The mojibake was cosmetic ("ÔçÖ"), but the LF endings caused the parser's label-search to fail intermittently mid-run ("The system cannot find the batch label specified - download_with_validation") because CMD's seek logic relies on CRLF terminators. Converted to pure ASCII with CRLF endings — every label call now resolves correctly regardless of which control-flow branch ran before.

**Race fix bulletproofed (server)**
- Added a pre-download `outDir` snapshot to the path-resolution chain. The full priority is now: `--print after_move:filepath` → `[ExtractAudio] Destination:` line → snapshot-diff (files that weren't there pre-run) → legacy mtime as last resort. Even if yt-dlp's print flag fails on an unusual build, the snapshot diff makes parallel downloads writing to the same folder mathematically impossible to mis-attribute. Each fallback path is logged so we can see which one fired.

**Extension v4.2.1: auto-analyze defaults OFF**
- The in-panel auto-load/analyze step is the only thing that ever blocked the extension panel after a download landed. Since v0.2.2 desktop has a background analysis worker that handles BPM/key independently of the extension, the in-panel preview was redundant on top of being a freeze risk. Default flipped — bulk grabs are now snappy out of the box; users who liked the instant single-grab preview flip the Settings toggle back on. Stored preference is honored across both defaults, so existing users keep their previous setting.

**Accessibility & UI polish**
- Skip-to-content link (visible only when keyboard-focused, jumps past the sidebar).
- Sidebar is now a real `<nav aria-label="Workspace">`, main area `role="main"` and programmatically focusable from the skip link.
- `aria-current="page"` on the active nav button — screen readers announce the current tab. Active state visual gets a slightly crisper icon transition.
- Every icon-only mini-player button got an `aria-label` (Close, Shuffle, Previous/Next, Play/Pause, Repeat, Favorite, Transcript, Mute).
- Notification stack is now a polite live region (`role="status"`, `aria-live="polite"`, `aria-atomic="false"`) — toasts get announced to screen readers without interrupting current speech.
- Global Space-to-play/pause shortcut, scoped: ignored when typing in inputs/textareas/selects/contenteditable, ignored when a modal is open.
- Smoother tab pane transition (140ms fade in, instant under `prefers-reduced-motion`). Quieter empty-state class for cards that have nothing yet.

**Parallel download race fixed (server)**
- Critical bug from v4.1.3+ extension and any parallel grabs: when two downloads ran concurrently to the same folder, the post-yt-dlp scan that picked the output file used "newest mtime" — and could race-pick the OTHER download's file. Result: track A's history row ended up pointing at track B's audio, so playing track A from history played track B. Now we capture yt-dlp's own `--print after_move:filepath` output (race-proof, knows exactly which file belongs to this invocation), fall back to `[ExtractAudio] Destination:` lines, then the legacy mtime scan only as last resort with a logged warning.
- Affects: extension parallel-download queue (default 2 concurrent since v4.1.3), playlist grabs (v0.2.0+), watch-folder ingest of concurrent file drops. Single-download flows were never affected. No data migration needed — fresh downloads from here on will be correctly attributed; existing mis-attributed rows can be located by listening and corrected via "Fix file locations" or by re-downloading.

**Background analysis worker**
- New: any track in History with no BPM gets picked up by a server-side worker and analyzed automatically — same `analyze.py` pipeline as on-demand. Bulk grabs, playlist downloads, watch-folder ingest, manually-adopted orphans: History always ends up complete. One worker, serial (CPU-heavy pipeline can't share well); arrivals are debounced so 30 playlist grabs nudge it once and it drains them in order.
- Floating pill in the corner shows "Analyzing 5 · current title" while it works; click to retry failed rows. Auto-hides when idle. Failed rows are parked after 3 strikes so a poison file doesn't burn CPU in a loop. Endpoints: `GET /bg-analyze/status`, `POST /bg-analyze/run`.

**Auto-tag opt-out**
- New Settings toggle: "Auto-tag downloads". Defaults ON (matches behavior since v0.0.8). When OFF, downloads — desktop, extension, AND watch-folder ingest — arrive in History without any folder tags. Auto-send becomes a no-op while off, since there's no tag to act on. Organize manually or with Auto-organize when ready.
- Honored everywhere through one helper: `autoTagEnabled()` in the renderer, `getPref('auto_tag')` on the server, synced via `/prefs` so a single toggle covers all three ingest paths.

**Responsive UI**
- The app now reflows cleanly down to phone-width without changing the default desktop look. Breakpoints add up: ≤1100px fluid main padding, ≤960px sidebar trims to 168px with ellipsis labels, ≤800px sidebar becomes an icon rail (62px), ≤620px the stat cards stack 2-up, settings rows go vertical, dialogs fill the viewport with padding, the pro analyzer grid drops to 2 columns. ≤460px emergency single-column.
- Debounced resize relay: JS-driven layout (notification stack position, modals) gets notified once per animation frame, via both `resize` and a `ResizeObserver` on body — so DevTools dock changes and Electron window state changes also trigger a re-flow.

**Smoother & more accessible**
- Composite-only hover transforms with `will-change` hints — buttons, history rows, folder cards lift on hover at GPU speed without paint thrash.
- Visible keyboard focus rings everywhere (`:focus-visible` — only on keyboard nav, never after a mouse click).
- Touch-target minimums on `pointer:coarse` devices (touch laptops, kiosks): buttons ≥32px, nav buttons ≥40px, history rows ≥48px.
- High-contrast / forced-colors mode honored (`@media (forced-colors: active)`).
- Quieter scrollbars (10px, low-contrast, brighten on hover).
- No design change — all rules are additive and gated behind breakpoints, focus state, hover, or system preference media features.


## v0.2.1 (2026-06-13)

**Desktop: Fetch auto-queues the download**
- Pressing Fetch now adds the track to the download queue immediately, using the currently-selected format. The two-step (Fetch → pick format → Download) made sense back when Fetch was a preview, but in practice nearly every fetch ends in a download with the already-selected format — and the browser extension has been one-click since v4.1.0, so desktop now matches. Duplicate detection (queue + already-downloaded-this-session confirm) still runs.

**Extension v4.1.5: UI no longer freezes while a track finishes loading**
- When a single download completed, the panel blocked for several seconds decoding the audio + running in-browser BPM/key analysis inline — clicks on Grab during that window felt dead, which is what "impossible to load another track" felt like. The download slot is now released immediately when the file lands; the decode/analyze runs deferred (post-current-task), so a new Grab click registers and starts downloading instantly. Multi-track grabs no longer auto-load into the in-panel player at all (use the Open button on each row when you want one), matching how the desktop app behaves.

**Beat-switch detection**
- The analyzer now detects beat switches and reports per-section info. One STFT pass extracts per-second harmony (chroma), energy, brightness, bass weight, and rhythmic-activity features; a "checkerboard" novelty curve finds points where the track before and after genuinely differ (gradual builds don't trigger). Each detected section then gets its own full BPM + key/Camelot + energy analysis using the existing detectors.
- Boundaries are validated: a switch only survives if neighbors actually differ — tempo >5% apart (half/double-time aware, 140≈70), key change, harmony shift, or >5 dB energy jump. Arrangement-only changes (same beat, drums drop out) get merged away. Max 4 switches, sections under 12s merge into neighbors.
- Tracks whose filename contains "beat switch" / "beatswitch" / "beat-switch" automatically analyze in deep mode (lower detection threshold — we expect a switch, so the best candidate is surfaced).
- New card on the Analyze tab: switch markers with timestamp, what changed, and confidence; a colored timeline; and per-section rows (time range, BPM, key + Camelot, dB). Clicking a section or timestamp seeks the Analyzer playback. When nothing is found at normal sensitivity, a "Scan harder" button re-runs the forced pass.
- Tested end-to-end on synthetic two-beat audio: switch localized within 2s, per-section BPM/keys correct, clean negative on a uniform track. Notably, the single top-level BPM on the test file came out wrong (averaged across the switch) while section values were right — exactly the problem this fixes.
- Cost: near-zero on tracks without a switch (per-section BPM/key only runs when boundaries are found).

**Updater: launch detection fixed**
- The startup update check fires 8s after boot, but IPC events sent before the renderer's listeners attach are silently lost — on slow boots (engine setup, cold disk) the "update available" event evaporated and no banner appeared until the 4-hour re-check. Three-layer fix: the main process now caches the last update-available payload, replays it on every page load, and exposes it via `updater:getPending` which the renderer pulls right after wiring its listeners.
- Added a one-time retry 90s after an inconclusive boot check — apps launched at login often have no network for the first seconds.

**Notifications no longer cover the update banner**
- The update banner (top:48px, z-index 9000) and the toast stack (top:62px, z-index 9998) occupied the same corner — any toast drew on top of the banner and hid the Install button. The manual update check fires a toast immediately, so the collision was guaranteed. The toast stack now repositions itself below the banner whenever the banner is visible (animated slide), and the banner's z-index was raised above the stack as a final guarantee.

## v0.1.1 (2026-06-12)

**Watch folder** — new setting "Watch stockpile folder". A daemon monitors the stockpile root recursively; any audio file dropped in (Explorer, other apps, network) gets imported into the library, fingerprinted, and auto-matched. With Auto-send on, it's filed into the matched folder automatically. Files are adopted only after their size stabilizes (copy-in-progress safe); partials (.part/.ytdl), stem outputs, and already-known paths are ignored.

**Server-side prefs** — new `prefs` table + `/prefs` endpoints. Stockpile root, auto-send, and watch-folder now live server-side, so the watcher works headlessly and **extension downloads honor Auto-send too** (previously desktop-only). Desktop mirrors its settings on boot and on change.

**Separation queue** — queue any number of tracks for stem separation; jobs run serially with all current quality toggles. New queue card on the Separator tab (status per job, remove waiting items, clear finished). History batch-select gains a **🎛 Separate** action to queue every selected track at once.

**yt-dlp self-update** — checks GitHub's latest release on boot + daily, swaps the bundled binary in place (old kept as .bak). New Settings row shows installed vs latest with a manual update button. System-wide installs are detected and left alone. Downloads stop silently dying when YouTube changes things.

**Find similar (≈)** — new ≈ button on every History row. Blends audio-fingerprint similarity (45%), mood-vector cosine (30%), BPM proximity with half/double-time equivalence (15%), and key compatibility incl. relative major/minor (10%). Missing data redistributes weight, so partially-analyzed tracks still rank. Results modal with match %, reasons, preview, and open-in-Analyzer.

**Auto-match refactor** — tag+commit logic extracted into one shared `autoMatchTrack()` used by the endpoint, the watcher, and auto-send; behavior identical, one code path.

All new UI strings translated (EN/FR verified at 411/411 key parity); new `data-i18n` applier handles static HTML labels on language switch.


## v0.1.0 (2026-06-11)

**Traduction française complète / Full French translation pass**
- Audited the entire UI for untranslated strings. The EN/FR dictionaries were in sync, but large parts of newer UI never went through the translation system at all — they were hardcoded English. Now translated (389 keys per language, verified 1:1 parity, every t() call resolves):
  - Settings page: all 12 previously-hardcoded rows (Fix file locations, Clean temp files, Auto-send, Storage breakdown, Find duplicates, Check for updates, CPU-only, Write BPM & key, Auto-clear queue, AI Engines, Diagnose paths, View logs) including descriptions, buttons, and dropdown options.
  - Storage Breakdown popup: title, subtitle, scan state, summary chips (total/tagged/free/missing/untagged-in-root), per-folder rows, and all four fix-action buttons + their confirm dialogs and notifications.
  - Auto-organize popup: every state (scanning, no folders, no untagged, none matched, results summary), selection buttons, apply progress, result toast.
  - Duplicate finder: backfill banner, group headers, KEEP/Delete labels, delete confirm, result toasts.
  - Repair review popup title + "Apply all top matches".
  - File-location repair and temp-clean confirm dialogs, progress button states, and result summaries.
  - Update check messages, diagnose "Copy to clipboard", backend-offline notices, auto-send toggle notifications, "Sent to <folder>" toast.
- Added three keys that were referenced in code but missing from both dictionaries (autoMatched, setupRequired, setupRun).
- Fixed a latent crash: the duplicate finder's row renderer used a callback parameter named `t`, shadowing the translation function — any translation lookup inside it would have thrown. Renamed.
- Language switch (Settings → EN/FR) applies to all of the above immediately; popups pick up the language when opened.


## v0.0.9 (2026-06-11)

**Mini player**
- Fixed: clicking the mini player heart tagged the track into Favorites but the heart never turned red when the track was playing through the Analyzer (mirror mode). The UI update checked `globalPlayer.track`, which is empty in mirror mode — it now resolves the displayed track the same way the click handler does.
- The heart also initializes correctly now: loading an already-favorited track into the mini player (either mode) shows a filled heart instead of an empty one until clicked.


## v0.0.8 — patch 20 (2026-06-10)

**Stem Separator**
- Fixed crash on every Direct-mode run: `cannot access local variable 'stage1_5_time'`. Four pipeline variables were only initialized inside the vocal-isolation branch; Direct mode skipped it and crashed both the final timing report and — silently — the entire stem-bleed cleanup pass ("Stem-bleed cleanup skipped"). Direct-mode runs now get bleed cleanup again.

**Stockpile / Storage**
- Storage Breakdown is now actionable: "Locate missing files" (repair scan with review), "Remove dead entries" (dry-run count, then prunes DB rows whose file is gone — never touches files), "Import untagged files" (adopts orphan audio in the stockpile root into the library, skips stem outputs, then opens Auto-organize), and a direct "Auto-organize" shortcut.
- New setting: **Auto-send to detected folder** — when a download matches a folder's artist seeds, the best match becomes the primary tag and the file is moved into `StockpileRoot/FolderName/` immediately.
- New endpoints: `POST /stockpile/adopt-orphans`, `POST /history/prune-missing`; `POST /stockpile/tracks/:id/auto-match` accepts `{commit, stockpile_root}`.
- Auto-organize now processes up to 1000 untagged tracks per pass (was 200).

**UI**
- Clicking the dimmed area outside any popup (Logs, Storage, Auto-organize, Duplicates, Diagnose, repair review, folder picker) now closes it; Esc works too. Root cause: the backdrop had `-webkit-app-region: drag`, which makes Electron swallow clicks entirely. First-run engine setup still requires explicit buttons.


## v0.0.1 — The Era of Patch 9 (current)

### Patch 13f — Improved BPM detector + stem waveforms

**BPM detector v11 — half-time / double-time correction.** v10 was a
sophisticated triple-band, dual-method detector but it had a known weak
spot: trap-style sparse patterns (kick on 1+3, snare on 3) often read as
half-time. A 140 BPM track would come back as 70 BPM. v11 keeps v10 as
the first-pass estimator and adds a correction layer on top:

- **Snare-backbeat detection** — separately detects 1.5–4 kHz onsets,
  measures inter-snare intervals. If snares fall on every backbeat, the
  inter-snare period is the half-note, so BPM is 2× the snare period.
- **Beat agreement scoring** — for each candidate (original, ×2, ÷2, ⅔,
  3/2, plus snare-derived), projects beat positions through the track and
  counts how many strong onsets land within ±50ms of projected beats. The
  candidate with the highest agreement wins.
- **Soft tempo prior** — bell curve centered at 130 BPM. 100–170 BPM gets
  a 1.15× multiplier, 85-100 / 170-185 gets 1.05×, 70-85 / 185-195 gets
  0.95×, anything outside 70–195 gets 0.85×. Pure tie-breaker for when
  beat agreement is similar between candidates.
- **Falls back to v10** if correction fails — never worse than before.

Verified on synthesized 140 BPM trap pattern: v11 correctly returns
139.7 BPM whether v10 reports 70 or 140 as its candidate. No regression
on already-correct readings.

**Stem waveforms — DAW-style.** Each stem row in the Separator now shows
a 200×36 px peak waveform. Painted once per stem on load (decoded via
WebAudio, downsampled to canvas-pixel resolution, cached). A 1px white
playhead slides across as audio plays, driven by the existing master
tick. Click anywhere on a waveform to seek to that position — all stems
sync because they share the master clock. Color-matched to the existing
stem colors (vocals red, drums orange, bass purple, etc).


**Theme: AI engines that work end-to-end on any machine.**

The current build represents a complete reimagining of how Freq.Phull's AI
features are delivered. Where earlier builds required users to download a
separate Whisper executable and manually configure paths, v0.0.1 ships an
in-app installer that pulls everything from PyPI on first launch.

### Patch 11 — Stockpile organization

**The producer's reference library, finally.** Patch 11 introduces a
two-stage tagging system that lets you organize beats by style, scene, and
mood — the way a beatmaker actually thinks. "Cali Trap" isn't a Spotify
genre; it's a vibe, a set of producers and their followers. The stockpile
tracks that vibe and recognizes new beats that match it.

**Two-stage flow.** Tag in History (cheap, reversible) — adds metadata
without touching the file. Commit to Stockpile (the existing "Send to
Stockpile" flow) — moves the file into `{stockpile_root}/{folder name}/`
on disk. Until commit, you can change tags freely.

**Style folders.** You create folders with a name, optional description,
and optional artist seeds (e.g. "Cali Trap" with seeds "Mozzy, Luh Tyj,
Sleepy Hallow"). New tracks are matched against these folders by:
- **Filename artist detection.** "Mozzy type beat 2024.mp3" → recognizes
  Mozzy → suggests Cali Trap with 85% confidence.
- **Mood centroid distance.** Each folder caches a 4-axis mood centroid
  (energy, tonality, density, tempo) computed from the tracks already
  tagged into it. A new track's mood vector gets compared to all folder
  centroids; close matches get suggested.

**Mood profile.** Every analyzed track now produces a 4-axis mood vector
in `analyze.py`'s output. Energy comes from LUFS + crest factor.
Tonality combines major/minor with spectral brightness. Density from
crest factor. Tempo position from BPM. All axes normalized to [0,1].
The vector is cached in a new `track_mood` table indexed by history_id,
so it's available for instant suggestion lookup without re-running
analysis.

**The Stockpile tab.** New sidebar nav item between History and Settings.
Shows summary cards (folders, tagged, committed, untagged), the
stockpile destination path, the style folder grid (with track counts and
seed previews), and the untagged-tracks bucket where every untagged
track gets one-click confidence-rated suggestions.

**History row tag chips.** Every history row now shows a tag strip
beneath its title. Click a chip's × to untag, click "+ Tag" to open the
tag picker showing suggestions + all folders. The tag persists in the
database; the file stays put until stockpile commit.

**Database.** Three new tables:
- `stockpile_folders` (id, name, description, artist_seeds, mood_centroid, color, track_count)
- `stockpile_tags` (history_id, folder_id, is_primary, confidence, source)
- `track_mood` (history_id → energy, tonality, density, tempo_pos, label)
Plus a migration adding `history.stockpile_committed` and `history.artists_detected`.

**Server endpoints.** Full REST surface under `/stockpile/*`:
- GET/POST/PUT/DELETE `/stockpile/folders[/{id}]`
- GET `/stockpile/folders/{id}/tracks`
- POST/DELETE `/stockpile/tracks/{historyId}/tags[/{folderId}]`
- GET `/stockpile/tracks/{historyId}/suggestions` (artist + mood scoring)
- GET `/stockpile/untagged`
- POST `/stockpile/tracks/{historyId}/commit` (the move-on-disk operation)
- POST `/stockpile/tracks/{historyId}/mood` (mood cache update)
- GET `/stockpile/summary`

`/analyze` now accepts an optional `?historyId=` query param; when
present, the analyzer auto-saves the resulting mood profile to
`track_mood` so suggestions become instant for that track.

**EN/FR i18n.** ~30 new translation keys across both languages covering
the entire stockpile surface.

### Patch 10 — Hardening, direct mode, and Ultra retune

**Brand and IP protection.** Real model identifiers — BS-RoFormer 12.97,
HTDemucs FT, HTDemucs 6s — are no longer visible anywhere in the shipped
codebase except inside a single registry module (`_phull_internal.py`)
that ships under the proprietary license. The rest of the code refers to
models only by codename (`Phull-V2`, `Phull-I4`, `Phull-I6`). User-facing
strings, progress events, history rows, and the ensemble badge all show
codenames. Anyone reverse-engineering an extracted asar archive sees
"Stage 1 model" and "Phull-V2" — they don't get a recipe to clone the
pipeline.

**Integrity verification.** Every protected file (`server.js`, `main.js`,
`preload.js`, `stems.py`, `analyze.py`, `_phull_internal.py`) is SHA-256
hashed at build time and the hashes are baked into a `manifest.sha256.json`
that ships with the app. On startup the runtime re-hashes itself and
compares. If anything's been modified, the engine layer (analyzer,
separator, transcribe) refuses to launch and the app shows a banner
explaining that build verification failed. The rest of the app stays
functional so the user has an avenue to reinstall.

**LICENSE.md added.** All-rights-reserved, no-redistribution, no-derivatives.
Explicitly addresses the underlying third-party engines so users understand
which parts are ours (the brand, the pipeline strategy, the UI, the
codename system, the ensemble configuration, the documentation) and which
are subject to upstream OSS licenses (PyTorch, openai-whisper,
audio-separator, model weights themselves).

**Direct mode (the back-vocal fix).** A new "Keep producer vocal samples
in beat" toggle on the separator panel. When checked, Stage 1 (vocal
isolation) is skipped entirely — Stage 2 runs directly on the original
track. This means producer vocal samples that are part of the beat
(ad-libs, vocal chops, sample vocals like the Lana Del Rey hook in a
sampled track) stay in the `other` stem instead of being aggressively
pulled into the lead `vocals` stem alongside the artist's voice. Direct
mode also runs significantly faster since it cuts the heaviest stage of
the pipeline.

**Ultra retune for speed.** Ultra preset's `shifts` parameter dropped from
2 to 1. The SDR delta between shifts=1 and shifts=2 is below 0.05 dB on
benchmark tracks, but the wall-clock saving is roughly halved Stage 2 time.
New ultra benchmarks at ~2.5× realtime on CPU instead of ~3-3.5×.

**Stage indicator scrubbed.** The progress card's two stage pills
previously read "Vocal isolation · BS-RoFormer" and "Instrumental split ·
Demucs". Now they just read "Vocal isolation" and "Instrumental split".

### Patch 9 — Stem mixer + speed + i18n

**The mixer.** The stem player was rewritten from a one-at-a-time A/B preview
into a real mixer. All stems play simultaneously through Web Audio API, with
per-stem mute, solo, volume, and pan controls. The audio graph routes each
HTMLAudioElement through a dedicated GainNode and StereoPannerNode before
hitting the destination, which means changes are sample-accurate and there's
no clicking or zipper noise on parameter changes. Solo logic follows industry
standard: if any stem is soloed, only soloed-and-not-muted stems are audible;
otherwise all stems play except muted ones. Stems can be reordered by
dragging their handle, which only reorders the DOM — the audio routing stays
stable so playback never stutters during a reorder. Master transport sits
above the rows: play all, pause all, stop, reset levels, and a master seek
bar that scrubs every stem in lockstep. The drag-to-DAW handle is preserved
on the right side of each row, so the existing FL Studio workflow still
works exactly as before.

**Ultra got faster.** The ultra preset previously ran BS-RoFormer with
overlap=8 and Demucs with shifts=5. On a 3-minute track that translated to
~12 minutes of CPU time (3.5× realtime). New ultra runs at overlap=4 and
shifts=2, which benchmarks show stays within 0.05 dB SDR of the previous
ultra setting while cutting wall-clock time roughly in half. Fast and high
presets were retuned at the same time:

```
fast  ≈ 1× realtime    (vocal pass overlap 2, instr overlap 0.10, shifts 0)
high  ≈ 2× realtime    (vocal pass overlap 4, instr overlap 0.25, shifts 1)
ultra ≈ 3× realtime    (vocal pass overlap 4, instr overlap 0.50, shifts 2)
```

The vocal pass (BS-RoFormer) is what dominates CPU time on most tracks, so
that's where the biggest cuts came from.

**French sweep.** Every accent that was missing got fixed: Réparer,
téléchargements, déplacés, reconnectés, liés. Phrasings that read as
machine-translated got sharpened: Chercher → Récupérer for "Fetch",
Sauvegarder → Enregistrer for "Save", sélectionné(s) → sélectionnée(s) for
agreement with "piste". 30+ keys that previously fell back to English were
added to the FR dictionary, including the entire setup modal, repair review
modal, engines status panel, diagnose modal, and logs viewer. About a dozen
inline `lang === 'fr' ? ... : ...` ternaries scattered through the renderer
were routed through the central `t()` function so future translation work
only has to touch one place.

### Patch 8k — torchaudio + smarter validation

The setup script previously installed `torch` but not `torchaudio`. Older
versions of `audio-separator` worked anyway because torchaudio came along as
a transitive dependency; newer versions declare it explicitly and crash with
`ModuleNotFoundError: No module named 'torchaudio'` if it's missing.

The fix installs `torch torchaudio` together from the same PyTorch CPU index
URL, which guarantees compatible versions. Each install step now validates
not just that the package is importable but that a real operation succeeds:
`torch.tensor([1.0]) * 2` for torch, `from audio_separator.separator import
Separator` for the separator (loading the class catches broken sub-imports
that bare `import audio_separator` misses), and `whisper.load_model` exists
and is callable. If validation passes, the install step is skipped. If it
fails, the package is reinstalled and re-verified before the marker gets
written.

The marker version was bumped to 2.0 so the server treats any v1.0 marker as
stale. Users who installed during the patch 8k window get prompted to re-run
setup, which detects that torch is already installed but torchaudio isn't,
installs just the missing piece, and writes a clean v2.0 marker.

### Patch 8j — survives client disconnects

The setup process used to die if the user closed the window during install.
The fix decouples the SSE event stream from the underlying setup process: a
`setupListeners` Set tracks active streams, a `setupState.events[]` buffer
records every status emission, and a new `/setup-status` polling endpoint
lets clients reconnect and replay events. Setup also gained a "Hide window"
button that closes the modal without killing the install, plus a new
`/setup-cancel` endpoint that signals the PowerShell process to stop
gracefully.

### Patch 8i — token coverage repair

The history repair feature uses fuzzy matching to reconnect moved files. The
original Jaccard similarity scoring weighted shared tokens equally, which
caused short distinctive tokens (artist names) to be drowned out by long
common ones ("type beat 2024 free"). The replacement is a token-coverage
score that asks "what fraction of the original filename's tokens appear in
the candidate, weighted by token rarity?" Match thresholds were retuned from
0.78/0.55 to 0.70/0.40 to compensate for the more conservative scoring.
Verified across 10 representative test cases.

### Patch 8h — Python version detection

The setup script tested for "any Python" but PyTorch CPU wheels only support
Python 3.9 through 3.12. Users with Python 3.14 hit cryptic pip errors. The
fix probes for `py -3.12`, `py -3.11`, `py -3.10`, `py -3.9` in order via
the Windows Python Launcher, falls back to whatever's on PATH if the
launcher's missing, and if nothing in range is found, downloads and silently
installs Python 3.11.9. A new `Invoke-Py` helper in PowerShell wraps every
Python invocation so the rest of the setup script doesn't have to think
about which interpreter to use.

### Patch 8g — BOM in JSON marker

PowerShell's `Out-File -Encoding utf8` writes a UTF-8 BOM. The Node server's
JSON.parse choked on it: `Unexpected token '﻿', "﻿{ "d"..."`. The fix uses
.NET's `[System.Text.UTF8Encoding]::new($false)` to write without a BOM.
Existing markers with BOMs are auto-repaired on first server boot via a
`readUtf8()` helper that strips the BOM if present, parses the JSON, and
rewrites the file clean.

### Patch 8f — Python full-path persistence

`getPythonCmd: marker has bare python cmd "python" - treating as stale`
appeared in logs whenever a user had multiple Python installs. The setup
script previously wrote `"python": "python"` to the marker but the runtime
might find a different `python` first on PATH. The fix records `sys.executable`
during setup so the marker carries the absolute path to the verified
interpreter. Server's `enginesReady()` was tightened to reject any marker
whose `python` field is just a bare command name.

### Patch 8e — the python spawn problem

Hardcoded `spawn('python')` calls were replaced with a `getPythonCmd()`
resolver that reads the engines marker and returns the absolute Python path.
Stems and analyze endpoints now both run a preflight `enginesReady()` check
and refuse to start if the marker is missing or stale, redirecting the user
to the setup modal instead of failing mid-process with a Python import error.

### Patch 8d — prebuild validation

`npm run build` was occasionally producing installers missing `bin/yt-dlp.exe`
because the `bin/` directory had been emptied during cleanup. A `prebuild.js`
script now runs as a `prebuild` npm hook and validates that every required
binary (`ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`) exists in `bin/` before
electron-builder is allowed to package. Build aborts with a clear error if
any binary is missing.

### Patch 8c — five-path bin resolver + Diagnose

The `bin()` resolver now tries five paths in order: `process.resourcesPath/bin`,
`__dirname/bin`, `__dirname/../bin`, asar-unpacked `app.asar.unpacked/bin`,
and a last-resort `app.asar/bin`. The first hit wins. Settings → Diagnose
Paths surfaces what each tool resolved to, so users can copy-paste the
results when reporting bugs. The `package.json` `asarUnpack` directive now
explicitly lists `bin/**`, `stems.py`, `analyze.py`, `key_model.pkl`, and
`installer/**` so they're physically extracted from the asar archive.

### Patch 8b — asar extraction for setup-engines.ps1

The setup script lives at `installer/setup-engines.ps1` inside the asar
archive. PowerShell can't execute scripts from inside an asar. Server now
copies the script to `%TEMP%\freqphull-setup-engines.ps1` before spawning
PowerShell, and the new `installer/**` asarUnpack directive (added in 8c)
means future builds keep it accessible directly.

### Patch 8a — non-ASCII setup script

PowerShell exit code `0xFFFD0000` was firing when the setup script contained
characters above U+007F. The script was rewritten in pure ASCII (no smart
quotes, no em-dashes, no accented characters) and validated with
`grep -cP '[^\x00-\x7F]'` returning 0. The non-ASCII content is now confined
to JSON marker contents (which use proper UTF-8 encoding) and never lives in
the script source.

---

## v0.0.1 — The Stem Separator era

**Theme: Pro-grade AI stem separation that runs locally.**

### Stem separator launch

Built a four-stage cascade ensemble in `stems.py` using the `audio-separator`
package. Stage 1 runs BS-RoFormer (`model_bs_roformer_ep_317_sdr_12.9755`)
which delivers 12.97 dB SDR on vocal isolation — better than every off-the-
shelf vocal model that existed when the build started. Stage 2 runs
htdemucs_ft (4-stem mode) or htdemucs_6s (6-stem mode) on the instrumental
output from stage 1. The chained approach means the instrumental separator
gets a cleaner input than it would on the raw track, which compounds quality.

WAV-only output (32-bit float for ultra). Quality presets: fast / high /
ultra. First-launch model download is ~1.2GB and is cached at
`~/.cache/freqphull-models` so repeat runs are instant.

### Drag-to-DAW

Stem rows expose a drag handle that, when dragged onto FL Studio (or any
file-accepting target), drops the underlying WAV directly. Implemented via
Electron's `webContents.startDrag()` with a custom canvas-rendered ghost
that shows the stem label and "Drag to DAW" hint.

### Separator history + per-file actions

Every separation run is recorded in the SQLite DB with model names, quality
preset, processing time, output directory, and stem list. The history panel
shows past runs as rows; clicking opens the output folder. Each stem row
exposes its own delete (`✕`) button. Title strings, stem labels, and meta
all flow through `escapeHtml()`.

### Stockpile + bulk move + per-file progress

Added a stockpile folder concept — a single configurable directory that
serves as the canonical home for "kept" tracks. The history view supports
multi-select with a "📦 To Stockpile" bulk action that moves selected files
in one operation, with per-file progress indicators streamed from the server
via SSE. Repair history runs on every server boot and reconnects rows whose
files were manually moved into the stockpile.

---

## Earlier — Foundation work

**Theme: Get the analyzer right before adding anything else.**

### BPM detector → key + chord detection → full analysis

Began as a BPM-only detector. `analyze.py` ran librosa on the WAV and emitted
just `{bpm: 119.2}`. From there it grew progressively:

1. **Key detection** added next using a Krumhansl-Schmuckler profile match
   against a 12-semitone chroma vector. Outputs `{key: "F#", mode: "major"}`.
   Trained a small classifier (`key_model.pkl`) on a labeled dataset to
   correct edge cases where the simple correlation was ambiguous.
2. **Camelot wheel** added on top of key — keeps producers' DJ-friendly
   notation visible alongside the raw key name.
3. **LUFS metering** added: integrated, short-term, momentary, plus loudness
   range and true peak. Used pyloudnorm. Display follows EBU R128 colors
   (green ≤ -23, amber ≤ -14, red > -10).
4. **Chord detection** added via librosa chroma → template match across all
   24 major/minor triads. Returns the time series so the analyze tab can
   show chord changes scrolling under the playhead.
5. **Pitch contour** added for melodic content. Uses pyin for monophonic
   sources, falls back to crepe for polyphonic input.

The analyzer surface settled at: BPM, KEY, LENGTH, CAMELOT, CHORDS, PITCH,
LUFS, NOTES (free-text). Analysis is auto-triggered on download and runs
in ~2-5 seconds depending on track length.

### Lyric transcription via Whisper

Built the transcribe tab around openai-whisper. Originally shipped as a
separate `Whisper.exe` that users had to download and install manually.
Whisper.exe was deprecated in patch 8 when the in-app setup-engines flow
absorbed Whisper installation into the same Python environment as the stem
separator.

Model selection (tiny / base / small / medium / large-v3), language picker
with Auto detect, copy-to-clipboard, save-to-.txt. Runs on the same Python
that drives stems, so installing one engine installs the other.

### History + repair

Every download is saved to a SQLite DB (`freqphull.db` in `%APPDATA%/freqphull`).
Schema: id, title, source URL, file path, BPM, key, length, downloaded_at,
stockpile_id (nullable). Search-as-you-type filters by title.

The repair feature scans the stockpile and downloads folder, builds an index
of every audio file, and reconnects rows whose `file path` is broken (file
moved, renamed, or on a disconnected drive). Originally used Jaccard
similarity for fuzzy matching; tuned through patches 6 and 8i to a token-
coverage scorer.

### Download queue

`yt-dlp` integration with format options (MP3 / WAV / FLAC / OGG / M4A).
Multi-track queueing with progress bars per item. Auto-analyze on completion
(toggle in Settings).

### Tools tab

Metronome (Web Audio API click track, tap-tempo input), Scale & Chord
Reference (interactive piano-roll display of any scale or chord across all
12 keys).

### i18n: French support

Built around a central `t(key)` function and a `T = { en: {...}, fr: {...} }`
dictionary. Language selector in Settings. Patch 9 was the first
comprehensive sweep that closed all the gaps and fixed accent issues.

### Branding + polish

Hood Knights © (HK) logo across all platform sizes (icon.ico for Windows,
icon.icns for macOS, icon.png for Linux, taskbar/tray variants). Custom
window chrome, glassmorphic notification panel, dark-mode-first design.

---

## v0.0.0 — The pre-release

The initial scaffolding: Electron shell, Express backend on port 47891,
SQLite via sql.js (chosen over better-sqlite3 to avoid native module rebuild
hell across Node versions), basic YouTube download via yt-dlp, ffmpeg
bundled in `bin/`. No analyzer, no separator, no transcribe — just download
and play.

This is what the BPM detector was built on top of, and the foundation that
everything else has stood on since.

---

*All work by Cynphull · Hood Knights ©*
