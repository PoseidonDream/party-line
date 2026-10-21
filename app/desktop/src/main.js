/* Party Line desktop app. Opens your group's Party Line server in its own window and adds what a browser
   can't: a screen and window picker for screen sharing, push to talk that works while a game is in front,
   a tray icon, unread badges and automatic updates. */
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, shell, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const pkg = require('../package.json');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

/* ---------- settings saved on this computer ---------- */
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { server: '', pttKey: 'none', closeToTray: true };
function loadCfg() {
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))); } catch {}
  if (!cfg.server && pkg.partyLine && pkg.partyLine.server) cfg.server = pkg.partyLine.server;
}
const saveCfg = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch {} };
const origin = () => { try { return new URL(cfg.server).origin; } catch { return ''; } };

let win = null, tray = null, quitting = false, picker = null;
const icon = () => nativeImage.createFromPath(path.join(__dirname, 'icon.png'));

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#11151d', title: 'Party Line', icon: icon(), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting && cfg.closeToTray && tray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || (origin() && url.startsWith(origin()))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { server: cfg.server, error: desc } });
  });
  openApp();
}
function openApp() {
  if (cfg.server) win.loadURL(cfg.server);
  else win.loadFile(path.join(__dirname, 'setup.html'));
}

/* ---------- only your server gets the microphone, notifications and screen sharing ---------- */
function setupPermissions() {
  const ses = session.defaultSession;
  const trusted = (url) => !!origin() && String(url || '').startsWith(origin());
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'display-capture', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && trusted(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, reqOrigin) => allowed.has(perm) && trusted(reqOrigin));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!trusted(request.securityOrigin || (request.frame && request.frame.url))) { callback({}); return; }
    pickSource().then((src) => {
      if (!src) { callback({}); return; }
      // Windows can send the computer's sound along with the screen.
      callback(process.platform === 'win32' ? { video: src, audio: 'loopback' } : { video: src });
    }).catch(() => callback({}));
  });
}

/* A small window with thumbnails of every screen and window, like Discord's "Go Live" picker. */
async function pickSource() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
  const list = sources.filter((s) => !s.name.startsWith('Party Line')).map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() }));
  if (picker) picker.close();
  return new Promise((resolve) => {
    picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, resizable: true, minimizable: false, maximizable: false,
      title: 'Share your screen', backgroundColor: '#11151d', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (id) => { if (done) return; done = true; resolve(sources.find((s) => s.id === id) || null); if (picker && !picker.isDestroyed()) picker.close(); };
    ipcMain.removeHandler('picker:list');
    ipcMain.handle('picker:list', () => list);
    ipcMain.removeAllListeners('picker:choose');
    ipcMain.once('picker:choose', (e, id) => finish(id));
    picker.on('closed', () => { picker = null; finish(null); });
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

/* ---------- push to talk, even while another app is in front ---------- */
const PTT_KEYS = [
  { id: 'none', label: 'Off (Space works while Party Line is in front)' },
  { id: 'mouse4', label: 'Mouse side button (back)', mouse: 4 },
  { id: 'mouse5', label: 'Mouse side button (forward)', mouse: 5 },
  { id: 'Backquote', label: '` key (left of 1)' },
  { id: 'CapsLock', label: 'Caps Lock' },
  { id: 'CtrlRight', label: 'Right Ctrl' },
  { id: 'AltRight', label: 'Right Alt' },
  { id: 'F8', label: 'F8' },
  { id: 'V', label: 'V' },
];
let hook = null, pttDown = false;
function setupPtt() {
  try { hook = require('uiohook-napi'); } catch { hook = null; return; }
  const { uIOhook, UiohookKey } = hook;
  const send = (held) => { if (held !== pttDown) { pttDown = held; if (win && !win.isDestroyed()) win.webContents.send('ptt', held); } };
  const isKey = (e) => { const k = PTT_KEYS.find((x) => x.id === cfg.pttKey); return k && !k.mouse && UiohookKey[k.id] === e.keycode; };
  const isBtn = (e) => { const k = PTT_KEYS.find((x) => x.id === cfg.pttKey); return k && k.mouse === e.button; };
  uIOhook.on('keydown', (e) => { if (isKey(e)) send(true); });
  uIOhook.on('keyup', (e) => { if (isKey(e)) send(false); });
  uIOhook.on('mousedown', (e) => { if (isBtn(e)) send(true); });
  uIOhook.on('mouseup', (e) => { if (isBtn(e)) send(false); });
  try { uIOhook.start(); } catch { hook = null; }
}

/* ---------- tray ---------- */
function buildTray() {
  if (!tray) {
    tray = new Tray(icon().resize({ width: 16, height: 16 }));
    tray.setToolTip('Party Line');
    tray.on('click', showWin);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Party Line', click: showWin },
    { type: 'separator' },
    { label: 'Push-to-talk key', enabled: !!hook, submenu: PTT_KEYS.map((k) => ({ label: k.label, type: 'radio', checked: cfg.pttKey === k.id, click: () => { cfg.pttKey = k.id; saveCfg(); buildTray(); } })) },
    { label: 'Keep running in the tray when closed', type: 'checkbox', checked: cfg.closeToTray, click: (i) => { cfg.closeToTray = i.checked; saveCfg(); } },
    { label: 'Start when I sign in to my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Change server…', click: () => { showWin(); win.loadFile(path.join(__dirname, 'setup.html'), { query: { server: cfg.server } }); } },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit Party Line', click: () => { quitting = true; app.quit(); } },
  ]));
}
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

