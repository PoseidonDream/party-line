/* The drawings window only receives strokes; it can't do anything else. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('drawings', { onStroke: (cb) => ipcRenderer.on('stroke', (e, d) => cb(d)) });
