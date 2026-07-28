# Patch notes

Changes since the BPM detector became the foundation. Latest first.

---

## 0.7.1 (2026-07-28)

**Release workflow fixed.** The Sentry step tested `secrets.SENTRY_DSN`
directly in its `if`, and the `secrets` context is not available there,
so GitHub rejected the whole file before running anything. The secret is
now surfaced as a job-level environment variable and the condition tests
that instead. Tag v0.7.1 and the run will go through.

**A lighter history payload.** The list endpoint selected every column,
which meant whole transcripts and every cached analysis result travelled
to the renderer on each refresh - including at boot, competing with
first paint. On a library the size of a couple of thousand tracks that
is about 3.3MB serialised, parsed and held in memory; the list now
carries only what it renders, around 1.15MB, a 65% reduction. Transcript
and cached analysis are fetched per track, when a track is opened, via
the new `GET /history/:id/full`.

**A smoother launch.**

- The opening screen animated `filter: drop-shadow`, which repaints on
  the main thread every frame - and boot is when that thread is busiest,
  so those were exactly the frames being dropped. The glow is now its
  own layer animating opacity, and the mark animates transform only.
  Both run on the compositor, off the main thread.
- The library path scan fired on the first idle gap, landing while the
  splash was still animating and the first history render was in flight.
  It is background housekeeping with no visible result, so it now waits
  until the opening is over.

**Updater window rebuilt to match the app.** It had drifted into its own
palette - a blue accent against the app's green, and shades a few steps
lighter - so it read as a different product appearing over the main
window. It now uses the app's exact tokens and its single accent, shows
the real Hood Knights mark instead of lettering, and the install
take-over pulses on the same 100 BPM grid as the opening screen. Its
progress shine animated `left`, re-running layout every frame; it now
uses a transform.

**Lite mode, for low-end machines.** Enabled automatically where there
are four cores or less, or four gigabytes of memory or less, and
available as a switch in Settings. It removes cost rather than
character: backdrop blur behind panels (our overlays already sit at 96%
opacity, so the blur was close to invisible while forcing the compositor
to re-filter everything beneath it on every frame), the largest shadows,
and the splash's decorative rings. The spectrum analyser drops to a 8192
point FFT - still finer than it shipped with for most of its life.
Layout, colour, type and animation are untouched.

## 0.7.0 (2026-07-28)

**New opening screen**

The boot splash now carries the real Hood Knights mark instead of a
drawn approximation, and it pulses on a beat grid rather than an
arbitrary sine wave. The logo moves on a kick envelope - sharp attack,
slow release - at 100 BPM, a hairline accent ring fires on every beat,
and a wider one lands on the bar line, so the loop reads as 4/4 rather
than an undifferentiated throb. A single `--bs-beat` value drives the
whole animation, so the tempo is one number to change.

- The logo is inlined as data, so the splash paints on the first frame
  with no file request behind it.
- The status line is held back 600ms: a fast boot shows the mark alone,
  and the message only appears if there is actually a wait. It carries
  the same text as the loading screen behind it, so the two can never
  disagree.
- The splash holds for at least one bar (2.6s) before dissolving. Shown
  from the first painted frame, it would otherwise appear and vanish
  within a few frames on a fast boot, which reads as a glitch. The floor
  governs the overlay only; everything behind it is already live.
- Honours `prefers-reduced-motion`: still mark, no rings.

## 0.6.9 (2026-07-28)

Idle CPU. The app used a few percent of a core while sitting there doing
nothing, which came down to loops that never stopped and a cache that
expired too eagerly.

- Two animation loops re-armed themselves at the display refresh rate
  even while playback was stopped: the timeline playhead and the mini
  player's seek bar. Neither can move while paused, so both were
  redrawing the same pixels sixty times a second. They now poll slowly
  while paused and return to animation frames the moment playback
  resumes. Because the window is created with background throttling
  disabled, this was burning CPU even while minimised - both loops now
  back off further when the window is hidden.
- Locating the Python interpreter costs several child processes and the
  answer was only cached for a minute, so anything polling the app
  re-probed every minute forever. The cache now lasts ten minutes and an
  interpreter still present on disk simply renews it. Setup, repair and
  breaker resets already clear the cache, so nothing stale can hide.
