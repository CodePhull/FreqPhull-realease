# Freq.Phull

[![Latest Release](https://img.shields.io/github/v/release/CodePhull/FreqPhull-realease?style=for-the-badge&color=7c3aed&label=Latest)](https://github.com/CodePhull/FreqPhull-realease/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/CodePhull/FreqPhull-realease/total?style=for-the-badge&color=22c55e)](https://github.com/CodePhull/FreqPhull-realease/releases)
[![Platform](https://img.shields.io/badge/Windows-10%2B-blue?style=for-the-badge)](https://github.com/CodePhull/FreqPhull-realease/releases/latest)

**Local-first beat toolkit for music producers.** Download tracks from YouTube, analyze BPM/key/loudness, separate stems with AI, master with reference matching, organize a sample library — all running on your own machine. No subscriptions, no upload limits, no sending your audio to someone else's server.

Built by **Cynphull / Hood Knights** ©.

---

## ⬇️ Download

### 👉 **[Download the latest installer](https://github.com/CodePhull/FreqPhull-realease/releases/latest)**

Go to the **[Releases page](https://github.com/CodePhull/FreqPhull-realease/releases/latest)** and grab `Freq.Phull-Setup-x.x.x.exe`. That's all you need — don't clone the repository unless you want to build from source.

> **Heads up:** You're on the source-code page right now. The actual app is in [**Releases**](https://github.com/CodePhull/FreqPhull-realease/releases/latest) (link on the right sidebar of the repo).

---

## What it does

| Tool | What it's for |
|---|---|
| **Download** | Grab audio from a YouTube URL as MP3, WAV, or FLAC. Persistent queue with duplicate detection. |
| **Analyze** | Detect BPM, musical key, LUFS loudness, true-peak, crest factor, spectral balance. |
| **Separator** | AI stem separation — vocals, drums, bass, and harmonic instruments. Optional lead/back vocal split, de-reverb, vocal + instrumental ensemble, fullness restoration. |
| **Mastering** | Rule-based presets plus reference-track matching EQ. |
| **Stockpile** | Tag and organize your library into style folders with auto-matching. |
| **History** | Everything you've processed, searchable and filterable by folder/favorite/untagged. |

A companion **Chrome extension** lets you grab + analyze YouTube tracks straight from the browser; it talks to the same local engine.

---

## Install (end users)

1. Download `Freq.Phull-Setup-x.x.x.exe` from the [Releases page](https://github.com/CodePhull/FreqPhull-realease/releases/latest).
2. Run it. Windows SmartScreen may warn because the build isn't code-signed — click **More info → Run anyway**.
3. On first launch the app installs its AI engines (Python packages for separation/analysis). This is a one-time setup and needs an internet connection.

### If downloads or analysis fail immediately

The app bundles `yt-dlp.exe` and `ffmpeg.exe`. Windows Defender sometimes quarantines these on first run. If you see "missing or blocked" errors:

1. Open **Windows Security -> Virus & threat protection -> Manage settings -> Exclusions**.
2. Add the Freq.Phull install folder as an exclusion.
3. Restart the app.

### If AI engines setup fails with "PyTorch can't load its native libraries" or `WinError 127`

This means Windows is missing a system component that PyTorch depends on. The fix is fast:

1. Download the **Visual C++ 2015-2022 Redistributable (x64)** from Microsoft: https://aka.ms/vs/17/release/vc_redist.x64.exe
2. Run the installer (takes ~30 seconds).
3. Re-run Freq.Phull's engine setup.

If the error still appears after installing VC++ Redist, add these folders to your antivirus exclusions and retry:
- `%LOCALAPPDATA%\Programs\Python`
- `%USERPROFILE%\.cache`

---

---

## Auto-updates

The app uses [electron-updater](https://www.electron.build/auto-update) pointed at this repo's GitHub Releases. On launch it checks for a newer published release and offers to download + install it.


## Architecture

```
Electron shell (main.js)
 |- Renderer (renderer/) ........ UI: tabs, mini-DAW, history, stockpile
 |- Local backend (server.js) ... Express on 127.0.0.1:47891
 |   |- /download ............... yt-dlp wrapper (SSE progress)
 |   |- /analyze ................ analyze.py (BPM/key/loudness)
 |   |- /stems .................. stems.py (AI separation pipeline)
 |   |- /master ................. mastering.py (presets + reference match)
 |   |- /stockpile/* ............ library tagging + folders
 |   |- /history ................ processed-track DB (SQLite via sql.js)
 |   |- /events ................. SSE channel; live history updates
 |- Python engines .............. PyTorch + audio-separator (CPU)
```

The backend stays on `127.0.0.1` and is the single source of truth. Multiple clients (the desktop window, additional windows, the Chrome extension) all talk to it, and a server-sent-events channel keeps their History views in sync — a download that finishes in the extension shows up in the desktop app automatically.

---

## Privacy

Everything runs locally. Your audio files, library, and processing history never leave your machine. The only outbound network calls are: fetching YouTube media you explicitly request, the one-time engine setup, and the update check against GitHub Releases.

---

## License

See [LICENSE.md](LICENSE.md). Hood Knights (c).
