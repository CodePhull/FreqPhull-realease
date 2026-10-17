const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Tray, Menu, nativeImage, clipboard } = require('electron');

// Inspect Element / DevTools are off in installed builds. Running from
// source (npm start) keeps them; a packaged build can turn them back on for
// support with FREQPHULL_DEVTOOLS=1 in the environment.
const DEVTOOLS_ALLOWED = !app.isPackaged || process.env.FREQPHULL_DEVTOOLS === '1';
const path  = require('path');
const fs    = require('fs');
const { fork } = require('child_process');
const { setupUpdater } = require('./updater.js');
const sentry = require('./sentry-init.js');

// One-time cleanup: earlier builds wrote a privacy.json with the
// opt-out toggle state. It's no longer consulted; remove the leftover.
try {
  const stale = path.join(app.getPath('userData'), 'privacy.json');
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
} catch {}

// ── Boot flags ────────────────────────────────────────────────────────────────────────────────
// Settings that Electron only reads once, at startup - hardware
// acceleration chief among them - can't be toggled live. The renderer's
// switch just persists the choice here and asks for a relaunch; this
// file is read back synchronously below, before app is ready, which is
// the only point Electron will actually honor disableHardwareAcceleration().
// The renderer (preload.js: window.api.bootFlags, window.api.app.relaunch)
// has called this API since v0.2.8; it never had a main-process side,
// so every get/set threw "No handler registered".
const bootFlagsPath = path.join(app.getPath('userData'), 'boot-flags.json');
function readBootFlags() {
  try { return JSON.parse(fs.readFileSync(bootFlagsPath, 'utf8')); }
  catch { return {}; }
}
function writeBootFlags(patch) {
  const merged = Object.assign(readBootFlags(), patch || {});
  try {
    fs.mkdirSync(path.dirname(bootFlagsPath), { recursive: true });
    fs.writeFileSync(bootFlagsPath, JSON.stringify(merged));
  } catch (e) { log('boot-flags write failed: ' + e.message); }
  return merged;
}
ipcMain.handle('boot-flags:get', () => readBootFlags());
ipcMain.handle('boot-flags:set', (_e, patch) => writeBootFlags(patch));
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

// Applied now, synchronously, before anything below reaches app.whenReady().
// Default is ON (hardwareAcceleration !== false matches the renderer's
// own default in syncHardwareAccelToggle), so only an explicit opt-out
// calls this.
if (readBootFlags().hardwareAcceleration === false) {
  app.disableHardwareAcceleration();
}

// Crash reporting is always on for production builds.
// FREQPHULL_NO_CRASH_REPORT=1 is honored as a dev-only escape hatch.
const _sentry = sentry.init('main', app.getVersion(), {
  userOptOut: process.env.FREQPHULL_NO_CRASH_REPORT === '1',
});
const report = (category, err, ctx) => sentry.reportSoftError('main', category, err, ctx);

// Crash-restart counter; stops endless respawn of a broken backend.
let backendRestartCount = 0;