- The health endpoint is polled continuously by both the app and the
  extension and logged every single hit - thousands of lines a day and a
  permanently busy log file. Now logged once per hundred.
- A release check fails the build if any self-rearming animation loop
  loses its idle guard, or if one of their timer handles is used before
  it is declared. Fixing this section produced exactly that
  use-before-declaration fault, which would have crashed the renderer on
  load.

## 0.6.8 (2026-07-28)

A cascade failure caught in a real download session, plus its cleanup.

**The folder watcher was stealing downloads in progress.**
Downloads stage into a hidden `.fp-dl-*` directory inside the output
folder so the finished file can be renamed onto the same volume. When
that output folder sits inside the watched stockpile - downloading
straight into a category folder - the watcher saw the half-written file,
adopted it as a new track named after the video ID, and moved it out.
The download that was still running then could not find its own output,
so it failed and retried, producing duplicate entries, duplicate files
and fingerprint and tag errors reading "file not found". The watcher now
ignores staging directories entirely; the download registers its own
track when it finishes.

**Repairing one package could take out every engine.**
Repair mode runs through the same script as full setup, and the embedded
runtime provisioning came first. Repairing a single missing package on a
machine without the embedded runtime therefore provisioned a brand new,
empty Python and installed only that one package into it. Because the
embedded runtime is preferred over system Python, every engine then
failed with "No module named numpy". This is the
`selfheal.repair-ineffective` report. Two fixes: repair mode never
provisions a runtime, it repairs whatever is already in use; and the
embedded runtime is only preferred once it actually contains the
analysis stack.

**Cleanup for libraries already affected.**
Settings gains "Fix entries named after video IDs": it fetches the real
title from each affected track's source URL and renames the file to
match. The audio was never wrong, so nothing is downloaded again.

**Optimisation.** The library path scan walks every audio file under the
stockpile root - thousands of stat calls on a large library - and several
UI paths could request it simultaneously, which is why it ran twice
within half a second at startup. A clean scan is now reused for 20
seconds; anything that repairs a path invalidates it immediately.

## 0.6.7 (2026-07-28)

Follow-up to 0.6.6: the scripts are found now, but two of them were
missing dependencies nobody had ever installed.

**File tagging never had mutagen.**
`write_tags.py` needs mutagen and assumed it arrived as a transitive
dependency of audio-separator. It does not. The script reported this
correctly, but as JSON on stdout while the server only logged stderr,
so every failure looked like a blank "exited 1". Both handlers now log
stdout as well. mutagen is installed with the core numerical tier and
is part of engine verification, so machines that already ran setup pick
it up automatically through the existing self-repair at next launch.

**Fingerprinting needed librosa.**
Same story, and librosa drags in numba and llvmlite for what amounts to
one perceptual hash. Since no fingerprint has ever succeeded there are
no stored hashes to stay compatible with, so the fingerprinter is
rewritten on numpy and soundfile, which the app already installs. It
decodes through the bundled ffmpeg for formats soundfile cannot open.
Verified deterministic, and identical across an 8dB volume change.

**Sentry: a DSN in the example file is now used.**
Editing `sentry.config.example.json` instead of copying it to
`sentry.config.json` is the obvious thing to do, and it silently
produced a build with crash reporting switched off. Both the resolver
and the diagnostic now accept a real DSN from the example file, while
still rejecting the placeholder. The diagnostic reports which file the
DSN came from.

**Analysis cache visibility.**
The server log now states plainly whether opening a track was served
from cache or triggered a full analysis, and why.

## 0.6.6 (2026-07-28)

Three bugs found in a packaged-build log.

**Tags and fingerprints never worked in installed builds.**
`write_tags.py` and `fingerprint.py` were resolved to a path inside
app.asar. Node reads the archive transparently so the path looked
valid, but the Python child process cannot open it, and every call
died with "No such file or directory". BPM/key tags were never written
to any file, and no download was ever fingerprinted - which is also why
the Library doctor reported zero fingerprinted tracks. Both scripts now
ship as real files, and every Python spawn resolves through a helper
that guarantees an on-disk path, copying out of the archive when that
is the only copy. Existing libraries can catch up with the fingerprint
backfill offered by the Library doctor.

