# Freq.Phull — Patch Notes

> Cynphull · Hood Knights ©
> Solo-developed by Cynphull

A chronological record of every significant change since the BPM detector
became the foundation. Each entry covers what shipped, why, and what broke
along the way.

---

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
