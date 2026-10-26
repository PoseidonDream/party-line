/* The overlay only receives who's in voice; it can't do anything else. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', { onState: (cb) => ipcRenderer.on('overlay', (e, st) => cb(st)) });
