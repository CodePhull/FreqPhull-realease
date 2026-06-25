# Patch notes

Changes since the BPM detector became the foundation. Latest first.

---

## 0.4.0 (2026-06-25)

**Sentry, end-to-end verifiable**

- DSN baking via `sentry.config.json`. Drop a file next to the app with
  `{ "dsn": "..." }` and electron-builder bundles it into the build. The
  module reads it at runtime from `__dirname` or `process.resourcesPath`.
  `FREQPHULL_SENTRY_DSN` env var still works as a higher-priority
  override for dev/CI. File is gitignored.
- `sentry.config.example.json` template included as a starting point.
- Settings > Privacy: two new buttons. **Run diagnostic** shows DSN
  status (present? source? package installed? Sentry active?) and the
  last test event ID. **Send test event** fires `captureMessage` and
  awaits `flush()` so you can verify the round-trip without provoking a
  real crash.
- Server endpoints `/sentry-status` and `/sentry-test` back the buttons.
  Test endpoint stashes the most recent event ID so the diagnostic
  readout can show what was sent.

**Update window UX**

- Progress detail line: `12.3 / 87.5 MB · 3.2 MB/s · 28s left`. ETA
  computed from remaining bytes / current bytes-per-second.
- Smoother progress fill via CSS transition.
- Error state with diagnostic message and **Try again** button. The
  retry triggers a fresh `checkForUpdates()` round.
- "Download complete" confirmation line when ready to install.
- updater.js now relays `update-error` events from electron-updater
  through the same state pipe.

**Extension distribution**

Users no longer need to clone or zip-download the whole repo to install
the extension. New `POST /extension/download` endpoint:

- Fetches the latest release via GitHub API
- Finds the `freqpull-ext-*.zip` asset
- Streams it to `~/Downloads` (or `%TEMP%` as fallback)
- Returns the local path

The how-to wizard's first step now shows **Download extension zip**
as the primary action, with **Open releases page** as a small fallback.
A click on the success toast opens the containing folder.

**Engine setup**

- Disk space preflight: bails before download with a clear error if the
  user profile drive has less than 3.5 GB free. Saves the user from a
  failed install 2 GB into the torch download.
- More setup-engines.ps1 narrative comments collapsed to terse summaries
  (VC++ install block, Step 1 Python detection block, Invoke-RobustDownload
  preamble). Pure ASCII + CRLF preserved.

## 0.3.9 (2026-06-23)

- Crash reporting is now always on. The toggle was removed entirely and replaced with an informational disclosure in Settings > Privacy: what's sent (anonymized stack traces, app version), what's scrubbed (file paths, usernames, YouTube URLs), what's never sent (audio, library content, personal data). FREQPHULL_NO_CRASH_REPORT=1 still works as a dev-only escape hatch.
- Why we dropped the toggle: the toggle UI hydrated from `/prefs` which returns sql.js TEXT values as strings, and `!!"0"` is `true` in JS — so toggling off then reopening Settings would show ON. Plus a fresh install with no DB pref entry would show OFF even though the actual default was ON. The dedicated `/crash-report-pref` endpoint we added intra-version still had a stale-state edge case after the app was closed. Removing the toggle removes the bug class entirely.
- Startup migration: stale `privacy.json` from previous opt-in/opt-out builds is deleted at startup so it doesn't sit in userData forever as dead state. Plus the toggle defaulted to OFF because there was no DB pref to read while the actual state (privacy.json) said ON. Dedicated `/crash-report-pref` GET/POST endpoints now read and write `privacy.json` directly, with clean boolean responses. `user_set` flag distinguishes a default-ON state from an explicit user choice, so the first-run notice only shows when the user really hasn't decided. Toggle now snaps back to the actual persisted state if the save fails.
- Transcribe no longer auto-starts. Dropping or picking a file now stages it (shows the filename in status) and enables a Start button. User picks model + language, then clicks Start.
- Removed "powered by Whisper" from the transcribe subtitle. New copy: "Convert audio to text - runs locally, offline."
- Crash reporting default flipped to ON (opt-out). First-run shows a one-time toast disclosing it; click it to jump to Settings > Privacy and opt out. `localStorage.fph_crash_notice_seen` flag means it only fires once per renderer install.

