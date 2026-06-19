const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  minimize:       ()         => ipcRenderer.send('win-minimize'),
  maximize:       ()         => ipcRenderer.send('win-maximize'),
  close:          ()         => ipcRenderer.send('win-close'),
  openPath:       (p)        => ipcRenderer.send('open-path', p),
  // Show a file in the OS file explorer with it pre-selected. Better UX
  // than opening the folder because the user immediately sees which file
  // was just produced. Falls back to opening the parent folder if the
  // file doesn't exist (rare edge case).
  showInFolder:   (p)        => ipcRenderer.send('show-in-folder', p),
  pickFolder:     ()         => ipcRenderer.invoke('pick-folder'),
  getDownloads:   ()         => ipcRenderer.invoke('get-downloads-path'),
  onBackendReady: (cb)       => ipcRenderer.on('backend-ready', () => cb()),
  onLog:          (cb)       => ipcRenderer.on('log', (_, msg) => cb(msg)),
  readFile:       (filePath) => ipcRenderer.invoke('read-file', filePath),
  getLogPath:     ()         => ipcRenderer.invoke('get-log-path'),
  log:            (msg)      => ipcRenderer.send('renderer-log', msg),
  writeTempWav:   (data, name) => ipcRenderer.invoke('write-temp-wav', data, name),
  startDrag:      (filePath, iconDataURL) => ipcRenderer.send('start-drag', filePath, iconDataURL),

  // ── Auto-updater bridge ────────────────────────────────────────────────
  // Renderer-side surface for electron-updater. Methods invoke into the
  // main process; events fire callbacks on update lifecycle changes.
  // v0.2.8: Hardware acceleration toggle + relaunch (separate APIs;
  // not updater methods, just colocated with related concerns).
  bootFlags: {
    get: () => ipcRenderer.invoke('boot-flags:get'),
    set: (patch) => ipcRenderer.invoke('boot-flags:set', patch),
  },
  app: {
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
  },

  updater: {
    // Manually trigger a check. Returns {ok, version} or {ok:false, error}.
    check:       () => ipcRenderer.invoke('updater:check'),
    // Start downloading the available update. Progress comes via onProgress.
    download:    () => ipcRenderer.invoke('updater:download'),
    // Quit + run installer + relaunch. Point of no return.
    install:     () => ipcRenderer.invoke('updater:install'),
    getStatus:   () => ipcRenderer.invoke('updater:getStatus'),
    // Cached 'update-available' payload from a check that ran before the
    // renderer's listeners attached (or null). See updater.js.
    getPending:  () => ipcRenderer.invoke('updater:getPending'),
    // v0.2.8: open the branded updater BrowserWindow (the screen with
    // version cards, EN/FR toggle, what's new, install button).
    openWindow:  () => ipcRenderer.invoke('updater:openWindow'),
    // Event subscriptions. Each returns an unsubscribe function so callers
    // can clean up if they ever need to (currently nobody does, the banner
    // lives forever).
    onChecking:  (cb) => { const fn = ()      => cb(); ipcRenderer.on('checking-for-update', fn);     return () => ipcRenderer.removeListener('checking-for-update', fn); },
    onAvailable: (cb) => { const fn = (_, i) => cb(i); ipcRenderer.on('update-available', fn);         return () => ipcRenderer.removeListener('update-available', fn); },
    onNone:      (cb) => { const fn = (_, i) => cb(i); ipcRenderer.on('update-not-available', fn);     return () => ipcRenderer.removeListener('update-not-available', fn); },
    onError:     (cb) => { const fn = (_, i) => cb(i); ipcRenderer.on('update-error', fn);             return () => ipcRenderer.removeListener('update-error', fn); },
    onProgress:  (cb) => { const fn = (_, i) => cb(i); ipcRenderer.on('update-download-progress', fn); return () => ipcRenderer.removeListener('update-download-progress', fn); },
    onReady:     (cb) => { const fn = (_, i) => cb(i); ipcRenderer.on('update-downloaded', fn);        return () => ipcRenderer.removeListener('update-downloaded', fn); },
  },
});
