# Freq.Phull — Patch Notes

> Cynphull · Hood Knights ©
> Solo-developed by Cynphull

A chronological record of every significant change since the BPM detector
became the foundation. Each entry covers what shipped, why, and what broke
along the way.

---

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
