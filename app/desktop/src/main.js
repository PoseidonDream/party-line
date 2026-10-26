/* Party Line desktop app. Opens your group's Party Line server in its own window and adds what a browser
   can't: a screen and window picker for screen sharing, push to talk that works while a game is in front,
   mute and deafen keys that work in any app, an overlay showing who's talking while you play, a tray icon,
   unread badges and automatic updates. */
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, shell, nativeImage, dialog, nativeTheme, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const pkg = require('../package.json');
const { watchGames } = require('./games');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

/* ---------- settings saved on this computer ---------- */
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { server: '', pttKey: 'none', closeToTray: true, showGame: true, muteKey: 'CommandOrControl+Shift+M', deafenKey: 'CommandOrControl+Shift+D', overlay: true, startInTray: true };
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
    backgroundColor: '#000000', title: 'Party Line', icon: icon(), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // Started with the computer: wait quietly in the tray (if that's what they chose).
  const atLogin = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);
  win.once('ready-to-show', () => { if (!(atLogin && cfg.startInTray)) win.show(); });
  win.on('focus', updateOverlay); win.on('blur', updateOverlay); win.on('show', updateOverlay); win.on('hide', updateOverlay);
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
      title: 'Share your screen', backgroundColor: '#000000', autoHideMenuBar: true, show: false,
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

