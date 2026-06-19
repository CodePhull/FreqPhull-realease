// v0.2.8: preload for the branded updater window. Bridges between the
// isolated renderer and the updater IPC channels. Keeps the window
// sandboxed; only the methods listed here are accessible.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updaterAPI', {
  ready: () => ipcRenderer.send('updater-window-ready'),
  close: () => ipcRenderer.send('updater-window-close'),
  minimize: () => ipcRenderer.send('updater-window-minimize'),
  install: () => ipcRenderer.send('updater-window-install'),
  // Subscribe to state changes pushed from main process
  onState: (cb) => {
    const fn = (_e, state) => { try { cb(state || {}); } catch {} };
    ipcRenderer.on('updater-state', fn);
    return () => ipcRenderer.removeListener('updater-state', fn);
  },
});
