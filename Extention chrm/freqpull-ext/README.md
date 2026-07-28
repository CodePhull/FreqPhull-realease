# Freq.Phull — Chrome Extension

**One-click YouTube grab + analysis, straight from your browser.** Pairs with the [Freq.Phull desktop app](https://github.com/CodePhull/FreqPhull-realease) — the extension is the front-end, the desktop is the engine.

Built by **Cynphull / Hood Knights** ©.

Current version: **4.1.2**

---

## What it does

| Feature | What it's for |
|---|---|
| **Grab from YouTube** | Click the extension icon on any YouTube page — it queues the current video for download as MP3, WAV, or FLAC. |
| **Persistent download queue** | Survives browser restarts. Duplicate detection prevents grabbing the same track twice. |
| **Live history** | Every track you've downloaded shows up in the History tab, with BPM/key analysis from the desktop. Updates the instant a download finishes — no manual refresh. |
| **Settings tab** | Configure auto-clear policy, format defaults, and the desktop backend port (default 47891). |

The extension is a **thin UI**. All the heavy lifting (download, conversion, BPM/key analysis, stem separation, mastering, stockpile) happens in the desktop app on your machine. The extension just talks to it over `localhost:47891`.

---

## Install

1. Download `freqpull-ext-v4.1.2-patch10.zip` from [Releases](https://github.com/CodePhull/FreqPhull-realease/releases).
2. Unzip somewhere permanent (e.g. `Documents\freqpull-ext\`).
3. In Chrome: `chrome://extensions/` → toggle **Developer mode** on → click **Load unpacked** → select the unzipped folder.
4. Pin the extension to your toolbar (puzzle-piece icon → pin Freq.Phull).
5. Make sure the **desktop app is running** — the extension needs the local engine on port 47891.

If the extension panel shows "Backend offline", open the desktop app first and the panel will reconnect within a few seconds.

---

## How to use

### Grab a track from YouTube

1. Open any YouTube video.
2. Click the Freq.Phull extension icon → side panel opens.
3. Pick your format (MP3 / WAV / FLAC / OGG / M4A) → click **Grab**.
4. The track downloads via the desktop engine, auto-analyzes BPM and key, and lands in your History tab.

### Watch the queue process

If you grab multiple tracks in a row, they queue up. Status badges show:
- **waiting** — in line, hasn't started yet
- **downloading** — being grabbed right now
- **done** — saved to disk, in your History
- **failed** — something went wrong, see error text; click **Load again** to retry

### History tab

Every track you've ever downloaded (from extension OR desktop) shows up here, sorted newest-first. New rows appear with a green pulse the moment a download finishes — no polling lag. Click a row to see its analysis details.

---

## Settings

- **Auto-clear download queue** — Off / 1h / 12h / 24h / 72h. Default 24h. Done-status items get removed from the queue after this window; the History tab keeps them forever.
- **Default format** — Which format gets pre-selected when you open the panel.
- **Backend port** — Only change if you've reconfigured the desktop to use a non-default port. 99% of users leave this at 47891.

---

## Troubleshooting

**Panel says "Backend offline"**
The desktop app isn't running. Open it; the extension reconnects automatically within ~5 seconds.

**Grab fails with "Cannot start yt-dlp"**
The desktop's bundled binary is missing — usually because Windows Temp got cleared (Storage Sense, CCleaner, manual delete). Close the desktop completely (check Task Manager for any `Freq.Phull.exe` processes) and reopen. The portable build re-extracts binaries on each launch.

**History tab is empty but I downloaded a track yesterday**
The History tab pulls from the desktop's database. If the desktop is offline, the tab can't show history. Open the desktop.

**Same track downloads twice**
Duplicate detection compares normalized YouTube URLs. If the track has a different video ID (e.g. you opened a re-upload), it counts as a different track. Use the queue's delete button to remove duplicates after the fact.

**Drop zone shows "Failed — Cannot start yt-dlp: spawn ... ENOENT"**
Same as the binary error above. The portable desktop's `yt-dlp.exe` is missing from its Temp unpack folder. Relaunch the desktop or reinstall using the NSIS installer (puts binaries in `C:\Program Files` where they're safe from Temp cleanup).

---

## Privacy

Everything runs locally:

- The extension talks to `http://localhost:47891` — your own machine, never an external server.
- yt-dlp talks directly to YouTube to fetch the audio stream.
- No analytics, no telemetry, no account.
- Your download history and tags live in a SQLite file in `%APPDATA%\freqphull\freqphull.db` — yours alone.

The extension requests these Chrome permissions:
- **activeTab** — to read the URL of the YouTube tab you're on
- **storage** — to remember your settings + queue across browser restarts
- **sidePanel** — to render the UI in Chrome's side panel

No host permissions beyond `localhost`.

---

## Build / hack on it

The extension is plain HTML/CSS/JS — no build step.

```
freqpull-ext/
├── manifest.json     # Chrome extension manifest v3
├── background.js     # Service worker (manages SSE connection to desktop)
├── content.js        # Injected into youtube.com for "current video" detection
├── content.css
├── panel.html        # Side panel UI
├── panel.css
├── panel.js          # All the panel logic (queue, history, settings, SSE handlers)
└── icons/            # 16/32/48/128px PNG icons
```

To iterate:

1. Edit any file.
2. Go to `chrome://extensions/` → find Freq.Phull → click the refresh icon.
3. Reopen the side panel.

Most logic lives in `panel.js`. Search for `loadHist()`, `processQueue()`, or `subscribeToEvents()` to find the main flows.

---

## Changelog

### 4.1.2 (patch 10)
- Immediate `loadHist()` call after a download finishes — new tracks appear in History the instant the download completes, no waiting for the 4-second poll tick.

### 4.1.1 (patch 9)
- Live history poll every 4s when History pane is visible (catches downloads from other extension instances / desktop windows).
- Motion design pass: spring-in for YouTube cards, hover lift on history rows, smooth tab transitions.
- `prefers-reduced-motion` guard.
- Row-pulse animation when new tracks arrive.

### 4.1.0 (patch 7-8)
- Persistent download queue (survives browser restarts).
- Duplicate detection via normalized URL match.
- Settings tab with auto-clear policy.
- Bug fix: renamed `.sn` class (was colliding with a 28px piano-key style from the older content script).

---

## License

Copyright © 2025 Cynphull / Hood Knights. All rights reserved.

This is closed-source for now — feel free to peek at the code, but don't redistribute or rebrand. If you want to integrate or contribute, open an issue.
