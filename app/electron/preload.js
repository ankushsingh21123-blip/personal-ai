// Preload bridge — the ONLY channel between the renderer (the loopback
// web UI) and the Electron main process. One allowlisted invoke:
//   window.piplet.getToken() -> the session's ANKU_TOKEN
// so the UI never has to prompt the owner for a token in the app. No
// Node APIs, no other channels, no nodeIntegration anywhere. The
// renderer is sandboxed (see main.js webPreferences).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piplet', {
  isElectron: true,
  getToken: () => ipcRenderer.invoke('piplet:token'),
});
