/* Soundboard: built-in sounds reach everyone in the voice channel, uploading a short sound, too-long clips are
   refused, removing a sound, and deafened people don't hear it. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

function wav(seconds) {
  const rate = 8000, n = Math.floor(rate * seconds), b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 4));
  return b;
}

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    await joinVoice(a); await joinVoice(b);
    await a.waitForSelector('#tiles .tile:has-text("Bora")');

    await a.click('#soundBtn');
    await a.waitForSelector('#soundPop:not([hidden]) .sound-btn:has-text("Airhorn")');
    const names = await a.locator('#soundGrid .sound-name').allTextContents();
    ok(`the soundboard has 16 meme sounds (${names.slice(0, 4).join(', ')}…)`, names.length === 16 && ['Vine boom', 'Metal pipe', 'Bonk', 'Crickets'].every((n) => names.includes(n)));
    const levels = await a.evaluate(async () => {
      const S = await import('/js/sounds.js'), bad = [];
      for (const s of S.builtinSounds()) {
        const d = (await S.renderBuiltin(s.id)).getChannelData(0);
        let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        if (peak < 0.25 || peak > 0.99) bad.push(`${s.name} ${peak.toFixed(2)}`);
      }
      return bad;
    });
    ok(`every one is loud enough without distorting${levels.length ? ': ' + levels.join(', ') : ''}`, !levels.length);
    await a.click('#soundGrid .sound-btn:has-text("Airhorn")');
    await b.waitForSelector('#tiles .tile:has-text("Poseidon") .tile-sound:text-is("📯")');
    ok('playing one reaches everyone in the channel (shown on your tile)', true);
    await a.screenshot({ path: `${RESULTS}/soundboard.png` });

    await a.click('#soundAddBtn');
    await a.setInputFiles('#soundFile', { name: 'too-long.wav', mimeType: 'audio/wav', buffer: wav(9) });
    await a.waitForSelector('.toast:has-text("up to 7 seconds")');
    ok('clips longer than 7 seconds are refused', true);
    await a.setInputFiles('#soundFile', { name: 'bruh.wav', mimeType: 'audio/wav', buffer: wav(1) });
    await a.waitForSelector('#soundFileName:has-text("1.0 s")');
    await a.fill('#soundEmoji', '😂');
    await a.click('#soundForm button[type=submit]');
    await a.waitForSelector('.toast:has-text("Sound added")');
    await b.click('#soundBtn');
    await b.waitForSelector('#soundGrid .sound-btn:has-text("bruh")');
    ok('an uploaded sound shows on everyone’s soundboard', true);
    ok('only whoever added it (or an admin) can remove it', await b.locator('#soundGrid .sound:has-text("bruh") .sound-del').count() === 0);
    await b.waitForTimeout(1600);   // one sound per person every 1.5 s
    await b.click('#soundGrid .sound-btn:has-text("bruh")');
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sound:text-is("😂")');
    ok('uploaded sounds play for everyone too', true);

    await b.keyboard.press('Escape'); await b.mouse.click(700, 300);
    await b.click('#deafBtn');
    await a.waitForTimeout(1600);
    await a.click('#soundGrid .sound-btn:has-text("Bong")').catch(async () => { await a.click('#soundBtn'); await a.click('#soundGrid .sound-btn:has-text("Bong")'); });
    await a.waitForSelector('#tiles .tile:has-text("Poseidon") .tile-sound:text-is("🔔")');
    await b.waitForTimeout(800);
    ok('deafened people don’t hear the soundboard', await b.locator('#tiles .tile:has-text("Poseidon") .tile-sound').count() === 0);
    await b.click('#deafBtn');

    await a.locator('#soundGrid .sound:has-text("bruh")').hover();
    await a.click('#soundGrid .sound:has-text("bruh") .sound-del');
    await a.click('#cfOk');
    await b.click('#soundBtn').catch(() => {});
    await b.waitForSelector('#soundGrid .sound-btn:has-text("bruh")', { state: 'detached' });
    ok('removing a sound removes it for everyone', true);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