## 0.3.8 (2026-06-22)

**Sentry crash reporting (opt-in).**

- `sentry-init.js` module shared by main, renderer, and server processes.
- Disabled by default. Enable from Settings → Privacy; opt-out via env
  var (`FREQPHULL_NO_CRASH_REPORT=1`) or by leaving the build's DSN unset.
- PII scrubber strips `C:\Users\<name>`, `/home/<name>`, `/Users/<name>`
  from `event.message`, exception values, stack frames, request URLs,
  and breadcrumbs before transmission.
- Settings UI toggle writes `privacy.json` to userData. main.js reads it
  before any child process is forked and propagates via env var so all
  three processes pick it up.
- Sentry packages are optional dependencies (`@sentry/electron`,
  `@sentry/node`) so the app builds without them. Crash reporting is
  silently inactive if the packages aren't installed.

**Soft-error reporting.**

In addition to uncaught crashes, ten soft-error sites now call
`reportSoftError(category, err, context)` when something fails without
crashing. Rate-limited at 10 events per category per hour, per process,
so a single broken machine can't burn the quota.

| Process | Category | Fires when |
|---|---|---|
| node | `bg-analyze.python-crash` | analyze.py exits non-zero with engines installed |
| node | `bg-analyze.parse-failure` | Python exits 0 but stdout isn't valid JSON |
| node | `bg-analyze.ffmpeg-failure` | ffmpeg decode step throws |
| node | `ytdlp.forbidden` | 403 after Android-client retry |
| node | `ytdlp.signature-broken` | YouTube changed signatures, retry didn't help |
| node | `setup.failed` | setup-engines exit non-zero |
| node | `transcribe.failed` | whisper crashes |
| main | `backend.crash-loop` | backend hit the 5-restart cap |
| main | `backend.fatal-startup` | __FREQPHULL_FATAL__ marker (port collision, etc) |
| renderer | `renderer.download-failed` | user sees a download error toast |
| renderer | `renderer.setup-error-shown` | user sees the setup-error modal |

Categories that aren't useful for action (geo-blocked videos, age-gated,
deleted, etc) are NOT reported.

**Installer scripts trimmed.**

- setup-engines.ps1 lost its essay-style preamble + per-step narrations.
- Sanity-verified: pure ASCII, CRLF line endings preserved.

## 0.3.7 (2026-06-22)

**Performance pass.**

- `saveDB()` debounced. sql.js holds the database in memory; every call was
  serializing the whole blob and `fs.writeFileSync`-ing it synchronously. With
  `dbRun()` calling `saveDB()` after every insert, a 5000-row library was
  writing 5+ MB to disk on every history change. Now coalesces over a 500ms
  window with a force-flush on `beforeExit` / SIGTERM / SIGINT.
- Logger buffered. `slog()` was doing `fs.existsSync(logDir)` then
  `fs.appendFileSync(logPath, ...)` synchronously per call. The existsSync is
  cached now (set once at startup), and writes batch into a 200ms flush.
  Force-flush on every exit path including uncaughtException.
- Renderer SSE deduped. The fingerprint backfill flow was opening a second
  `EventSource` to `/events`, which made the server broadcast every event to
  the same renderer twice. Reuses the main connection via a one-shot listener.

## 0.3.6 (2026-06-22)

**YouTube 403 / signature errors now auto-retry on the Android client**

- New `attachListeners(p)` factored out so the first attempt and the retry share
  the same stdout/stderr/close handling.
- Classify the failure from stderr: 403 / signature-broken → retry with
  `--extractor-args "youtube:player_client=android,web"`. Video-unavailable,
  members-only, geo, age-restricted → fatal, no retry.
- After a retry that still fails, surface a human message instead of raw
  yt-dlp stderr. Toasts on yt-dlp-related errors are clickable and jump to
  Settings → Updates with the right section auto-expanded.

**Loop icon now pixel-perfect**