// branded standalone updater window. Replaces the inline banner
// for users who want the dedicated experience. The banner still works
// (small, non-intrusive); this is opened either programmatically when
// an update arrives, or when the renderer asks via 'updater:openWindow'.
let updaterWindow = null;
function openUpdaterWindow(initialState) {
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    try { updaterWindow.focus(); updaterWindow.show(); } catch {}
    if (initialState) updaterWindow.webContents.send('updater-state', initialState);
    return updaterWindow;
  }
  // when initialState.installing is true we open this as a
  // takeover screen - bigger, no minimize/close, always on top so the
  // user never accidentally focuses the main window during the quit.
  const isInstalling = !!(initialState && initialState.installing);
  updaterWindow = new BrowserWindow({
    width: isInstalling ? 720 : 620,
    height: isInstalling ? 520 : 720,
    minWidth: 540, minHeight: 480,
    resizable: !isInstalling, minimizable: !isInstalling, maximizable: false,
    closable: !isInstalling,    // can't close mid-install
    alwaysOnTop: isInstalling,
    center: true,
    show: false, frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0a',
    // Absolute, like the main window. A relative path resolves against
    // the working directory rather than the app, so once packaged the
    // window fell back to the default Electron icon.
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: require('path').join(__dirname, 'updater-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      devTools: DEVTOOLS_ALLOWED,
    },
  });
  updaterWindow.removeMenu();
  // Absolute, like the main window above. A relative path resolves
  // against the working directory rather than the app, which is not the
  // same place once packaged.
  updaterWindow.loadFile(path.join(__dirname, 'renderer', 'updater', 'updater.html'));
  updaterWindow.once('ready-to-show', () => {
    try { updaterWindow.show(); } catch {}
    if (initialState) {
      // special pass-through for installing mode
      if (initialState.installing) {
        updaterWindow.webContents.send('updater-state', {
          phase: 'installing',
          update: initialState.version || '?',
        });
      } else {
        updaterWindow.webContents.send('updater-state', initialState);
      }
    }
  });
  updaterWindow.on('closed', () => { updaterWindow = null; });
  return updaterWindow;
}
ipcMain.handle('updater:openWindow', (_e, initial) => {
  openUpdaterWindow(initial);
  return { ok: true };
});
ipcMain.on('updater-window-close', () => {
  if (updaterWindow && !updaterWindow.isDestroyed()) { try { updaterWindow.close(); } catch {} }
});
ipcMain.on('updater-window-minimize', () => {
  if (updaterWindow && !updaterWindow.isDestroyed()) { try { updaterWindow.minimize(); } catch {} }
});
ipcMain.on('updater-window-check', () => {
  // Manual re-check from the updater window's TRY AGAIN button.
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdates();
  } catch (e) { log('[updater-window] re-check failed: ' + e.message); }
});
ipcMain.on('updater-window-install', () => {
  const { autoUpdater } = require('electron-updater');
  // silent install (isSilent=true) so NSIS doesn't show its
  // own "Installing, please wait..." dialog. Our branded HK window is
  // the only visible UI from click → relaunch.
  try { autoUpdater.quitAndInstall(true, true); }
  catch (e) { log('[updater-window] install failed: ' + e.message); }
});
ipcMain.on('updater-window-ready', () => {
  // The renderer is ready; ask updater.js for the latest snapshot via
  // its existing getPending IPC. If the autoUpdater already broadcast,
  // the renderer in updater-preload.js will translate the events.
});

// Bridge: forward main-process updater events to the updater window if open
function _fwdToUpdater(state) {
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    try { updaterWindow.webContents.send('updater-state', state); } catch {}
  }
}
ipcMain.handle('updater:bridge-state', (_e, state) => { _fwdToUpdater(state); return { ok: true }; });

let mainWindow, backendProcess, backendReady = false;
let logFile = null;
let tray = null;
let trayContextMenu = null;
let isQuitting = false;

// ── Prevent multiple instances - one backend is enough ───────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // app.quit() is asynchronous: it asks for a graceful shutdown and lets
  // the rest of this file keep running, which spawned a second backend
  // that then failed to bind the port - the port-in-use crash. exit()
  // stops here and now.
  app.exit(0);
}
app.on('second-instance', () => {
  // Someone tried to open a second instance - show the existing window
  if (mainWindow) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Logging ───────────────────────────────────────────────────────────────────
function setupLog() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'freqphull-' + new Date().toISOString().slice(0,10) + '.log');
  log('=== Freq.Phull starting ===');
  log('App version: ' + app.getVersion());
  log('Electron: ' + process.versions.electron);
  log('Node: ' + process.versions.node);
  log('Platform: ' + process.platform + ' ' + process.arch);
  log('isPackaged: ' + app.isPackaged);
}

// v0.2.8 hotfix: same EPIPE-safety as server.js's slog. The main
// process logs through console.log, which throws EPIPE if Electron's
// stdout is closed (rare but happens during quit/relaunch sequences,
// or when the parent process detached after spawning). Without this
// guard a single throw kills the main process - which kills the whole
// app, including the in-flight update install.
let _mainStdoutDead = false;
function log(msg) {
  let line;
  try { line = '[' + new Date().toISOString() + '] ' + msg; }
  catch { line = '[' + new Date().toISOString() + '] <unprintable>'; }
  if (!_mainStdoutDead) {
    try { console.log(line); }
    catch (e) {
      if (e && e.code === 'EPIPE') _mainStdoutDead = true;
      // Any other error: ignore. The on-disk log is the durable record.
    }
  }
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  }
}
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') _mainStdoutDead = true; });
process.stderr.on('error', (e) => { if (e && e.code === 'EPIPE') _mainStdoutDead = true; });
// Global handlers - main.js had NONE before, meaning any unhandled
// exception silently killed the entire app (including kicking the user
// out of a download or update install). Now: log it, keep running.
// EPIPE filtered to prevent the feedback loop that hosed server.js.
process.on('uncaughtException', (e) => {
  try {
    if (e && e.code === 'EPIPE') { _mainStdoutDead = true; return; }
    log('[main] UNCAUGHT: ' + (e && e.message) + '\n' + (e && e.stack));
  } catch {}
});
process.on('unhandledRejection', (e) => {
  try {
    if (e && e.code === 'EPIPE') { _mainStdoutDead = true; return; }
    log('[main] UNHANDLED REJECTION: ' + (e && (e.message || e)));
  } catch {}
});

