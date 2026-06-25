// Preload for the branded updater window. Bridges the isolated renderer
// and the updater IPC channels. The window stays sandboxed; only the
// methods listed here are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updaterAPI', {
  ready:            () => ipcRenderer.send('updater-window-ready'),
  close:            () => ipcRenderer.send('updater-window-close'),
  minimize:         () => ipcRenderer.send('updater-window-minimize'),
  install:          () => ipcRenderer.send('updater-window-install'),
  checkForUpdates:  () => ipcRenderer.send('updater-window-check'),
  onState: (cb) => {
    const fn = (_e, state) => { try { cb(state || {}); } catch {} };
    ipcRenderer.on('updater-state', fn);
    return () => ipcRenderer.removeListener('updater-state', fn);
  },
});
