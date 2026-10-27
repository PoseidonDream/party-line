/* Soundboard: built-in sounds reach everyone in the voice channel, uploading a short sound, too-long clips are
   refused, removing a sound, and deafened people don't hear it. */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchBrowser, signUp, joinVoice, RESULTS, openDb } from './lib.mjs';

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
    await a.setInputFiles('#soundFile', { name: 'bruh.wav', mimeType: 'audio/wav', buffer: wav(9) });
    await a.waitForSelector('#soundTrim:not([hidden])');
    ok('a long clip isn’t refused: you pick which 7 seconds to use', (await a.textContent('#soundFileName')).includes('9.0 s') && await a.getAttribute('#soundLen', 'max') === '7' && await a.getAttribute('#soundStart', 'max') === '2');
    await a.locator('#soundStart').fill('1.5');
    ok('…and the part you picked is shown', (await a.textContent('#soundRange')).includes('0:01.5 – 0:08.5'));
    await a.click('#soundPreview');
    ok('…and can be previewed', (await a.textContent('#soundPreview')).includes('Stop'));
    await a.fill('#soundEmoji', '😂');
    await a.click('#soundForm button[type=submit]');
    await a.waitForSelector('.toast:has-text("Sound added")');
    await b.click('#soundBtn');
    await b.waitForSelector('#soundGrid .sound-btn:has-text("bruh")');
    ok('an uploaded sound shows on everyone’s soundboard', true);
    const db = openDb(srv);
    const saved = fs.readFileSync(path.join(srv.dataDir, 'uploads', db.prepare("SELECT upload_id FROM sounds WHERE name = 'bruh'").get().upload_id));
    const secs = saved.readUInt32LE(40) / (saved.readUInt32LE(24) * 2);
    ok(`…saved as just the part you picked (${secs.toFixed(2)} s of WAV, ${Math.round(saved.length / 1024)} KB)`, saved.toString('ascii', 8, 12) === 'WAVE' && Math.abs(secs - 7) < 0.02 && saved.length <= 1048576);
    db.close();
    // Everyone can add sounds, not only admins: up to 10 each.
    await b.click('#soundAddBtn');
    // a video works too: its sound is used (a 2-second clip recorded right here, picture and sound)
    const video = await b.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
      const ac = new AudioContext(), osc = ac.createOscillator(), dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
      const st = new MediaStream([...c.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const rec = new MediaRecorder(st, { mimeType: 'video/webm;codecs=vp8,opus' }), parts = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      const timer = setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; g.fillRect(0, 0, 64, 64); }, 60);
      rec.start(); await new Promise((r) => setTimeout(r, 2000)); rec.stop(); await new Promise((r) => { rec.onstop = r; });
      clearInterval(timer); osc.stop(); ac.close();
      return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
    });
    await b.setInputFiles('#soundFile', { name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(video) });
    await b.waitForSelector('#soundTrim:not([hidden])');
    ok(`…and a video works too: its sound is used (${await b.textContent('#soundFileName')})`, /clip\.webm · [12]\.\d s/.test(await b.textContent('#soundFileName')));
    await b.setInputFiles('#soundFile', { name: 'oof.wav', mimeType: 'audio/wav', buffer: wav(1) });
    await b.waitForSelector('#soundFileName:has-text("oof.wav · 1.0 s")');
    ok('…a short clip needs no picking: it uses all of it', await b.getAttribute('#soundStart', 'max') === '0');
    await b.click('#soundForm button[type=submit]');
    await a.waitForSelector('#soundGrid .sound-btn:has-text("oof")');
    ok('a regular member (not an admin) can add sounds too', true);
    const limit = await b.evaluate(async (bytes) => {
      const { live, upload } = await import('/js/net.js');
      let last = '';
      for (let i = 2; i <= 11; i++) {
        const up = await upload('/api/upload', new File([new Uint8Array(bytes)], `s${i}.wav`, { type: 'audio/wav' }));
        try { await live.req('sound.add', { serverId: 1, uploadId: up.id, name: `s${i}`, emoji: '🔊' }); last = `added ${i}`; } catch (e) { last = e.message; }
      }
      return last;
    }, [...wav(0.2)]);
    ok(`…up to 10 each, so nobody fills the board for everyone (${limit})`, /added 10 sounds here already/.test(limit));
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
