/* Big voice channels through the media server. Runs only when the run has one (PL_LIVEKIT=…). */
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

export default async function (ok) {
  if (!process.env.LIVEKIT_URL) { ok('skipped: no media server for this run (set PL_LIVEKIT)', true); return; }
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const names = ['Ayla', 'Bora', 'Cem', 'Deniz', 'Ece'];
    const people = [];
    for (const n of names) { const p = await signUp(browser, srv.url, n); await joinVoice(p); people.push(p); }
    for (const p of people) await p.waitForFunction(() => document.querySelectorAll('#tiles .tile .tile-sub').length === 5 && [...document.querySelectorAll('#tiles .tile .tile-sub')].filter((s) => s.textContent === 'Connected').length === 4, null, { timeout: 20000 });
    ok('five people in one channel all connect', true);
    const heard = await Promise.all(people.map((p) => p.evaluate(() => [...document.querySelectorAll('#audioSink audio')].filter((a) => a.srcObject && a.srcObject.getAudioTracks().length).length)));
    ok(`everyone hears the other four (${heard.join(', ')})`, heard.every((n) => n === 4));
    ok('voice goes through the media server', await people[0].evaluate(() => !!window.LivekitClient));
    await people[0].close();
    await people[1].waitForFunction(() => document.querySelectorAll('#tiles .tile').length === 4, null, { timeout: 15000 });
    ok('someone leaving disappears for the rest', true);
  } finally { await browser.close(); await srv.stop(); }
}