The previous redraw was still stroke-based, which fights subpixel rendering at
14px on high-DPI displays (effective stroke ~1.4px, doesn't grid-align,
antialiases across two rows). Replaced with a filled silhouette at viewBox
14×14 (1:1 with rendered size), integer coordinates, no curves. Material
Design two-arrow repeat shape, crisp at any DPI and in compact mode.

---

## 0.3.5 (2026-06-22)

**Whisper tuning for fast vocals**

Six extra flags on the whisper invocation:

- `--beam_size 5 --best_of 5` — multi-candidate decoding.
- `--condition_on_previous_text False` — stops error cascades on dense lyrics.
- `--no_speech_threshold 0.3` — keeps quiet ad-libs the default 0.6 drops.
- `--word_timestamps True` — DTW alignment tightens word boundaries.
- `--hallucination_silence_threshold 2.0` — drops "thanks for watching" tails.
- `--fp16 False` — explicit for CPU compatibility.

**Bilingual mode**

New "Bilingual (FR + EN)" option in the language picker. Skips `--language` so
whisper detects per-segment, with an initial_prompt biasing toward FR+EN
hip-hop slang. Plain Auto-detect commits to one language for the whole file,
which mistranscribes code-switching tracks.

**Visible transcribe progress**

- File-size + model-RTF ETA shown up front: "Transcribing — ~3 min (model: base)".
- MM:SS elapsed timer, tabular-nums.
- Phase rotation every 15s: load model → listen → decode → align → finalize.
- Completion shows total: "Transcription complete in 2:47". EN/FR localized.

**UI cleanup**

- Dropped "Runs via OpenAI Whisper" branding; reworded to "Runs locally —
  no audio or text leaves your machine."
- Dropped four stale "AI Transcribe Setup.exe" references (HTML info-note,
  two app.js error paths, one server.js hint). All now point at
  Settings → AI engines → Re-run setup.

**Extension thumbnail fallback**

History rows can have stored `maxresdefault.jpg` URLs that 404 on non-HD
videos. New `fphThumbFallback(img)`: max → hq → mq → hide. `hqdefault.jpg`
exists for every YouTube video. Extension to 4.3.2.

**Install/setup hardening (eight bugs)**

1. Setup script `fs.copyFileSync` was unguarded against EBUSY/EACCES (AV scan,
   OneDrive, parallel instance). Bounded retry: 100ms, 250ms, 500ms, 1000ms,
   then a hint distinguishing locked-file from unwritable-tmp.
2. `tripEnginesBrokenBreaker()` now short-circuits when `setupRunning` is true.
   An in-flight worker that fails during setup with `ModuleNotFoundError` is
   expected, not signal.
3. Orphan PowerShell detection. The spawn writes a PID file; every server
   start probes the PID with `process.kill(pid, 0)` and tree-kills any live
   one from a prior crash.
4. Watchdog: if no setup event for 5 minutes, emits a "stalled" status so
   users can tell hung from slow.
5. PowerShell launch errors: ENOENT → "install PowerShell 7", EACCES →
   "AppLocker or IT policy is blocking PowerShell, try as Administrator".
6. `killSetupProcessTree()` actually shipped this time (was claimed in 0.3.4
   but never landed). `/setup-cancel` cleans up the leftover PID and tmp
   marker files.
7. Renderer `startEnginesSetup()` got a 1.5s reentrancy guard.
8. Startup sweep of stale `engines-ready.json.tmp` files older than 5 min.

---

## 0.3.4 (2026-06-21)

**Setup-failure diagnostics**

Mqxence's logs were showing `setup-engines: exit 1` with no detail. Pip output
was being piped only into the script's local log file in `%TEMP%`, never
reaching the server. Three diagnostic paths now:

- `EmitError` reads the tail of `freqphull-setup.log` and ships it in the
  error event's `log_tail`.
- Server, on any non-zero setup exit, reads the same log directly and dumps
  the last 50 lines into the server log with `[setup-log]` prefix.
- Renderer: setup-error modal has a collapsible "Show diagnostic log" with
  a "Copy to clipboard" button.

**Atomic marker write**