/* ---------- messages from the pages ---------- */
ipcMain.handle('setup:save', async (e, url) => {
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return { error: 'That doesn’t look like a web address.' }; }
  const base = u.origin;
  try {
    const r = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(8000) });
    const info = await r.json();
    if (info.name !== 'Party Line') throw new Error('not party line');
  } catch { return { error: `Couldn’t find a Party Line server at ${base}. Check the address and your internet.` }; }
  cfg.server = base; saveCfg();
  win.loadURL(base);
  return { ok: true };
});
ipcMain.handle('setup:current', () => cfg.server);
ipcMain.on('retry', () => openApp());
ipcMain.on('badge', (e, n) => {
  n = Math.max(0, Number(n) || 0);
  try { app.setBadgeCount(n); } catch {}
  if (process.platform === 'win32' && win) {
    if (n && !win.isFocused()) win.flashFrame(true);
    if (tray) tray.setToolTip(n ? `Party Line (${n} unread)` : 'Party Line');
  }
});
ipcMain.on('focus', showWin);
ipcMain.on('app-version', (e) => { e.returnValue = app.getVersion(); });

app.on('second-instance', (e, argv) => {
  showWin();
  const link = argv.find((a) => a.startsWith('partyline://'));
  if (link) openDeepLink(link);
});
app.on('open-url', (e, url) => { e.preventDefault(); openDeepLink(url); });
/* partyline://invite/CODE links open the invite inside the app. */
function openDeepLink(url) {
  const m = String(url).match(/invite\/([\w-]+)/);
  if (m && cfg.server && win) win.loadURL(`${cfg.server}/invite/${m[1]}`);
}
app.setAsDefaultProtocolClient('partyline');

app.whenReady().then(() => {
  loadCfg();
  if (process.platform === 'win32') app.setAppUserModelId('com.poseidondream.partyline');
  setupPermissions();
  setupPtt();
  createWindow();
  buildTray();
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-downloaded', async () => {
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, message: 'A new version of Party Line is ready.', detail: 'Restart to update. It only takes a few seconds.' });
      if (r.response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
    });
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  } catch {}
});
app.on('before-quit', () => { quitting = true; if (hook) { try { hook.uIOhook.stop(); } catch {} } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', showWin);