A release check now fails the build if any Python script is spawned
from an unresolved archive path or is missing from the packaged files,
so this class of bug cannot ship again.

**Engine verification crashed on every startup.**
`discoverPython()` returns a command string, and the verification code
treated it as an object, so it spawned `undefined` and threw
"The file argument must be of type string" - visible in the log as
"startup verify threw" and an unhandled rejection. Self-repair
therefore never ran and Verify engines never worked. Fixed to use the
same command/args contract as the rest of the file, with the spawn and
the endpoint both guarded so a failure can no longer surface as an
unhandled rejection.

**The extension is now offered directly, with no repository links.**
Settings > Extension leads with a Get the extension button that copies
the bundled folder into Downloads, and the install guide does the same.
Every link that sent people to the GitHub releases page has been
removed, including the fallback that opened it when a download failed.
Wording no longer mentions zips or unzipping, because neither is
involved any more.

**Opening a history track showed "analyzing..." for ten seconds.**
The track's BPM and key were already in the database the whole time.
They now appear immediately, marked as refreshing, while the full pass
fills in loudness, sections and the rest.

## 0.6.5 (2026-07-28)

The app now keeps the Chrome extension up to date.

Chrome only auto-updates extensions installed from the Web Store, and
it cannot hot-swap an unpacked extension while it is running. What it
does do is re-read an unpacked folder on startup, so the app keeps that
folder in sync and Chrome applies the change the next time it opens.

- The unpacked copy now installs to a fixed folder name. Chrome derives
  an unpacked extension's ID from its path, so a versioned folder name
  would have produced a new ID on every update and forced the user to
  add the extension again. The path is remembered in settings.
- Twenty seconds after launch, if the installed copy is older than the
  one bundled in the app, its files are refreshed in place and a
  notification reports the version change and asks for a Chrome
  restart. Silent when there is nothing to do.
- Settings > Extension shows both versions (bundled and installed) and
  has a Check now button that syncs on demand.
- Only files the extension owns are replaced; anything else the user
  left in that folder is untouched.
- New endpoints: GET /extension/status, POST /extension/update.

## 0.6.4 (2026-07-28)

The Chrome extension now ships inside the app.

- The extension source lives in the desktop repo (`extension/`) and is
  bundled into the build, so "Get the extension" no longer depends on a
  GitHub release having the right asset attached. It copies the folder
  straight into Downloads, works offline, and always matches the app
  version. Chrome's Load unpacked wants a folder rather than a zip, so
  this also removes the manual unzip step.
- `POST /extension/download` accepts `{source:'github'}` to force the
  old behaviour of fetching the newest release asset, and still falls
  back to it automatically if the bundled copy is missing.
- `GET /extension/info` reports whether a copy is bundled and which
  version.
- The release workflow now zips the extension and attaches it to the
  GitHub release automatically, so the standalone download exists for
  people who are not running the desktop app yet.
- The bundled folder is excluded from the asar archive: extraResources
  puts a real folder on disk, and recursive copies out of a virtual
  asar path are not reliable.

## 0.6.3 (2026-07-28)

French localisation audit.