// ── Check if launched with --background flag ──────────────────────────────────
const launchMinimized = process.argv.includes('--background') || process.argv.includes('--tray');

// ── App startup ───────────────────────────────────────────────────────────────
// Was this launch the first one after an update? The version we last
// ran with is recorded beside the app's own data, so a change means the
// user restarted into a new build and has earned a note about what
// changed. Nothing is shown on a first ever install - there is no
// "what's new" when everything is new.
//
// ─── BEGIN WHATS-NEW DECISION ───
// Round 80: "only on the first launch after an update", properly.
//
// This used to show the page whenever the version DIFFERED from the last
// run, not when it was NEWER. Two builds sharing one data folder - a test
// build next to the installed one, which is exactly how this app gets
// developed, or a user rolling back after a bad update - flip the stamp on
// every launch, so the page opened every single time. Now the stamp keeps
// the HIGHEST version ever run, and the page appears only when the current
// version is above it: once per genuine update, never for a downgrade or for
// alternating between builds.
function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
// Pure: given what is on disk (or null) and the running version, decide
// whether to show the page and what to write back.
function whatsNewDecision(stamp, current) {
  const lastRun = stamp && stamp.version ? String(stamp.version) : null;
  // Stamps written before this round have only `version`; that was the
  // highest they knew about.
  const highest = stamp && (stamp.highest || stamp.version) ? String(stamp.highest || stamp.version) : null;
  const newHighest = !highest || compareVersions(current, highest) > 0 ? current : highest;
  return {
    // Nothing to announce on a first-ever install - everything is new.
    show: !!highest && compareVersions(current, highest) > 0,
    next: { version: current, highest: newHighest, previous: lastRun },
  };
}
// ─── END WHATS-NEW DECISION ───

function consumeUpdateFlag() {
  try {
    const stampPath = path.join(app.getPath('userData'), 'last-version.json');
    const current = app.getVersion();
    let stamp = null;
    try {
      if (fs.existsSync(stampPath)) stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    } catch {}
    const d = whatsNewDecision(stamp, current);
    if (stamp && stamp.version === d.next.version && (stamp.highest || stamp.version) === d.next.highest) return false;

    // Record before deciding to show anything. If the write fails - a
    // locked file, a full disk, a folder the user cannot write to - the
    // stamp never changes on disk and the page would greet them on every
    // single launch from then on. Better to skip it once than to repeat it
    // forever.
    try {
      fs.writeFileSync(stampPath, JSON.stringify({ ...d.next, at: new Date().toISOString() }));
      const check = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      if (check.highest !== d.next.highest) return false;
    } catch (e) {
      log('update stamp could not be written, skipping the what\'s new page: ' + e.message);
      return false;
    }
    if (d.show) log('first launch of ' + current + ' (previous highest ' + ((stamp && (stamp.highest || stamp.version)) || 'none') + ') - showing what\'s new');
    return d.show;
  } catch { return false; }
}

