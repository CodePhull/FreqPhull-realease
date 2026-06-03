# Freq.Phull

**Local-first beat toolkit for music producers.** Download tracks from YouTube, analyze BPM/key/loudness, separate stems with AI, master with reference matching, organize a sample library — all running on your own machine. No subscriptions, no upload limits, no sending your audio to someone else's server.

Built by **Cynphull / Hood Knights** ©.

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

1. Download the latest `Freq.Phull-Setup-x.x.x.exe` from the [Releases](https://github.com/CodePhull/FreqPhull-realease/releases) page.
2. Run it. Windows SmartScreen may warn because the build isn't code-signed — click **More info -> Run anyway**.
3. On first launch the app installs its AI engines (Python packages for separation/analysis). This is a one-time setup and needs an internet connection.

### If downloads or analysis fail immediately

The app bundles `yt-dlp.exe` and `ffmpeg.exe`. Windows Defender sometimes quarantines these on first run. If you see "missing or blocked" errors:

1. Open **Windows Security -> Virus & threat protection -> Manage settings -> Exclusions**.
2. Add the Freq.Phull install folder as an exclusion.
3. Restart the app.

---

## Build from source (developers)

### Requirements

- **Node.js 18.x** (project tested on 18.18.2)
- **Python 3.11** on PATH (for the analysis/separation engines)
- Windows x64 (the build targets NSIS + portable for Windows)

### Steps

```bash
git clone https://github.com/CodePhull/FreqPhull-realease.git
cd FreqPhull-realease
npm install
npm run build          # NSIS installer + portable, output in dist/
```

Other scripts:

```bash
npm start              # run in dev (electron .)
npm run build-portable # portable .exe only
npm run check          # run prebuild integrity checks
```

The bundled binaries (`bin/yt-dlp.exe`, `bin/ffmpeg.exe`) are not committed to the repo. Run `Download-Binaries.bat` to fetch them before building, or place your own copies in `bin/`.

---

## Auto-updates

The app uses [electron-updater](https://www.electron.build/auto-update) pointed at this repo's GitHub Releases. On launch it checks for a newer published release and offers to download + install it.

### Publishing a new release (maintainers)

1. Bump `"version"` in `package.json`.
2. Create a GitHub Personal Access Token with `repo` scope: https://github.com/settings/tokens
3. Set it as an environment variable:
   ```powershell
   [Environment]::SetEnvironmentVariable("GH_TOKEN", "ghp_your_token", "User")
   ```
   Restart your terminal so the variable is picked up.
4. Build + publish:
   ```bash
   npx electron-builder --win --x64 --publish always
   ```

This uploads the installer, its `.blockmap`, and `latest.yml` to a new GitHub release. `latest.yml` is the file electron-updater reads to detect updates — without it, auto-update won't work.

> **Note:** the repo name keeps the original `FreqPhull-realease` spelling. The `publish` block in `package.json` must match it exactly.

---

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
