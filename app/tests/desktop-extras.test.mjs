/* Desktop app extras, seen from the page: the overlay gets who's in voice and who's talking, and the mute and
   deafen keys (which work in any app) toggle your mic. A stand-in for the desktop app's bridge is used. */
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

const BRIDGE = `window.partyLineDesktop = {
  version: '9.9.9', setBadge() {}, focus() {}, onPtt() {}, onActivity() {}, setTheme() {},
  onHotkey(cb) { window.__hotkey = cb; }, setOverlay(st) { window.__overlay = st; (window.__overlays ||= []).push(st); },
};`;

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    await ctx.addInitScript(BRIDGE);
    const a = await ctx.newPage(); a.errors = []; a.on('pageerror', (e) => a.errors.push(e.message));
    await a.goto(srv.url);
    await a.click('#tabRegister'); await a.fill('#authName', 'Poseidon'); await a.fill('#authPass', 'pass1234');
    if (await a.isVisible('#authGroup')) await a.fill('#authGroup', 'test');
    await a.check('#authAgree'); await a.click('#authBtn'); await a.waitForSelector('#room:not([hidden])');
    const b = await signUp(browser, srv.url, 'Bora');

    await joinVoice(a); await joinVoice(b);
    await a.waitForFunction(() => window.__overlay && window.__overlay.people.length === 2, null, { timeout: 10000 });
    const ov = await a.evaluate(() => window.__overlay);
    ok('the overlay gets the voice channel and everyone in it', ov.channel === 'Lobby' && ov.people.map((p) => p.name).sort().join() === 'Bora,Poseidon');

    await a.evaluate(() => window.__hotkey('mute'));
    await a.waitForFunction(() => window.__overlay.people.find((p) => p.name === 'Poseidon').muted, null, { timeout: 5000 });
    ok('the mute key mutes you, and the overlay shows it', await a.evaluate(() => document.querySelector('#micBtn').classList.contains('off') || /Unmute/.test(document.querySelector('#micBtn').textContent)));
    await a.evaluate(() => window.__hotkey('mute'));
    await a.waitForFunction(() => !window.__overlay.people.find((p) => p.name === 'Poseidon').muted, null, { timeout: 5000 });
    await a.evaluate(() => window.__hotkey('deafen'));
    await a.waitForFunction(() => window.__overlay.people.find((p) => p.name === 'Poseidon').muted, null, { timeout: 5000 });
    ok('the mute key unmutes, and the deafen key deafens', true);
    await a.evaluate(() => window.__hotkey('deafen'));

    await a.click('#vcLeaveBtn');
    await a.waitForFunction(() => window.__overlay === null, null, { timeout: 5000 });
    ok('leaving voice clears the overlay', true);
    const n = await a.evaluate(() => window.__overlays.length);
    ok(`it only sends changes, not a stream of repeats (${n} updates)`, n < 30);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
