/* Voice comes back by itself after network dropouts, without anyone leaving and rejoining.
   Blocks voice traffic with iptables, so it needs root or passwordless sudo (GitHub's runners have it). */
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';
import { execSync } from 'node:child_process';

const sudo = process.getuid && process.getuid() === 0 ? '' : 'sudo -n ';
const RULE = '-p udp ! --dport 53 -j DROP';
function canBlock() { try { execSync(`${sudo}iptables -L -n`, { stdio: 'ignore' }); return true; } catch { return false; } }
const block = () => execSync(`${sudo}iptables -I INPUT ${RULE}`);
const unblock = () => { try { execSync(`${sudo}iptables -D INPUT ${RULE}`, { stdio: 'ignore' }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Kilobytes of Bora's voice arriving at this page over `ms` milliseconds. */
const flow = (p, ms) => p.evaluate(async (ms) => {
  const total = async () => { let n = 0; for (const pc of window.__pcs) { if (pc.connectionState === 'closed') continue; (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived || 0; }); } return n; };
  const a = await total(); await new Promise((r) => setTimeout(r, ms)); return Math.round((await total() - a) / 1024);
}, ms);

export default async function (ok) {
  if (!canBlock()) { ok('skipped: needs iptables (root or passwordless sudo)', true); return; }
  process.on('exit', unblock);
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const watch = { permissions: ['microphone'] };
    const people = [];
    for (const n of ['Ayla', 'Bora']) {
      const ctx = await browser.newContext(watch);
      await ctx.addInitScript(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; });
      const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
      await p.goto(srv.url);
      await p.click('#tabRegister'); await p.fill('#authName', n); await p.fill('#authPass', 'pass1234'); await p.fill('#authGroup', 'test'); await p.click('#authBtn');
      await p.waitForSelector('#room:not([hidden])');
      await joinVoice(p); people.push(p);
    }
    const [a, b] = people;
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sub:has-text("Connected")', { timeout: 15000 });
    ok(`voice flowing (${await flow(a, 3000)} KB in 3 s)`, (await flow(a, 3000)) > 2);

    for (const [secs, label] of [[6, 'a 6-second Wi-Fi blip'], [45, 'a 45-second dropout'], [100, 'a 100-second outage']]) {
      block(); await sleep(secs * 1000); unblock();
      let back = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000) { if ((await flow(a, 2000)) > 1 && (await flow(b, 2000)) > 1) { back = Math.round((Date.now() - t0) / 1000); break; } }
      ok(`voice comes back by itself after ${label}${back ? ` (in about ${back} s)` : ''}`, back > 0);
    }
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { unblock(); await browser.close(); await srv.stop(); }
}
