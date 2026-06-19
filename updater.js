// ── Auto-updater ────────────────────────────────────────────────────────────
//
// Backed by electron-updater, pointed at the public GitHub Releases page
// for CodePhull/FreqPhull-realease. The `publish` block in package.json
// also points here so the same config drives BOTH directions:
//   • At RELEASE time, electron-builder uploads to that repo (manually for
//     now — we drag the .exe + .yml in. Could automate later via GH Action.)
//   • At RUN time, the installed app checks the same repo for newer versions.
//
// Flow shown to the user:
//   1. On startup + every 4 hours, silently check for updates
//   2. If newer version found → IPC to renderer: 'update-available' with version + notes
//   3. Renderer shows a banner: "Update available — Install / Later"
//   4. If user clicks Install, IPC 'update-download-start' → updater downloads
//      in background, sending progress via 'update-download-progress'
//   5. When done → 'update-downloaded' → banner becomes "Restart to install"
//   6. User clicks Restart → app quits + installer runs + relaunch
//
// All paths are best-effort: a failed update check NEVER blocks app usage.
// All errors logged to the main process log file but never thrown to the user.

const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

let mainLog = console.log;     // overridden via setLog()
let mainWin = null;            // overridden via setWindow()
let manualCheckInProgress = false;
// Last 'update-available' payload. IPC events fired before the renderer's
// listeners attach are simply LOST — that's the "no update detected at
// launch" bug: the 8s boot check could beat slow renderer boots (engine
// setup, first-run, cold disk) and its event evaporated. We cache the
// payload, replay it on every did-finish-load, and expose it via
// updater:getPending so the renderer can also pull it on demand.
let lastAvailableInfo = null;
let bootCheckGotResult = false;

function send(channel, payload) {
  // Renderer might not exist yet (tray-launched) or might be destroyed.
  // Guard every send so a missing window doesn't crash anything.
  if (mainWin && !mainWin.isDestroyed() && mainWin.webContents) {
    try { mainWin.webContents.send(channel, payload); } catch {}
  }
  // v0.2.8: also forward to the branded updater window if open.
  try { bridgeToUpdaterWindow(channel, payload); } catch {}
}

// Translate the autoUpdater IPC channels into the dedicated updater
// window's state vocabulary (checking/none/available/downloading/ready)
// and push directly to the updater window. Decoupled from the main
// renderer's banner so the two UIs can coexist.
function bridgeToUpdaterWindow(channel, payload) {
  const { BrowserWindow, app } = require('electron');
  const installed = app.getVersion();
  let phase = null;
  let extra = {};
  if (channel === 'checking-for-update') phase = 'checking';
  else if (channel === 'update-available') {
    phase = 'available';
    extra.update = (payload && payload.version) || '?';
    let notes = (payload && payload.releaseNotes) || '';
    if (typeof notes === 'string') {
      const items = notes.split(/\r?\n/).map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean).slice(0, 12);
      extra.notes = items.length ? items : [notes];
    } else if (Array.isArray(notes)) {
      extra.notes = notes.flat().map(n => (n && n.note) || n).filter(Boolean).slice(0, 12);
    }
  }
  else if (channel === 'update-not-available') { phase = 'none'; extra.update = installed; }
  else if (channel === 'download-progress') {
    phase = 'downloading';
    extra.progress = (payload && payload.percent) || 0;
    extra.speed = (payload && payload.bytesPerSecond) || 0;
  }
  else if (channel === 'update-downloaded') {
    phase = 'ready';
    extra.update = (payload && payload.version) || '?';
  }
  if (phase === null) return;
  const state = Object.assign({ installed, phase }, extra);
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed() && w.webContents) {
        const url = w.webContents.getURL();
        if (url && url.indexOf('updater.html') !== -1) {
          w.webContents.send('updater-state', state);
        }
      }
    } catch {}
  }
}

