const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Tray, Menu, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { fork } = require('child_process');
const { setupUpdater } = require('./updater.js');

// v0.2.8: branded standalone updater window. Replaces the inline banner
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
  // v0.3.0: when initialState.installing is true we open this as a
  // takeover screen — bigger, no minimize/close, always on top so the
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
    backgroundColor: '#0a0a0a', icon: 'assets/icon.ico',
    webPreferences: {
      preload: require('path').join(__dirname, 'updater-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  updaterWindow.removeMenu();
  updaterWindow.loadFile('renderer/updater/updater.html');
  updaterWindow.once('ready-to-show', () => {
    try { updaterWindow.show(); } catch {}
    if (initialState) {
      // v0.3.0: special pass-through for installing mode
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
ipcMain.on('updater-window-install', () => {
  // Forward to the main updater autoUpdater (registered via setupUpdater)
  const { autoUpdater } = require('electron-updater');
  // v0.3.2: silent install (isSilent=true) so NSIS doesn't show its
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
let isQuitting = false;

// ── Prevent multiple instances — one backend is enough ───────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => {
  // Someone tried to open a second instance — show the existing window
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
  log('App version: 0.0.1');
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
app.whenReady().then(() => {
  setupLog();
  log('App ready (minimized=' + launchMinimized + ')');

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

// ── Don't quit when window closes — minimize to tray instead ─────────────────
app.on('window-all-closed', () => {
  // Don't quit — backend keeps running for the Chrome extension
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
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'icon.ico')
    : path.join(__dirname, 'assets', 'logo.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    // Resize to 16x16 for tray
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Freq.Phull');

  const contextMenu = Menu.buildFromTemplate([
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
    {
      label: 'Quit Freq.Phull',
      click: () => {
        isQuitting = true;
        if (backendProcess) backendProcess.kill();
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
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
    {
      label: 'Quit Freq.Phull',
      click: () => { isQuitting = true; if (backendProcess) backendProcess.kill(); app.quit(); }
    }
  ]);
  tray.setContextMenu(contextMenu);
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
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page loaded');
    mainWindow.webContents.send('log', 'Page loaded, backendReady=' + backendReady);
    if (backendReady) mainWindow.webContents.send('backend-ready');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Initialize the updater once the window is real and visible. We do this
    // here (rather than in whenReady) so the updater has a window reference
    // to send IPC events to. setupUpdater is idempotent — if called twice
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
      if (msg.includes('47891')) {
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
        log('Backend crashed, restarting in 2s...');
        setTimeout(startBackend, 2000);
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
    // (very rare — happens when the path doesn't exist anymore).
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