app.whenReady().then(() => {
  if (!gotLock) return;   // a second instance never starts anything
  // Held back so it lands after the main window has painted rather than
  // competing with boot, and only once the app is genuinely usable.
  if (consumeUpdateFlag()) {
    setTimeout(() => {
      try { openUpdaterWindow({ phase: 'complete' }); } catch (e) { log('update-complete window failed: ' + e.message); }
    }, 4000);
  }
  setupLog();
  log('App ready (minimized=' + launchMinimized + ')');
  // Round 80: say so when a build cannot report errors. Without this line
  // a DSN-less release is indistinguishable from one with no problems.
  log('crash reporting: ' + (_sentry ? 'ON' : 'OFF - no Sentry DSN in this build'));

  try {
    protocol.handle('localfile', (req) => {
      const p = decodeURIComponent(req.url.replace('localfile://', ''));
      return net.fetch('file:///' + p.replace(/\\/g, '/'));
    });
  } catch(e) { log('Protocol error: ' + e.message); }

  createTray();
  startBackend();

  if (!launchMinimized) {
    createWindow();
  } else {
    log('Launched in background/tray mode — no window');
  }

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

// ── Don't quit when window closes - minimize to tray instead ─────────────────
app.on('window-all-closed', () => {
  // Don't quit - backend keeps running for the Chrome extension
  if (isQuitting) {
    if (backendProcess) backendProcess.kill();
    app.quit();
  }
  // Otherwise just let the tray icon stay
});

app.on('before-quit', () => {
  isQuitting = true;
});

// ── System Tray ───────────────────────────────────────────────────────────────
function createTray() {
  // The 0.7.12 setup, which worked: the app icon, resized to 16.
  //
  // The one change kept from the attempts since is reading it from
  // resources first. Windows cannot open a path inside app.asar, so in a
  // packaged build there is no file there to load and the tray renders
  // nothing - which is what the last few versions were actually hitting,
  // not the artwork.
  const trayName = process.platform === 'win32' ? 'icon.ico' : 'logo.png';
  const trayCandidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'assets', trayName) : null,
    path.join(__dirname, 'assets', trayName),
  ].filter(Boolean);
  const trayIconPath = trayCandidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || trayCandidates[trayCandidates.length - 1];

  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath);
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  // Say what happened either way: a tray icon that fails to load looks
  // exactly like one that was never set.
  if (trayIcon.isEmpty()) {
    log('tray: icon EMPTY from ' + trayIconPath);
  } else {
    const sz = trayIcon.getSize();
    log('tray: icon loaded from ' + trayIconPath + ' (' + sz.width + 'x' + sz.height + ')');
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Freq.Phull');

  trayContextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Freq.Phull',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    {
      label: 'Backend: ' + (backendReady ? '● Online' : '○ Starting…'),
      enabled: false
    },
    { type: 'separator' },
    memoryReportMenuItem(),
    { type: 'separator' },
    {
      label: 'Quit Freq.Phull',
      click: () => {
        isQuitting = true;
        if (backendProcess) backendProcess.kill();
        app.quit();
      }
    }
  ]);

  // Deliberately NOT calling tray.setContextMenu() here. On both
  // Windows and macOS, once a context menu is attached that way, a
  // plain left-click on the tray icon opens THAT MENU instead of
  // firing 'click' - so the only way to actually get the app open was
  // a double-click (still wired below) or picking "Open Freq.Phull"
  // from the menu. A single left-click did nothing, which looks
  // exactly like the tray icon being broken. Handling 'click' and
  // 'right-click' separately, and only popping the menu up explicitly
  // on right-click, gives the click-to-open / right-click-for-menu
  // behavior every other tray app on the platform already has.
  const openWindow = () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  };
  tray.on('click', openWindow);
  tray.on('double-click', openWindow);
  tray.on('right-click', () => {
    if (trayContextMenu) tray.popUpContextMenu(trayContextMenu);
  });
}

// ─── BEGIN MEMORY REPORT ───
// Diagnostics without DevTools.
//
// A packaged build is an awkward place to answer "where is the memory
// going": Task Manager shows a total across six Electron processes and
// says nothing about which one, and asking someone to open DevTools in a
// frameless window is not a reliable instruction. app.getAppMetrics()
// already breaks memory down per process from the main process, which is
// exactly the split Task Manager cannot give, so this puts it one
// right-click away and on the clipboard ready to paste into a bug report.
//
// Deliberately read-only: it measures, it does not free anything. Nothing
// here runs unless the menu item is clicked, so it costs nothing at idle.
// What the page itself is holding, read from inside it. A heap snapshot
// answers this too, but it takes a dozen clicks in DevTools and still does
// not name the owning variable unless the right row is selected - and most
// of the renderer's memory (decoded audio, decoded images) is not JS heap at
// all, so a snapshot cannot see it. Every name below is a top-level binding
// in app.js (a classic <script>, so reachable by name from the page's main
// world). Anything missing is reported as absent rather than guessed at.
const RENDERER_INVENTORY_JS = `(() => {
  const MB = (b) => b / 1048576;
  const out = { buffers: [], notes: [] };
  const buf = (label, get) => {
    try {
      const b = get();
      if (b && typeof b.numberOfChannels === 'number' && typeof b.length === 'number') {
        out.buffers.push({ label, mb: MB(b.length * b.numberOfChannels * 4), sec: b.duration, sr: b.sampleRate, ch: b.numberOfChannels });
      }
    } catch (e) {}
  };
  buf('audioBuf (Analyze tab)', () => audioBuf);
  buf('svState.buffer (Slowverb)', () => svState && svState.buffer);
  buf('rbReviewBeatBuf (Topliner beat)', () => rbReviewBeatBuf);
  buf('rbReviewVocalBuf (Topliner take)', () => rbReviewVocalBuf);
  buf('rbGraphOriginalVocalBuf (Graph Mode original)', () => rbGraphOriginalVocalBuf);
  try {
    let n = 0;
    for (const c of (rbRecChunks || [])) for (const a of (c.channels || [])) n += a ? a.length : 0;
    if (n) out.buffers.push({ label: 'rbRecChunks (take being recorded)', mb: MB(n * 4), sec: null });
  } catch (e) {}
  try { const m = performance.memory; out.jsHeapMb = MB(m.usedJSHeapSize); } catch (e) {}
  const imgs = Array.from(document.images);
  let imgPx = 0, imgLoaded = 0;
  for (const im of imgs) if (im.complete && im.naturalWidth) { imgLoaded++; imgPx += im.naturalWidth * im.naturalHeight; }
  out.images = { total: imgs.length, loaded: imgLoaded, decodedMbIfAllResident: MB(imgPx * 4) };
  let cvPx = 0; const cvs = document.querySelectorAll('canvas');
  for (const c of cvs) cvPx += c.width * c.height;
  out.canvases = { count: cvs.length, mb: MB(cvPx * 4) };
  out.historyRows = document.querySelectorAll('.hist-row').length;
  out.domNodes = document.getElementsByTagName('*').length;
  out.media = document.querySelectorAll('audio,video').length;
  return out;
})()`;

