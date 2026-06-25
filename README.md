# Freq.Phull

[![Latest Release](https://img.shields.io/github/v/release/CodePhull/FreqPhull-realease?style=for-the-badge&color=7c3aed&label=Latest)](https://github.com/CodePhull/FreqPhull-realease/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/CodePhull/FreqPhull-realease/total?style=for-the-badge&color=22c55e)](https://github.com/CodePhull/FreqPhull-realease/releases)
[![Platform](https://img.shields.io/badge/Windows-10%2B-blue?style=for-the-badge)](https://github.com/CodePhull/FreqPhull-realease/releases/latest)

Local beat toolkit for producers. YouTube downloads, BPM/key/loudness
analysis, AI stem separation, mastering with reference matching, and a
sample library — running entirely on the user's machine.

By Cynphull, Hood Knights.

## Download

[Releases page](https://github.com/CodePhull/FreqPhull-realease/releases/latest)
→ grab `Freq.Phull-Setup-x.x.x.exe`. That's the whole install path. The
source tree on this page is only useful if you want to build it yourself.

## Features

| Tool | Purpose |
|---|---|
| Download | YouTube → MP3 / WAV / FLAC. Persistent queue, duplicate detection. |
| Analyze | BPM, key, LUFS, true-peak, crest factor, spectral balance. |
| Separator | AI stem split (vocals, drums, bass, harmonic). Optional lead/back vocal isolation, de-reverb, ensemble. |
| Mastering | Rule-based presets and reference-track EQ matching. |
| Stockpile | Library tagging into style folders with auto-matching. |
| History | Searchable, filterable by folder / favorite / untagged. |
| Transcribe | Local Whisper. Bilingual (FR + EN) for code-switching tracks. |

A companion Chrome extension downloads and analyzes tracks from
youtube.com directly, talking to the same local backend.

## Installation

1. Download the latest `Freq.Phull-Setup-x.x.x.exe` from
   [Releases](https://github.com/CodePhull/FreqPhull-realease/releases/latest).
2. Run it. The build isn't code-signed, so SmartScreen will warn — click
   **More info** → **Run anyway**.
3. First launch runs a one-time engine setup (Python + audio packages).
   Needs internet.

### If downloads or analysis fail immediately

The build bundles `yt-dlp.exe` and `ffmpeg.exe`. Defender occasionally
quarantines one of these. If the app reports "missing or blocked":

1. Open **Windows Security → Virus & threat protection → Manage settings
   → Exclusions**.
2. Add the Freq.Phull install folder.
3. Restart.

### If engine setup fails with `WinError 127` or "PyTorch can't load native libraries"

PyTorch needs the Visual C++ 2015–2022 Redistributable. The setup script
installs it automatically when missing. If it didn't:

- Re-run engine setup with **Run as administrator** (the auto-install needs
  elevation).
- Manual: install [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)
  yourself (~30 seconds), then re-run engine setup.
- Add to AV exclusions: `%LOCALAPPDATA%\Programs\Python` and
  `%USERPROFILE%\.cache`.

## Auto-updates

The app uses [electron-updater](https://www.electron.build/auto-update)
pointed at this repo's GitHub Releases. It checks on launch and offers to
download + install newer versions.

## Architecture

```
Electron shell (main.js)
 ├── Renderer (renderer/) ........ UI: tabs, mini-DAW, history, stockpile
 ├── Local backend (server.js) ... Express on 127.0.0.1:47891
 │    ├── /download .............. yt-dlp wrapper (SSE progress)
 │    ├── /analyze ............... analyze.py (BPM, key, loudness)
 │    ├── /stems ................. stems.py (AI separation)
 │    ├── /transcribe ............ whisper
 │    ├── /master ................ mastering.py (presets + ref-match EQ)
 │    ├── /stockpile/* ........... library tagging + folders
 │    ├── /history ............... SQLite via sql.js
 │    └── /events ................ SSE; live history updates
 └── Python engines .............. PyTorch + audio-separator (CPU)
```

The backend stays bound to `127.0.0.1`. Multiple clients (the desktop
window, additional windows, the Chrome extension) all talk to it. An
SSE channel keeps their History views in sync — a download finished in
the extension shows up in the desktop app without a refresh.

## Privacy

Everything runs locally. Audio files, library, and processing history
never leave the machine. Outbound traffic is limited to: fetching the
YouTube media the user asks for, the one-time engine setup (pypi), and
the update check against GitHub.

### Crash reporting

Production builds send anonymized crash reports to Sentry so we can
track and fix bugs. The reports contain error stack traces and the
app version. File paths, usernames, and YouTube URLs are scrubbed
before transmission. Audio, library content, and personal data
never leave the machine.

Requires a build with the `FREQPHULL_SENTRY_DSN` environment
variable set. For dev/test builds, set `FREQPHULL_NO_CRASH_REPORT=1`
in the environment to skip Sentry init.

## License

See [LICENSE.md](LICENSE.md). Hood Knights ©.
