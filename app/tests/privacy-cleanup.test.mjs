/* People only see each other when they share a server, are friends, or have chatted.
   Photos nobody uses any more are deleted from the server. */
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

export default async function (ok) {
  const srv = await startServer({ CLEANUP_FIRST_MS: '1000' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Ayla');
    const b = await signUp(browser, srv.url, 'Bulut');
    // Bulut leaves the main server, so the two share nothing.
    await b.click('#serverBtn'); await b.click('#mLeave'); await b.click('#cfOk');
    await b.waitForSelector('#viewHome:not([hidden])');
    const c = await signUp(browser, srv.url, 'Cem');   // joins after Bulut left
    // Look at the raw data the server sends Bulut when the app starts
    const frames = [];
    b.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
    await b.reload(); await b.waitForSelector('#room:not([hidden])');
    await b.waitForTimeout(300);
    const ready = JSON.parse(frames.find((f) => f.includes('"t":"ready"')));
    const names = ready.users.map((u) => u.name);
    ok(`someone who shares nothing with you isn’t sent your details (Bulut gets: ${names.join(', ')})`, !names.includes('Cem') && !names.includes('Ayla'));
    const cFrames = [];
    c.on('websocket', (ws) => ws.on('framereceived', (f) => cFrames.push(String(f.payload))));
    await c.reload(); await c.waitForSelector('#room:not([hidden])');
    await b.reload(); await b.waitForSelector('#room:not([hidden])');
    await c.waitForTimeout(500);
    ok('nor told when you come online', !cFrames.some((f) => f.includes('"t":"presence"') && f.includes(`"userId":${ready.me.id}`)));
    // A friend request makes them visible to each other
    await b.click('.tab[data-tab="add"]'); await b.fill('#frAddName', 'Cem'); await b.click('#frAddForm button[type=submit]');
    await c.click('#railHome'); await c.click('#navFriends'); await c.click('.tab[data-tab="pending"]');
    await c.waitForSelector('.fr-row:has-text("Bulut")', { timeout: 5000 });
    ok('a friend request introduces you', true);

    // cleanup: upload a photo, send it, delete the message, run cleanup with no waiting
    const token = await a.evaluate(() => JSON.parse(localStorage.getItem('pl:token')));
    const up = await (await fetch(`${srv.url}/api/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body: Buffer.from('fake') })).json();
    const file = path.join(srv.dataDir, 'uploads', up.id);
    ok('upload is stored', fs.existsSync(file));
    const db = openDb(srv);
    db.prepare('UPDATE uploads SET created_at = 0 WHERE id = ?').run(up.id);   // pretend it is old
    db.close();
    await srv.kill(); await srv.restart();
    await new Promise((r) => setTimeout(r, 2500));
    ok('an old upload that was never sent gets deleted', !fs.existsSync(file));
  } finally { await browser.close(); await srv.stop(); }
}