async function rendererInventory() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return await Promise.race([
      mainWindow.webContents.executeJavaScript(RENDERER_INVENTORY_JS, true),
      new Promise((r) => setTimeout(() => r(null), 3000)),   // a hung page must not hang the report
    ]);
  } catch (e) { return { error: e && e.message }; }
}

async function buildMemoryReport() {
  const MB = (b) => (b / 1048576).toFixed(1).padStart(8) + ' MB';
  const lines = [];
  lines.push('Freq.Phull memory report — ' + new Date().toISOString());
  lines.push('app ' + app.getVersion() + '  electron ' + process.versions.electron + '  ' + process.platform + ' ' + process.arch);
  lines.push('');

  let metrics = [];
  try { metrics = app.getAppMetrics() || []; } catch (e) { lines.push('getAppMetrics failed: ' + e.message); }

  let total = 0;
  lines.push('  pid     type              working set      peak       cpu%');
  for (const m of metrics) {
    const ws = (m.memory && m.memory.workingSetSize || 0) * 1024;   // reported in KB
    const pk = (m.memory && m.memory.peakWorkingSetSize || 0) * 1024;
    total += ws;
    lines.push(
      '  ' + String(m.pid).padEnd(8) +
      String(m.type + (m.serviceName ? '/' + m.serviceName : '')).padEnd(18) +
      MB(ws) + '  ' + MB(pk) + '   ' +
      (m.cpu ? m.cpu.percentCPUUsage.toFixed(1) : '0.0')
    );
  }
  lines.push('  ' + '-'.repeat(60));
  lines.push('  TOTAL'.padEnd(26) + MB(total));
  lines.push('');

  // The Python backend is a child process we spawn, so it is not in
  // getAppMetrics() - note whether it is even alive, since a backend that
  // has quietly died looks identical to one that is idle from in here.
  lines.push('backend: ' + (backendProcess && !backendProcess.killed
    ? 'running pid ' + backendProcess.pid + (backendReady ? ' (ready)' : ' (starting)')
    : 'not running'));
  lines.push('windows: ' + BrowserWindow.getAllWindows().length +
             '  main ' + (mainWindow ? (mainWindow.isVisible() ? 'visible' : 'hidden') : 'none'));
  // Round 80: Sentry showed ONE reporting user in 90 days. A build whose
  // sentry.config.json lacks a real DSN reports nothing and says nothing;
  // this makes that visible on any machine with one keypress.
  lines.push('crash reporting: ' + (_sentry ? 'ON' :
    (process.env.FREQPHULL_NO_CRASH_REPORT === '1' ? 'off (FREQPHULL_NO_CRASH_REPORT=1)' : 'OFF - this build has no Sentry DSN')));

  const inv = await rendererInventory();
  lines.push('');
  lines.push('INSIDE THE PAGE (Tab process)');
  if (!inv) {
    lines.push('  (page did not answer within 3s)');
  } else if (inv.error) {
    lines.push('  (inventory failed: ' + inv.error + ')');
  } else {
    const f = (v) => v.toFixed(1).padStart(7) + ' MB';
    if (typeof inv.jsHeapMb === 'number') lines.push('  JS heap              ' + f(inv.jsHeapMb));
    let audioTotal = 0;
    for (const b of inv.buffers) audioTotal += b.mb;
    lines.push('  decoded audio        ' + f(audioTotal) + '  (' + inv.buffers.length + ' buffer' + (inv.buffers.length === 1 ? '' : 's') + ')');
    for (const b of inv.buffers) {
      lines.push('    ' + f(b.mb) + '  ' + b.label +
                 (b.sec ? '  ' + Math.floor(b.sec / 60) + ':' + String(Math.floor(b.sec % 60)).padStart(2, '0') +
                          ' @' + b.sr + 'Hz ' + b.ch + 'ch' : ''));
    }
    lines.push('  images               ' + inv.images.total + ' elements, ' + inv.images.loaded + ' loaded' +
               ' (up to ' + inv.images.decodedMbIfAllResident.toFixed(1) + ' MB decoded if all resident)');
    lines.push('  canvases             ' + inv.canvases.count + ', ' + inv.canvases.mb.toFixed(1) + ' MB of pixels');
    lines.push('  history rows         ' + inv.historyRows);
    lines.push('  DOM nodes            ' + inv.domNodes + ',  media elements ' + inv.media);
  }
  return lines.join('\n');
}