function setupUpdater(opts) {
  if (opts && opts.log) mainLog = opts.log;
  if (opts && opts.win) mainWin = opts.win;

  // Don't run in dev/unpackaged mode — there's nothing to update.
  // electron-updater would throw on missing app-update.yml otherwise.
  if (!require('electron').app.isPackaged) {
    mainLog('[updater] dev mode — skipping auto-update setup');
    // Still register IPC handlers so renderer doesn't break on missing
    // channels. They just respond with "not available".
    ipcMain.handle('updater:check', () => ({ available: false, reason: 'dev' }));
    ipcMain.handle('updater:download', () => ({ ok: false, reason: 'dev' }));
    ipcMain.handle('updater:install', () => ({ ok: false, reason: 'dev' }));
    ipcMain.handle('updater:getStatus', () => ({ status: 'dev' }));
    return;
  }

  autoUpdater.logger = {
    info:  (msg) => mainLog('[updater] ' + msg),
    warn:  (msg) => mainLog('[updater][warn] ' + msg),
    error: (msg) => mainLog('[updater][err] ' + msg),
    debug: (msg) => {} // too noisy
  };

  // We control the download manually — the user clicks "Install" to trigger.
  // Auto-downloading without consent is bad UX on a CPU/IO/bandwidth sensitive
  // app like this one (separator running, download in flight, etc.).
  autoUpdater.autoDownload = false;
  // After download, we DON'T auto-install — the user clicks "Restart".
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Event wiring → renderer IPC ──────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    send('update-checking', {});
  });
  autoUpdater.on('update-available', (info) => {
    mainLog('[updater] update available: ' + info.version);
    bootCheckGotResult = true;
    lastAvailableInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes || '',
      releaseName: info.releaseName || ('Freq.Phull ' + info.version)
    };
    send('update-available', lastAvailableInfo);
  });
  autoUpdater.on('update-not-available', (info) => {
    bootCheckGotResult = true;
    lastAvailableInfo = null;
    mainLog('[updater] up to date: ' + (info && info.version));
    send('update-not-available', { version: info && info.version });
    manualCheckInProgress = false;
  });
  autoUpdater.on('error', (err) => {
    mainLog('[updater][err] ' + (err && err.message));
    send('update-error', { message: (err && err.message) || 'Unknown updater error' });
    manualCheckInProgress = false;
  });
  autoUpdater.on('download-progress', (p) => {
    // p has .percent (0-100), .transferred, .total, .bytesPerSecond
    send('update-download-progress', {
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    mainLog('[updater] downloaded: ' + info.version);
    send('update-downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  // ── IPC from renderer ────────────────────────────────────────────────────
  ipcMain.handle('updater:check', async () => {
    try {
      manualCheckInProgress = true;
      const result = await autoUpdater.checkForUpdates();
      // result.updateInfo.version is what was found; the events above
      // also fire so the renderer sees the same info.
      return {
        ok: true,
        version: result && result.updateInfo && result.updateInfo.version
      };
    } catch (e) {
      mainLog('[updater] manual check failed: ' + e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('updater:download', async () => {
    try {
      // Triggers the actual file download. Progress events flow via the
      // wiring above. Returns once download is fully complete OR errors.
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      mainLog('[updater] download failed: ' + e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('updater:install', () => {
    // Quits + installs + restarts. Set isSilent=false so the NSIS installer
    // window shows briefly (helpful for users to know what's happening).
    // Set isForceRunAfter=true so app comes back up automatically.
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (e) {
      mainLog('[updater] install failed: ' + e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('updater:getStatus', () => {
    return {
      currentVersion: require('electron').app.getVersion(),
      autoDownload: autoUpdater.autoDownload,
      pendingUpdate: lastAvailableInfo
    };
  });
  // Pull-based fallback: the renderer asks "did a check already find
  // something before my listeners attached?" — used right after
  // _setupUpdater wires its event handlers.
  ipcMain.handle('updater:getPending', () => lastAvailableInfo);

  // Replay the cached event whenever the page (re)loads. Covers manual
  // reloads, slow first paints, and any future multi-window setups.
  if (mainWin && mainWin.webContents) {
    mainWin.webContents.on('did-finish-load', () => {
      if (lastAvailableInfo) {
        mainLog('[updater] replaying cached update-available to renderer');
        send('update-available', lastAvailableInfo);
      }
    });
  }

  // ── Background checks ────────────────────────────────────────────────────
  // First check: 8s after app ready. Long enough for backend to start, the
  // user has visually seen the app load, and any first-launch onboarding is
  // out of the way. We don't want the update banner racing the loading screen.
  //
  // The "No published versions on GitHub" error is EXPECTED in early
  // development before any real release is published. We treat it as
  // info-level (verbose log only) instead of error-level so the logs
  // don't fill up with red flags for a non-problem. Same for the interval
  // check below. All other errors still log as errors.
  const isNoReleasesError = (e) =>
    e && e.message && /no published versions/i.test(e.message);
  // v0.2.8: boot check fires SOONER (1500ms vs 8s) so users see the
  // update prompt almost immediately on launch. A 'checking' event is
  // also sent to the renderer for a brief status indicator so it's
  // visible that we're checking — silent boot was confusing users.
  setTimeout(() => {
    send('checking-for-update', { source: 'boot' });
    autoUpdater.checkForUpdates().catch(e => {
      if (isNoReleasesError(e)) {
        mainLog('[updater] no releases published yet (expected during dev)');
      } else {
        mainLog('[updater] startup check failed: ' + e.message);
      }
    });
    // Retry once at 90s if the first check inconclusive (login-time
    // network unreachable, DNS hiccup).
    setTimeout(() => {
      if (bootCheckGotResult) return;
      mainLog('[updater] boot check inconclusive — retrying once');
      send('checking-for-update', { source: 'retry' });
      autoUpdater.checkForUpdates().catch(e => {
        if (!isNoReleasesError(e)) mainLog('[updater] retry check failed: ' + e.message);
      });
    }, 90000);
  }, 1500);

  // Subsequent checks: every 4 hours while running. Long-running sessions
  // (people leave the app open all day) will pick up new releases without
  // needing a restart. 4h is short enough to feel responsive, long enough
  // to not hammer GitHub's rate limits.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(e => {
      if (isNoReleasesError(e)) {
        // Don't log on every interval — would spam ~6 messages/day.
        // The startup log already captured this state.
        return;
      }
      mainLog('[updater] interval check failed: ' + e.message);
    });
  }, 4 * 60 * 60 * 1000);
}

module.exports = { setupUpdater };