`engines-ready.json` was written via `WriteAllText`, which is not crash-safe.
A kill mid-write left a partial fragment that `JSON.parse` chokes on, and the
server then thought setup had failed. Now writes to `.tmp` + `Move-Item -Force`
to the final name.

**Tree kill on setup cancel**

`setupProc.kill()` only signaled PowerShell, not its python.exe / pip
grandchildren. New `killSetupProcessTree()` uses `taskkill /T /F` on Windows.

**bg-analyze pauses during setup**

`nudgeAnalysisWorker()` returns early when `setupRunning`. Without this, a
download arriving during setup would spawn analyze.py against an incomplete
Python env and trip the engines-broken breaker, showing a "deps missing"
toast while setup was visibly running.

**Pip cache poisoning recovery**

New `Invoke-PipInstall` helper: any failure auto-retries with `--no-cache-dir`.
Catches corrupt wheels in `~/.cache/pip` from a previously-broken install.

**Loop icon redraw**

Switched from 24×24 viewBox @ 14×14 stroke to 16×16 viewBox @ stroke-width
1.6. (Superseded by 0.3.6's filled-silhouette fix.)

**Fatal-marker parsing**

`msg.split('__FREQPHULL_FATAL__')[1].trim()` could pull trailing log lines
into the error dialog. Take only up to the first newline.

**Backend crash-restart cap**

Capped at 5 consecutive restarts. The 6th surfaces a dialog ("backend has
crashed 5 times in a row, possibly AV-quarantined") and exits.

**Python launcher args propagated through every spawn**

When `discoverPython()` cached `{cmd: 'py', args: ['-3']}`, the seven spawn
sites were passing the bare command without the args. Fixed at all seven.

---

## 0.3.3 (2026-06-20)

**Engines-broken breaker, widened**

The 0.3.2 patch notes claimed a Python-missing breaker but the function and
state variables were never actually defined in source (call sites would have
thrown `ReferenceError` the moment exit-9009 fired). Built for real this time.
Now covers both Python-missing and `ModuleNotFoundError` / `ImportError`.

Classifier extracts a reason + detail from any Python failure:

- exit 9009 / "Python was not found" / "Microsoft Store" → python-missing
- `ModuleNotFoundError: No module named 'X'` → deps-missing, detail=X
- `ImportError: cannot import name 'X'` → deps-missing, detail=X

`/bg-analyze/status` returns `breaker_tripped` / `breaker_reason` /
`breaker_detail`. Renderer drives a per-reason toast and a diagnostic strip
in Settings → AI engines from this.

**setup-engines.ps1: numpy preflight**

New Step 2.5 installs numpy / scipy / scikit-learn / soundfile before torch.
A clean 30-second failure when pypi is unreachable is much better than a
cryptic torch error 200 MB into a 250 MB download. Dropped `--quiet` from
all four `pip install` calls so the log captures the real error. Re-sanitized
to pure ASCII + CRLF (PowerShell parser requirement).

**Analyzer header**

Caught my own emoji-to-SVG sweep injecting SVG markup into nine
`.textContent` assignments — rendered as literal `<svg ...>` text on screen.
Rebuilt the badge as a clean array of text segments joined with a separator.
Added a runtime `textContent` guard that strips `<svg>` from any assignment
and logs a stack trace, so future regressions are loud.

**Beat-switch detector**

False positives are worse than false negatives — a flagged switch is an
authoritative claim. Six changes:

- Novelty window W=12 (was 8). Closer to verse-length scale.
- Sigma threshold 1.7 (was 1.4). Drops borderline noise.
- Minimum peak distance 30s (was 20s).
- Minimum section length 20s (was 12s).
- Require ≥2 of {BPM, key, harmony, energy, texture} to change. A single
  feature changing is a fill or a breakdown, not a switch.
- Cross-window validation: every surviving boundary gets re-tested with a
  ±25s wider lens. Single-block novelty spikes that don't replicate are noise.

New `texture` dimension catches drum-pattern shifts that leave chroma
unchanged. Common in hip-hop, missed by the chroma test alone.

---

Older entries available in git history. Earliest tracked: 0.0.8.