function memoryReportMenuItem() {
  return {
    label: 'Copy memory report',
    click: async () => {
      try {
        const report = await buildMemoryReport();
        clipboard.writeText(report);
        log('memory report copied to clipboard\n' + report);
      } catch (e) {
        log('memory report failed: ' + (e && e.message));
      }
    }
  };
}
// ─── END MEMORY REPORT ───

function updateTrayMenu() {
  if (!tray) return;
  // Rebuild and store only - do NOT call tray.setContextMenu() here
  // either (see the comment in createTray()). This just keeps the
  // "Backend: Online/Starting" line current for the next time the user
  // right-clicks the tray icon.
  trayContextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Freq.Phull',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createWindow();
      }
    },
    {
      label: 'Backend: ' + (backendReady ? '● Online' : '○ Starting…'),
      enabled: false
    },
    { type: 'separator' },
    memoryReportMenuItem(),
    { type: 'separator' },
    {
      label: 'Quit Freq.Phull',
      click: () => { isQuitting = true; if (backendProcess) backendProcess.kill(); app.quit(); }
    }
  ]);
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  log('Creating window...');
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#080808',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    transparent: false,
    // hasShadow on a frameless window puts the window through the DWM
    // shadow path, and Windows composites unfocused windows differently
    // there - the result is a faint softening the moment focus is lost,
    // which reads as the app going blurry. A frameless window has no
    // system shadow to speak of anyway, so nothing is lost by turning it
    // off, and the window stays pixel-exact whether focused or not.
    hasShadow: false,
    // Pin to the display's own scale. Chromium otherwise resamples when
    // a window straddles monitors with different DPI, which softens text
    // in exactly the same way and is easy to mistake for a driver
    // problem.
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
      devTools: DEVTOOLS_ALLOWED,
    },
    show: false,
    backgroundColor: '#0b0b0b',   // matches the boot splash — no white flash
  });

  // A real report from the field: launching the app while the disk/CPU
  // was under heavy contention from an unrelated program (an installer
  // updating in the background) produced a broken first paint - the
  // page "loaded" from Electron's point of view (did-finish-load fired
  // normally, so a plain retry-on-failure listener wouldn't have caught
  // it), but rendered as raw, unstyled source text instead of the actual
  // UI. Closing and reopening the app fixed it immediately, which is the
  // signature of a one-time load race, not a broken file - confirmed
  // separately by parsing renderer/index.html with a strict HTML parser:
  // well-formed, no BOM, both <style> blocks close cleanly, nothing
  // leaks into the body. Since it can still happen once under a bad
  // enough race, the app now checks for it directly instead of trusting
  // "did-finish-load fired" to mean "rendered correctly", and silently
  // self-heals with a reload if the check fails - instead of leaving the
  // user staring at raw CSS with no idea what happened or that a restart
  // would fix it.
  let mainLoadRetries = 0;
  const MAIN_LOAD_MAX_RETRIES = 3;
  function loadMainWindow() {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
  loadMainWindow();

  // ─── BEGIN DIAGNOSTIC KEYS ───
  // Window-scoped, not globalShortcut. A global shortcut is registered with
  // the OS and swallows that combination in EVERY application for as long as
  // Freq.Phull is running, including while it sits minimised in the tray -
  // far too rude for a diagnostic. before-input-event only sees keys that
  // were already going to this window.
  //
  //   Ctrl+Shift+M  copy the memory report (same as the tray item)
  //   Ctrl+Shift+I  DevTools, only where DEVTOOLS_ALLOWED (from source, or
  //                 FREQPHULL_DEVTOOLS=1); in an installed build the key
  //                 does nothing.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    const k = (input.key || '').toLowerCase();
    if (k === 'm') {
      event.preventDefault();
      buildMemoryReport().then((report) => {
        clipboard.writeText(report);
        log('memory report copied to clipboard (Ctrl+Shift+M)\n' + report);
        // Confirm in the UI - a silent clipboard write is indistinguishable
        // from the shortcut not being wired at all.
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diag-toast', 'Memory report copied to clipboard');
      }).catch((e) => {
        log('memory report failed: ' + (e && e.message));
      });
    } else if (k === 'i') {
      event.preventDefault();
      if (!DEVTOOLS_ALLOWED) return;
      try { mainWindow.webContents.toggleDevTools(); } catch (e) {}
    }
  });
  // ─── END DIAGNOSTIC KEYS ───

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on totally normal things (e.g. a
    // fast reload racing an in-flight load) and is not an actual failure.
    if (!isMainFrame || errorCode === -3) return;
    if (mainLoadRetries >= MAIN_LOAD_MAX_RETRIES) {
      log('Main window failed to load repeatedly (' + errorDescription + ') - giving up after ' + mainLoadRetries + ' retries.');
      return;
    }
    mainLoadRetries++;
    log('Main window failed to load (' + errorDescription + ', code ' + errorCode + ') - retrying (' + mainLoadRetries + '/' + MAIN_LOAD_MAX_RETRIES + ') in 400ms.');
    setTimeout(loadMainWindow, 400);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page loaded');
    mainWindow.webContents.send('log', 'Page loaded, backendReady=' + backendReady);
    if (backendReady) mainWindow.webContents.send('backend-ready');
    // Content-aware sanity check: did this actually render as the app,
    // or did it come back as unstyled/raw source text (the exact
    // scenario above)? A real stylesheet being applied is something
    // that's true within a handful of milliseconds of a normal load and
    // essentially never true if something went sideways, so a short
    // settle delay before checking is enough without needing to guess a
    // longer, arbitrary timeout.
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.executeJavaScript(
        "(() => { try { const cs = getComputedStyle(document.body); return !!document.getElementById('main') && cs.fontFamily.indexOf('Inter') !== -1; } catch (e) { return false; } })()"
      ).then((renderedOk) => {
        if (renderedOk || !mainWindow || mainWindow.isDestroyed()) return;
        if (mainLoadRetries >= MAIN_LOAD_MAX_RETRIES) {
          log('Main window rendered incorrectly and retry budget is exhausted - leaving as-is.');
          return;
        }
        mainLoadRetries++;
        log('Main window finished loading but did not render correctly (stylesheet not applied) - reloading (' + mainLoadRetries + '/' + MAIN_LOAD_MAX_RETRIES + ').');
        mainWindow.reload();
      }).catch(() => {});
    }, 500);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Initialize the updater once the window is real and visible. We do this
    // here (rather than in whenReady) so the updater has a window reference
    // to send IPC events to. setupUpdater is idempotent - if called twice
    // it's safe; the IPC handlers replace any previous ones. Background
    // checks fire on a setTimeout inside, so they don't race window-ready.
    try {
      setupUpdater({ log, win: mainWindow });
    } catch (e) {
      log('[updater] setup failed: ' + e.message);
      // Updater failure NEVER blocks the app. Worst case: no auto-updates.
    }
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      log('Window hidden to tray');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Backend ───────────────────────────────────────────────────────────────────
function startBackend() {
  const resourcesPath = app.isPackaged ? process.resourcesPath : __dirname;
  const serverPath = path.join(__dirname, 'server.js');

  log('Starting backend... (server=' + serverPath + ')');

  try {
    backendProcess = fork(serverPath, [], {
      env: {
        ...process.env,
        RESOURCES_PATH: resourcesPath,
        USER_DATA: app.getPath('userData'),
        PORT: '47891',
        NODE_OPTIONS: '--max-old-space-size=128', // Cap memory at 128MB
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    log('Backend forked, pid=' + backendProcess.pid);

    backendProcess.stdout?.on('data', d => {
      const msg = d.toString().trim();
      log('[srv] ' + msg);
      // server emits __FREQPHULL_FATAL__ <reason> for hard
      // startup failures (port already taken, etc.). Show the user a
      // proper dialog instead of letting them stare at a blank app.
      if (msg.includes('__FREQPHULL_FATAL__')) {
        // Just the first line - stdout chunks can contain trailing log
        // lines that would otherwise be appended to the dialog message.
        const after = msg.split('__FREQPHULL_FATAL__')[1] || '';
        const firstLine = after.split(/[\r\n]/)[0] || '';
        const reason = firstLine.trim();
        log('FATAL server error: ' + reason);
        report('backend.fatal-startup', new Error(reason || 'unknown fatal'), {
          marker: '__FREQPHULL_FATAL__',
          packaged: app.isPackaged,
          userDataDrive: (() => { try { return app.getPath('userData').slice(0, 3); } catch { return '?'; } })(),
        });
        try {
          let title = 'Freq.Phull cannot start';
          let detail = 'The backend reported: ' + reason;
          if (reason.indexOf('port-in-use') === 0) {
            title = 'Port 47891 is already in use';
            detail = 'Another copy of Freq.Phull is probably running.\n\n' +
                     'Open Task Manager (Ctrl+Shift+Esc), look for any\n' +
                     '"Freq.Phull" or "node.exe" processes, end them, then\n' +
                     'restart Freq.Phull.\n\n' +
                     'If that does not help, a system restart will free it.';
          }
          dialog.showErrorBox(title, detail);
        } catch {}
        setTimeout(() => app.exit(2), 500);
        return;
      }
      // Require both the port and "ready" - defends against future
      // log lines incidentally mentioning 47891.
      if (msg.includes('47891') && /ready/i.test(msg) && !backendReady) {
        log('Backend online!');
        backendReady = true;
        updateTrayMenu();
        if (mainWindow) mainWindow.webContents.send('backend-ready');
      }
    });

    backendProcess.stderr?.on('data', d => log('[srv-err] ' + d.toString().trim()));
    backendProcess.on('error', e => log('[srv-error] ' + e.message));
    backendProcess.on('exit', (code) => {
      log('[srv-exit] code=' + code);
      backendReady = false;
      updateTrayMenu();
      if (code !== 0 && code !== null && !isQuitting) {
        // Cap at 5 restarts so a permanently-broken backend doesn't
        // burn forever; show a real dialog on the way out.
        backendRestartCount = (backendRestartCount || 0) + 1;
        if (backendRestartCount > 5) {
          log('Backend crashed 5+ times — giving up.');
          report('backend.crash-loop', new Error('Backend crashed 5+ times'), {
            lastExitCode: code,
            restartCount: backendRestartCount,
            uptimeS: Math.round(process.uptime()),
            packaged: app.isPackaged,
          });
          try {
            dialog.showErrorBox(
              'Freq.Phull backend keeps crashing',
              'The backend process has crashed 5 times in a row. ' +
              'This usually means the install is corrupted or an ' +
              'antivirus has quarantined a required file.\n\n' +
              'Try:\n' +
              '  1. Reinstall Freq.Phull from the latest installer\n' +
              '  2. Add the install folder to Windows Defender exclusions\n' +
              '  3. Check the log file:\n     %APPDATA%\\freqphull\\logs\\'
            );
          } catch {}
          setTimeout(() => app.exit(3), 500);
          return;
        }
        log('Backend crashed, restarting in 2s (attempt ' + backendRestartCount + '/5)...');
        setTimeout(startBackend, 2000);
      } else if (code === 0) {
        // Clean exit: reset the counter.
        backendRestartCount = 0;
      }
    });

  } catch(e) { log('Fork failed: ' + e.message); }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () =>
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
);
ipcMain.on('win-close', () => {
  // Hide to tray instead of close
  if (mainWindow) mainWindow.hide();
});
ipcMain.on('open-path', (_, p) => shell.openPath(p));
// Highlight a file inside its parent folder in the OS file explorer.
// `showItemInFolder` is the built-in Electron API for exactly this.
ipcMain.on('show-in-folder', (_, p) => {
  try { shell.showItemInFolder(p); }
  catch (e) {
    // Fallback: open the containing directory if showItemInFolder failed
    // (very rare - happens when the path doesn't exist anymore).
    try { shell.openPath(require('path').dirname(p)); } catch {}
  }
});
ipcMain.handle('get-log-path', () => logFile);
ipcMain.on('renderer-log', (_, msg) => log('[renderer] ' + msg));

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: 'Choose download folder',
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));

// ── Drag-out with smooth ghost ───────────────────────────────────────────────
ipcMain.handle('write-temp-wav', async (_, wavData, filename) => {
  try {
    const tempDir = path.join(app.getPath('temp'), 'freqphull-drag');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const safeName = (filename || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(tempDir, safeName.replace(/\.[^.]+$/, '') + '.wav');
    fs.writeFileSync(tempPath, Buffer.from(wavData));
    return { ok: true, path: tempPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('start-drag', (event, filePath, iconDataURL) => {
  log('start-drag: ' + filePath);
  try {
    let icon;
    if (iconDataURL && iconDataURL.startsWith('data:image/png')) {
      icon = nativeImage.createFromDataURL(iconDataURL);
    } else {
      const fallback = path.join(__dirname, 'assets', 'logo.png');
      icon = nativeImage.createFromPath(fallback);
    }
    event.sender.startDrag({ file: filePath, icon });
  } catch (e) { log('drag error: ' + e.message); }
});

ipcMain.handle('read-file', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
    const data = fs.readFileSync(filePath);
    return { ok: true, data: new Uint8Array(data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
