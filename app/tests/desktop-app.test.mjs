/* The real desktop app (Electron), on a virtual screen: soundboard keys become system-wide shortcuts, the overlay
   shows while Party Line is in the background, and sharing a whole screen through the picker lets friends' drawings
   appear on top of that screen. Skipped where Electron or a virtual screen (Xvfb) isn't available. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON = path.join(here, '..', 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const hasXvfb = () => process.platform === 'linux' && ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].some((p) => fs.existsSync(p));

export default async function (ok) {
  if (!fs.existsSync(ELECTRON) || !(process.env.DISPLAY || hasXvfb())) { ok('desktop app: skipped (needs Electron and a screen)', true); return; }
  let xvfb = null, display = process.env.DISPLAY;
  if (!display) {
    display = `:${90 + Math.floor(Math.random() * 9)}`;
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
  }
  // A stand-in for a game: a harmless program named like one on the list (see desktop/src/games.js).
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-game-'));
  fs.copyFileSync('/bin/sleep', path.join(fakeDir, 'factorio'));
  const game = spawn(path.join(fakeDir, 'factorio'), ['600'], { stdio: 'ignore' });
  const { _electron: electron } = await import('playwright-core');
  const srv = await startServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-desk-'));
  fs.mkdirSync(path.join(home, '.config', 'Party Line'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'Party Line', 'config.json'), JSON.stringify({ server: srv.url, overlay: true }));
  const app = await electron.launch({ executablePath: ELECTRON, args: [path.join(here, '..', 'desktop'), '--no-sandbox'], env: { ...process.env, HOME: home, DISPLAY: display }, timeout: 30000 });
  const browser = await launchBrowser();
  const main = (fn, arg) => app.evaluate(fn, arg);
  try {
    const win = await app.firstWindow();
    const errors = []; win.on('pageerror', (e) => errors.push(e.message));
    await win.click('#tabRegister'); await win.fill('#authName', 'Poseidon'); await win.fill('#authPass', 'pass1234');
    if (await win.isVisible('#authGroup')) await win.fill('#authGroup', 'test');
    await win.click('#authBtn'); await win.waitForSelector('#room:not([hidden])', { timeout: 15000 });
    const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'desktop', 'package.json'), 'utf8')).version;
    ok('the desktop app opens the server and offers the page its bridge', await win.evaluate((v) => window.partyLineDesktop.version === v && typeof window.partyLineDesktop.drawOnScreen === 'function', version));
    const b = await signUp(browser, srv.url, 'Bora');
    await b.click('#railHome');
    await b.waitForSelector('#dashPlaying .dash-item:has-text("Poseidon"):has-text("Factorio")', { timeout: 10000 });
    ok('a game running on the computer shows as “Playing Factorio” for friends', true);
    await b.click('#railList .rail-btn');
    for (const p of [win, b]) { await p.click('#voiceList .chan:has-text("Lobby")'); await p.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); }

    // Soundboard keys
    await win.click('#soundBtn'); await win.click('#soundKeysBtn'); await win.locator('#soundGrid .sound-btn').first().click();
    await win.keyboard.press('Control+Alt+1');
    await win.waitForSelector('#soundGrid .sound-key:text-is("Ctrl+Alt+1")');
    await win.click('#soundKeysBtn'); await win.mouse.click(900, 500);
    const reg = await main(async (e) => {
      const w = e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line');
      w.blur(); w.emit('blur'); await new Promise((r) => setTimeout(r, 300));
      return e.globalShortcut.isRegistered('CommandOrControl+Alt+1') && e.globalShortcut.isRegistered('CommandOrControl+Shift+M');
    });
    ok('with Party Line in the background, a sound’s key is a system-wide shortcut', reg);
    await main((e) => e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line').webContents.send('hotkey', 'sound:b:airhorn'));
    await b.waitForSelector('.tile .tile-sound', { timeout: 5000 });
    ok('…which plays the sound for friends', true);

    // Overlay
    await main((e) => e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line').hide());
    await new Promise((r) => setTimeout(r, 1500));
    ok('the who’s-talking overlay shows while Party Line is hidden', await main((e) => e.BrowserWindow.getAllWindows().some((x) => x.getTitle() === 'Party Line overlay' && x.isVisible())));
    await main((e) => { const w = e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line'); w.show(); w.focus(); });

    // Screen share through the picker, then a friend's drawing on top of the real screen
    const pickerP = app.waitForEvent('window', { timeout: 15000 });
    await win.click('#shareBtn');
    const picker = await pickerP;
    await picker.waitForSelector('#grid .src', { timeout: 10000 });
    await picker.click('#grid .src');
    await win.waitForSelector('#shareBtn.on', { timeout: 15000 });
    ok('sharing a whole screen through the app’s picker works', true);
    await win.evaluate(() => window.partyLineDesktop.drawOnScreen({ from: 9, id: 'abc', color: '#ff3b3b', pts: [[0.2, 0.2], [0.4, 0.3], [0.6, 0.5]], end: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const dw = await main((e) => { const w = e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line drawings'); return w ? { visible: w.isVisible(), b: w.getBounds(), d: e.screen.getPrimaryDisplay().bounds } : null; });
    ok('a friend’s drawing shows in a see-through window over the shared screen', dw && dw.visible && Math.abs(dw.b.width - dw.d.width) <= 2 && Math.abs(dw.b.height - dw.d.height) <= 2);
    await new Promise((r) => setTimeout(r, 4500));
    ok('…which hides again a few seconds later', await main((e) => { const w = e.BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Party Line drawings'); return !!w && !w.isVisible(); }));
    ok(`no JavaScript errors in the desktop app${errors.length ? ': ' + errors.join(' | ') : ''}`, !errors.length);
    await app.close();

    // First start with no server set: the setup page; then the offline page while the server is down
    fs.writeFileSync(path.join(home, '.config', 'Party Line', 'config.json'), JSON.stringify({ server: '' }));
    const app2 = await electron.launch({ executablePath: ELECTRON, args: [path.join(here, '..', 'desktop'), '--no-sandbox'], env: { ...process.env, HOME: home, DISPLAY: display }, timeout: 30000 });
    try {
      const w = await app2.firstWindow();
      await w.waitForSelector('#url');
      await w.fill('#url', 'localhost:1');
      await w.click('#go');
      await w.waitForSelector('#err:not([hidden])', { timeout: 15000 });
      ok('the first-start page says when there’s no Party Line at an address', /Couldn’t find a Party Line server/.test(await w.textContent('#err')));
      await w.fill('#url', srv.url);
      await w.click('#go');
      await w.waitForSelector('#room:not([hidden])', { timeout: 15000 });   // still signed in from before
      ok('…and opens the server once the address is right', true);
      await srv.kill();
      await w.reload().catch(() => {});
      await w.waitForSelector('#retry', { timeout: 15000 });
      ok('with the server down, the app shows its offline page', (await w.textContent('#detail')).includes(srv.url));
      await srv.restart();
      await w.click('#retry');
      await w.waitForSelector('#room:not([hidden])', { timeout: 15000 });
      ok('…and “Try again” opens Party Line once it’s back', true);
    } finally { await app2.close().catch(() => {}); }
  } finally {
    await app.close().catch(() => {});
    await browser.close(); await srv.stop();
    if (xvfb) xvfb.kill();
    game.kill(); fs.rmSync(fakeDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