- Restored accents across 109 French strings. Everything added since
  0.4.1 had been written in bare ASCII ("Evenement envoye", "Verifier
  les moteurs"), which read as broken French next to the app's original
  properly accented text.
- Fixed one grammar error the accent pass itself introduced:
  "Desactivez" (imperative) had become "Désactivéz" instead of
  "Désactivez".
- The Stockpile smart-folder button label and tooltip were hardcoded
  English and never passed through the translation layer. Now localised
  like every other control.
- Release checks now include a French quality gate: accent-less French
  vocabulary, invalid verb endings, untranslated values identical to
  English, and mismatched {placeholders} all fail the build.

## 0.6.2 (2026-07-27)

Field-testing fixes from the 0.6.1 build.

- Library doctor and smart-folder dialogs were invisible: the markup
  used a modal box class that does not exist in the stylesheet, and the
  overlay never received the inline display that activates its
  backdrop. Both now use the app's real setup-card structure.
- The file-tags and auto-rename toggles reset to off when leaving and
  reopening Settings. Saving worked; the hydration call had been
  attached inside an unrelated event handler instead of the settings
  renderer, so the checkboxes re-rendered blank. Hydration now runs on
  every settings render.
- Analysis could sit on "Running analysis engine..." indefinitely if
  the Python child hung. The server now kills the child after 180s and
  emits a proper error (with a Sentry report, category analyze.timeout),
  and the renderer has its own 200s watchdog that falls back to the JS
  BPM/key estimator and points at Verify engines.
- Library doctor with zero fingerprinted tracks now explains that
  nothing can be compared yet and offers a one-click fingerprint
  backfill, instead of reporting a meaningless "all clear - 0 tracks".

## 0.6.1 (2026-07-25)

**Real waveform in the analyzer timeline**

The section timeline now renders the track's actual waveform - min/max
peaks computed in one pass over the already-decoded audio buffer
(~1000 columns, mono mix, stride-sampled so a 10-minute WAV costs
~15ms). Painted as a pointer-events-free canvas layered over the
section colors, so scrub clicks and section tints work exactly as
before; the timeline grew from 18px to 30px so the shape reads.
Repaints on window resize (debounced) and on every new decode.

**Tag-and-forget releases (GitHub Actions)**

`.github/workflows/release.yml`: push a tag like `v0.6.2` and GitHub's
own Windows runner builds the app, fetches bundled binaries, writes the
Sentry config from a repo secret (`SENTRY_DSN` - set once in repo
Settings > Secrets > Actions), and publishes a draft release with the
installer + latest.yml + blockmap attached. No local tokens ever again.

**Extension 4.4.0**

Compatibility audit against the 0.6.x server contract passed clean (the
extension's playlist grabber already enqueues per-video URLs, so the
server's playlist-URL guard never affects it). Picked up the new
download phase field: "Converting…" label during the ffmpeg step and a
monotonic progress guard, matching the desktop queue.

**Validation**

Release checks now cover syntax on all entry points, Python AST, EN/FR
string parity, installer script byte integrity, route registration
order, and packaged file content. This round the content check caught
and removed a duplicated translation key.

**Opening a track from History is now instant**

Every open was re-running the full analysis pipeline - Python spawn
(~1s of imports alone), decode, BPM/key/loudness/beat-switch - because
the DB only stored the headline numbers. The complete analysis result
is now cached in the DB (`history.analysis_json`, keyed to the file's
mtime) and served on reopen in ~50ms: same metrics, same sections, same
timeline, zero spawn.

- Both producers write the cache: the interactive analyzer and the
  background worker.
- The cache invalidates itself when the file changes on disk (mtime
  drift > 2s) or goes missing - those cases re-analyze exactly as
  before.
- The forced beat-switch re-detect always bypasses the cache: an
  explicit re-run request means fresh computation.
- Diagnostic log says which path served the result
  ("loaded from cache (instant)" vs "running full analysis").
- Bounded by design: results are ~2-4KB each (scalars + per-30s section
  summaries, no waveforms), 400KB hard cap per row, and an LRU ceiling
  of 1500 cached rows (~5MB total). Least-recently-opened entries beyond
  the cap lose only their cache blob - the row, BPM and key stay - and
  re-cache on next open. Matters because sql.js rewrites the whole DB
  file on save; the cache can never balloon that write.

## 0.5.0 (2026-07-21)

**Live spectrum analyzer: measurement-grade pass**

- FFT 16384 (was 8192): ~2.9Hz bins. The entire 20-40Hz octave used to
  live in ~3 bins - that was the staircase at the low end.
- Both channels analyzed, combined in the power domain ((pL+pR)/2).
  Previously only LEFT was read: side-heavy content measured up to 3dB
  low and right-only elements were invisible.
- Inverse bin mapping: wide visual bins take the max over their FFT
  span; narrow (low-freq) bins interpolate between the two straddling
  FFT bins at their geometric center. Replaces the forward snap +
  copy-neighbor fill that plateaued the bass region.
- The long-average curve now does its EMA in the power domain. dB-domain
  averaging is a geometric mean of power and read several dB low on
  dynamic material.

**More accurate loading bars**

- Engine setup: trickle interpolation between step events, paced by
  per-step measured ETAs. The torch step no longer freezes the bar at
  one number for five minutes - and the trickle is capped (+8, ceiling
  97) so a genuinely stalled step visibly stalls instead of lying.
  Real events always win; the bar never moves backwards.
- Downloads: yt-dlp's percentage only ever covered the raw stream.
  Download now occupies 0-92, [ExtractAudio] raises to 96 with a
  "Converting…" phase label, done carries 100. Monotonic guard drops
  out-of-order SSE updates around the phase transition.

**Private embedded Python runtime**

Every real-world support case - multiple users, every Sentry event -
traced back to the machine's own Python: MS Store aliases, PATH damage,
incompatible versions, admin-locked installs. 0.6.0 stops depending on
it. Setup now provisions the official python.org embeddable package
(3.11.9, ~11MB, fully self-contained) into
`%LOCALAPPDATA%\freqphull\engines\python\`:

- No registry, no PATH, no admin, no installer UI.
- Nothing the user installs, uninstalls, or upgrades later can touch it.
- The `._pth` site-enable and get-pip bootstrap (the two classic
  embeddable-package traps) are handled, with the same multi-retry
  robust downloader as everything else.
- `discoverPython()` prefers the embedded runtime unconditionally when
  present. System Python probing survives only as a fallback for
  offline-first-run machines.

**Engine verification and automatic repair**

- New `verify_engines.py` import-checks every tier (core analysis /
  stems / whisper) with native-lib smoke tests (torch tensor op catches
  missing VC++ DLLs that plain import misses), and reports the exact
  pip packages that are broken.
- `setup-engines.ps1 -Repair -Packages a,b` force-reinstalls precisely
  those packages (`--force-reinstall --no-cache-dir`), reusing every
  hardening lesson in the script. Repair refreshes the ready marker's
  `last_repair` date but never creates the marker - only full setup may
  claim readiness.
- 15 seconds after boot, if engines were ever set up, the server
  verifies them and silently repairs anything broken. The user whose
  install worked yesterday and got AV-quarantined overnight is fixed
  before they notice. At most one automatic attempt per session; a
  quiet toast on start, a green one on success - only failure is loud.
- Settings gains **Verify engines**: on-demand deep check with a
  one-click repair offer when something is broken.
- New Sentry categories `selfheal.repair-failed` and
  `selfheal.repair-ineffective` so unfixable machines surface remotely
  with the package list attached.


**Richer crash-report payloads**

Every soft-error event gains a `machine` context (OS release, arch, CPU
model + cores, total/free RAM, process uptime) and clean grouping -
events fingerprint by category, so five different exit codes make one
`setup.failed` issue with five events, not five issues.

Per-category payloads:

- `ytdlp.*` - yt-dlp version (cached `--version`), format, URL kind
  (bare video vs video-in-playlist). Answers "stale binary?" instantly.
- `bg-analyze.python-crash` - exit code, file extension + size,
  duration, classifier verdict, last 1200 chars of stderr.
- `bg-analyze.parse-failure` - stdout AND stderr tails, file extension.
- `bg-analyze.ffmpeg-failure` - file extension, size, exists-on-disk.
- `transcribe.failed` - model, language, upload size (whisper's stderr
  already rides in the exception message via run()).
- `backend.crash-loop` / `fatal-startup` - packaged flag, uptime,
  userData drive letter.

**setup.failed events now include the setup log**

First real-world Sentry event exposed a blind spot: the `setup.failed`
soft report only attached `stderrTail`, but setup-engines.ps1 writes
its diagnostics to `%TEMP%\freqphull-setup.log`, not stderr - so remote
events arrived saying "exit 1" and nothing else. The handler now reads
the log tail once and attaches it to the event (`setupLogTail`, last
~1800 chars, PII-scrubbed like everything else), along with the exit
code. The same read feeds the in-app diagnostic modal, replacing a
duplicate file read.


**Bulk download filename collisions eliminated**

0.4.3's staging directories fixed cross-download races, but filenames
inside staging were still title-derived (`%(title)s.%(ext)s`) - yt-dlp's
title sanitization was the collision source. Downloads are now staged as
`%(id)s.%(ext)s`: video IDs are unique by definition, so two tracks can
never fight over a filename no matter what they're called. The human-
readable name is applied at promote time from fetched metadata, through
a Windows-safe sanitizer (illegal chars, trailing dots, 150-char cap).

**Playlist URLs handled properly**

yt-dlp silently ignores `--no-playlist` on playlist-only URLs (no `v=`
component) - one of those would have dumped the entire playlist into a
single staging dir, recreating the collision bug. Three layers now:

- `/info` detects playlist-only URLs and expands them via
  `--flat-playlist --dump-single-json` (one fast metadata pass, capped
  at 500 entries).
- The renderer queues every entry as its own download - paste a
  playlist URL into the Download tab and the whole thing queues, each
  track through its own isolated staging pipeline. Re-pasting skips
  tracks already queued.
- `/download` rejects playlist-only URLs outright (`playlist_url` code),
  and a leak guard refuses to promote when staging somehow contains
  more than one audio file - with a Sentry soft-report
  (`download.playlist-leak`) so we hear about it.

Note for existing libraries: these fixes prevent NEW corruption. Files
damaged before 0.4.3 are still on disk - run Settings > Library doctor
to find and re-download them.


**Library doctor**

Settings > tools row: scans the library for rows sharing near-identical
audio (hamming <= 25 bits) under DIFFERENT titles - the damage signature
of the pre-0.4.3 bulk-download bug. The oldest row in a group is the
presumed owner of the audio; newer rows with other titles are suspects.
Each suspect gets a one-click **Re-download**: fetches the correct audio
from the row's own youtube_url into the same folder (through the normal
download pipeline, so it's analyzed and fingerprinted like anything
else), then removes the corrupted row. `GET /history/doctor` backs it.

**Timeline scrubber + live playhead**

The section timeline in Analyze is now a real transport control: click
anywhere to seek proportionally (per-section clicks still snap to
section starts), with a live playhead line tracking playback via rAF -
self-terminating when the markup leaves the DOM. Tracks with no beat
switch detected get a plain scrub bar with the same mechanics, so every
analyzed track is seekable from the timeline.

**Auto-rename with BPM/key**

New opt-in setting: after analysis, files are renamed to
`Title [140BPM Cm].ext`. Skips files already stamped (`[..BPM..]` in the
name), skips locked files (EBUSY/EPERM - open in a DAW), collision-safe,
updates the DB path, broadcasts history-changed so every window updates.
Off by default.
The existing write-tags feature also gained a proper Settings toggle
(both backed by `GET/POST /file-tags-pref` writing settings.json).

**Smart folders**

Stockpile gained rules-based folders: name + BPM range + key + mode,
stored as JSON in a new `stockpile_folders.smart_rules` column
(guarded migration). The folder tracks endpoint evaluates rules live
against history, so a smart folder never goes stale - a new 142 BPM
minor-key download appears in "Dark trap 130-150" the moment analysis
lands. Created via the ⚡ Smart button next to New folder.

## 0.4.3 (2026-07-11)

**Bulk download corruption fixed (wrong audio under the right name)**

Parallel/playlist grabs could pair track B's title with track A's audio.
Root cause: yt-dlp wrote `%(title)s.%(ext)s` into the shared output
folder, and when a second download's sanitized title collided with an
existing file, yt-dlp skipped the download ("already downloaded") and
reported the first file's path — so the second history row pointed at
the first track's audio. Fix: every download now runs in its own
`.fp-dl-*` staging subdirectory (collisions impossible), then the file
is promoted into the output folder with a collision-safe rename
(`name (2).mp3`, `name (3).mp3`, ...). Stale staging dirs from crashed
runs are swept after 1 hour. Failure paths clean up their staging dir.

**v0.4.1 CSS actually shipped this time**

The 0.4.1/0.4.2 stylesheet block (context menu, toast count badge,
clipboard paste hint) silently missed its injection anchor and never
landed — which is why the FR download page showed the paste hint as raw
unstyled text crashing into the Fetch button. All of it is now in the
main stylesheet, and the paste hint is absolutely positioned below the
URL row instead of inline (no more overlap in either language).

**Boot splash**

The window now paints instantly with a pulsing HK monogram on a dark
background (pure inline SVG — zero asset dependencies) instead of a
black screen while the backend boots. Dissolves when app-ready fires.
BrowserWindow gets `backgroundColor:#0b0b0b` so there is no white flash
before first paint. Splash animation honors `prefers-reduced-motion`.

**Accessibility**

- `:focus-visible` outlines for keyboard users (mouse clicks stay clean).
- `prefers-reduced-motion: reduce` disables all decorative animation
  app-wide, including the splash pulse.
- 21 icon-only buttons had their `title` mirrored into `aria-label`;
  6 more (window chrome, play, separator controls) got explicit labels.
- History context menu is keyboard navigable: arrows move, Enter
  activates, Esc closes.
- Toasts announce via per-element aria-live (asserted errors, polite rest).

**Performance**

- History search debounced 120ms — typing a 9-char query is now 1-2
  renders instead of 9.
- `content-visibility:auto` on history rows: the browser skips layout
  and paint for offscreen rows entirely. Biggest win on 1000+ track
  libraries.
- `will-change` on progress fills and toasts so they composite on the
  GPU instead of relayouting.

## 0.4.2 (2026-06-25)

Sentry test reliability fix.

- The test button was sending `captureMessage('info')`, which Sentry
  silently hides from the default Issues view. Events arrived but
  weren't visible unless you knew to look in Discover / All Events.
  Now sends a real `captureException(new Error(...))` at error level,
  tagged `test:true`. Lands in Issues immediately.
- Diagnostic readout now shows DSN host + project ID extracted from
  the configured DSN. Use these to verify you're checking the right
  Sentry project (most "test sent but I see nothing" reports are wrong-
  project mismatches).
- `flush()` timeout is now 4s (was 2s) and the result is surfaced. If
  the event was queued but delivery wasn't confirmed (firewall etc.),
  the toast says "queued — check Sentry in 1-2 min" instead of claiming
  it sent.

## 0.4.1 (2026-06-25)

UX polish pass — no design changes, just things that should have been there.

**Keyboard shortcuts.** `/` and `Ctrl+F` focus the visible search input.
`Esc` closes any open modal, and if no modal is open, clears the focused
search input. `Ctrl+1` through `Ctrl+9` switch tabs (analyze, transcribe,
separator, master, history, stockpile, settings).

**History search wrapper.** The search input now sits in a relative
container with a result counter (`5 / 142` on the right of the field
while searching) and an `×` clear button. Both hide when the search is
empty. The native `::-webkit-search-cancel-button` is masked so we have
one consistent control instead of two competing ones.

**Right-click context menu on history rows.** Eight actions: Open in
Analyze, Send to Stem Separator, Send to Transcribe, Favorite/Unfavorite,
Copy title, Copy source URL, Show in folder, Remove from history.
Auto-dismisses on scroll, resize, outside click, or Esc.

**Clipboard URL paste suggestion.** When the URL input gets focused
and (a) it's empty AND (b) the clipboard contains a YouTube URL, an
inline hint appears below the input with a one-click `Paste` button.
Recognizes youtube.com/watch, /playlist, /shorts, /embed, and youtu.be.
Auto-dismisses after 8 seconds.

**Toast deduplication.** Identical toasts now stack into a single
notification with a `×N` counter badge instead of cluttering the corner.
The timer resets each time so you can see when the latest one fired,
and a brief scale-pulse signals the bump. Fixes the screenshot-of-four-
identical-errors case.

**Extension download 404 redirect.** When `/extension/download` returns
404 (no extension asset attached to the latest release yet), the app
now opens the releases page automatically with an info toast — instead
of just showing a red error. Releases need an attached
`freqpull-ext-vX.X.X.zip` to enable the one-click download path.

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