/* ---------- mute and deafen keys that work in any app (even while a game is in front) ---------- */
const MUTE_KEYS = ['CommandOrControl+Shift+M', 'CommandOrControl+Alt+M', 'F9', 'Pause', 'none'];
const DEAFEN_KEYS = ['CommandOrControl+Shift+D', 'CommandOrControl+Alt+D', 'F10', 'none'];
const keyLabel = (k) => (k === 'none' ? 'Off' : k.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'));
function setupHotkeys() {
  globalShortcut.unregisterAll();
  const reg = (key, what) => {
    if (!key || key === 'none') return;
    try { if (!globalShortcut.register(key, () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey', what); })) console.warn('hotkey taken:', key); } catch {}
  };
  reg(cfg.muteKey, 'mute'); reg(cfg.deafenKey, 'deafen');
}

/* ---------- overlay: who's talking, in a corner of the screen while you're in another app ---------- */
let overlay = null, overlayState = null;
function updateOverlay() {
  const want = cfg.overlay && overlayState && overlayState.people.length && win && !win.isDestroyed() && !(win.isVisible() && win.isFocused());
  if (!want) { if (overlay && !overlay.isDestroyed()) overlay.hide(); return; }
  const height = 34 + Math.min(overlayState.people.length, 10) * 30;
  if (!overlay || overlay.isDestroyed()) {
    const { workArea } = screen.getPrimaryDisplay();
    overlay = new BrowserWindow({
      x: workArea.x + 12, y: workArea.y + 12, width: 230, height, frame: false, transparent: true, resizable: false, movable: false,
      skipTaskbar: true, focusable: false, show: false, hasShadow: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(true);   // clicks go through to the game
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.loadFile(path.join(__dirname, 'overlay.html'));
    overlay.webContents.once('did-finish-load', () => { overlay.webContents.send('overlay', overlayState); overlay.showInactive(); });
    return;
  }
  overlay.setSize(230, height);
  overlay.webContents.send('overlay', overlayState);
  if (!overlay.isVisible()) overlay.showInactive();
}

/* ---------- tray ---------- */
let games = null;
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
    { label: 'Mute key (works in any app)', submenu: MUTE_KEYS.map((k) => ({ label: keyLabel(k), type: 'radio', checked: cfg.muteKey === k, click: () => { cfg.muteKey = k; saveCfg(); setupHotkeys(); buildTray(); } })) },
    { label: 'Deafen key (works in any app)', submenu: DEAFEN_KEYS.map((k) => ({ label: keyLabel(k), type: 'radio', checked: cfg.deafenKey === k, click: () => { cfg.deafenKey = k; saveCfg(); setupHotkeys(); buildTray(); } })) },
    { label: 'Show who’s talking over games (overlay)', type: 'checkbox', checked: cfg.overlay !== false, click: (i) => { cfg.overlay = i.checked; saveCfg(); updateOverlay(); } },
    { label: 'Show friends what game I’m playing', type: 'checkbox', checked: cfg.showGame !== false, click: (i) => { cfg.showGame = i.checked; saveCfg(); if (games) games.refresh(); } },
    { label: 'Keep running in the tray when closed', type: 'checkbox', checked: cfg.closeToTray, click: (i) => { cfg.closeToTray = i.checked; saveCfg(); } },
    { label: 'Start when I sign in to my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => { setLogin(i.checked); buildTray(); } },
    { label: '…and start in the tray (no window)', type: 'checkbox', checked: cfg.startInTray !== false, enabled: app.getLoginItemSettings().openAtLogin, click: (i) => { cfg.startInTray = i.checked; saveCfg(); } },
    { label: 'Change server…', click: () => { showWin(); win.loadFile(path.join(__dirname, 'setup.html'), { query: { server: cfg.server } }); } },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit Party Line', click: () => { quitting = true; app.quit(); } },
  ]));
}
const setLogin = (on) => app.setLoginItemSettings({ openAtLogin: on, openAsHidden: on, args: on ? ['--hidden'] : [] });
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
ipcMain.on('overlay', (e, st) => {
  // { channel, people: [{ name, talking, muted, color }] } or null when not in voice
  overlayState = st && Array.isArray(st.people) ? { channel: String(st.channel || '').slice(0, 40), people: st.people.slice(0, 10).map((p) => ({ name: String(p.name || '').slice(0, 32), talking: !!p.talking, muted: !!p.muted, color: /^#[0-9a-f]{6}$|^hsl\([\d.% ]+\)$/i.test(p.color) ? p.color : '#888' })) } : null;
  updateOverlay();
});
ipcMain.on('theme', (e, t) => { if (['system', 'dark', 'light'].includes(t)) nativeTheme.themeSource = t; });
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
  setupHotkeys();
  // Older versions turned on "start with the computer" without the start-in-tray flag.
  if (app.getLoginItemSettings().openAtLogin) setLogin(true);
  createWindow();
  games = watchGames((name) => { if (win) win.webContents.send('activity', name); }, () => cfg.showGame !== false);
  // The page asks again after it (re)loads.
  ipcMain.on('activity:get', (e) => e.sender.send('activity', games ? games.now() : null));
  buildTray();
  setupUpdates();
});
/* Updates download by themselves; the Party Line page shows a "Restart now" card in its own style. Pages that
   can't (the setup and offline pages) get a plain dialog instead. */
function setupUpdates() {
  let updater, ready = null, asked = false;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch { return; }
  ipcMain.on('update:get', (e) => { if (ready) { asked = true; e.sender.send('update-ready', ready); } });
  ipcMain.on('update:install', () => { quitting = true; updater.quitAndInstall(); });
  updater.on('update-downloaded', (info) => {
    ready = info.version;
    // The Party Line page shows its own card; the setup and offline pages can't, so they get the dialog.
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('!!(window.partyLineDesktop && window.partyLineDesktop.onUpdate && document.getElementById("updateBar"))').then((can) => {
      if (can) { asked = true; win.webContents.send('update-ready', ready); } else fallback();
    }).catch(fallback);
  });
  async function fallback() {
    if (asked) return;
    const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, message: `Party Line ${ready} is ready.`, detail: 'Restart to update. It only takes a few seconds.' });
    if (r.response === 0) { quitting = true; updater.quitAndInstall(); }
  }
  if (app.isPackaged) {
    updater.checkForUpdates().catch(() => {});
    setInterval(() => updater.checkForUpdates().catch(() => {}), 4 * 3600_000);   // left running for days in the tray
  }
}
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitting = true; if (hook) { try { hook.uIOhook.stop(); } catch {} } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', showWin);
