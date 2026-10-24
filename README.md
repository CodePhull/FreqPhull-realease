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
| Convert | Batch convert audio or video files to MP3, WAV, FLAC, AIFF, ALAC, M4A, MP4, OGG or Opus. |

A companion Chrome extension downloads and analyzes tracks from
youtube.com directly, talking to the same local backend.

## What's new in 0.7.43

0.7.42 was published on 24 Oct with a packaging mistake: its background server could not start, so nothing worked. 0.7.43 fixes that and includes everything below. If you are on 0.7.42, the update is offered when the app opens.


**Security fixes**
- While Freq.Phull was running, a website open in your browser could talk to the app's local server and read files from your PC. That's now blocked: only the app itself and the Freq.Phull extension can use it. Update as soon as you can.
- A YouTube video with a specially crafted title could run code inside the app. Titles are now always shown as plain text.

**YouTube downloads**
- Fewer "HTTP 403" failures: the app now sets up the helper YouTube needs (Deno) by itself, once, in the background. Settings shows whether it's ready.
- yt-dlp updates now stick after the app updates, and every download of it is checked before use.

**Fixes**
- The AI engine repair could fail on every launch on some PCs. It now repairs the right packages together.
- Installing an update while Freq.Phull is open (or in the tray) no longer fails; the installer closes it first.
- Stem separation now shows BPM and key for each stem (that part had never worked).
- "Send to Stem Separator" and "Send to Transcribe" in the right-click menu now actually work, and a transcript is saved onto the right track.
- Ctrl+1 to Ctrl+9 now switch tabs.
- When a track's file had moved or been deleted, the app could silently point it at a different song at startup. It now only relinks a file when it's sure, and asks you about the rest.
- Opening a track in the Analyzer again is instant: it used to be fully re-analysed every time (about 10 seconds).
- An older Freq.Phull no longer swaps your browser extension back to an older version.
- Stockpile now recognises artist names with accents (Drakéo, Zoé…) when sorting tracks into folders.
- With shuffle on, the previous-track button now goes back to the track you just heard, instead of jumping to another one. Next is still random.
- Memory no longer climbs when the app plays for hours (it could pass 2 GB overnight). Every track you played stayed in memory while the Analyzer tab was hidden.
- The app no longer fills your disk with temporary WAV copies (one per track played; we found 19 GB on one PC). Old ones are cleaned up automatically.

**New**
- Your library is saved in your Stockpile folder too. After a reinstall or on a new PC, Freq.Phull finds it and offers to restore your tracks, folders, BPM/key, notes and favorites. A Stockpile folder from an older version can be rebuilt from its folders. Also in Settings → Restore library.
- Right-click a track → **Buy this beat**: opens the producer's store link from the YouTube description (BeatStars, Airbit, their own site…), so you can buy the beat and credit the beatmaker.
- Right-click a track → **About the beatmaker**: the producer's Instagram, TikTok, store and other links from the description (also handles written without a link, like "Instagram: @name"), plus a "copy credit" button.
- Convert → **MP4 video**: turn tracks into videos with a background picture of your choice, in YouTube, square or vertical (TikTok, Reels, Shorts) size.
- Right-click a track in History or Stockpile → Send to Convert. In History's select mode, Convert sends several at once.
- Settings → Report a problem: describe what went wrong and send it, with the app log if you want.
- History opens and scrolls much faster on big libraries.
- The app is now fully in French when French is chosen (the Convert, Transcribe and Tools tabs, pop-up messages, tooltips and key names were partly English), with accents and wording corrected.

**Error reports**
- Errors in the app, the downloader, the engines and the Chrome extension are now reported, so problems get fixed faster.
- Reports no longer include your computer's name. IP addresses, YouTube links, e-mail addresses and your Windows user name are filtered out before anything is sent.

**Extension 4.6.0**
- Reports its errors through the app, and shows video titles safely.

## What's new in 0.7.41

**New: Convert tab**
- Convert audio files to MP3, WAV, FLAC, AIFF, ALAC, M4A, MP4, OGG or Opus.
- Video files work too (MP4, MOV, MKV, WEBM). The audio gets pulled out.
- Pick the bitrate or bit depth, the sample rate, and stereo or mono.
- Converted files go in a `Converted` folder next to the original, or in any folder you choose. Nothing gets overwritten.
- Drop in as many files as you want. You can cancel at any time.

**YouTube download fixes**
- "Please sign in" errors used to show raw error text. Now the app tells you what happened, and the download retries once by itself.
- Some videos really do need a signed-in YouTube account, and those still can't be downloaded.
- Fixed tags not being saved on downloaded files.

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

Production builds send error reports to Sentry so bugs can be found and
fixed. That covers crashes and any error the app or the Chrome extension
shows you (a failed download, conversion or analysis).

A report contains the error message, where in the code it happened, the
app version, Windows version, CPU/RAM, and a random install ID that isn't
tied to you. Before anything is sent, the app removes:

- your computer's name and your Windows user name;
- IP addresses (and tells Sentry not to record one);
- YouTube links and video IDs, other web addresses, and e-mail addresses;
- cookies and request headers.

Audio, your library and your files never leave the machine. The
extension sends its errors only to the Freq.Phull app on your own PC,
which filters them the same way.

Requires a build with the `FREQPHULL_SENTRY_DSN` environment
variable set. For dev/test builds, set `FREQPHULL_NO_CRASH_REPORT=1`
in the environment to skip Sentry init.

## License

See [LICENSE.md](LICENSE.md). Hood Knights ©.
