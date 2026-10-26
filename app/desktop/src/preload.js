/* What the Party Line pages can ask the desktop app to do. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('partyLineDesktop', {
  version: ipcRenderer.sendSync('app-version'),
  setBadge: (n) => ipcRenderer.send('badge', n),
  focus: () => ipcRenderer.send('focus'),
  onPtt: (cb) => ipcRenderer.on('ptt', (e, held) => cb(!!held)),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (e, what) => cb(what)),
  setOverlay: (state) => ipcRenderer.send('overlay', state),
  onActivity: (cb) => { ipcRenderer.on('activity', (e, name) => cb(name || null)); ipcRenderer.send('activity:get'); },
  // used by the built-in setup and offline pages
  saveServer: (url) => ipcRenderer.invoke('setup:save', url),
  currentServer: () => ipcRenderer.invoke('setup:current'),
  retry: () => ipcRenderer.send('retry'),
  setTheme: (t) => ipcRenderer.send('theme', t),
});
