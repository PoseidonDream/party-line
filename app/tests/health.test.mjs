/* Server health: a failed automatic update shows in the developer panel, and Party Bot tells the admins
   privately. Friends don’t get it. */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ HEALTH_EVERY: '2000' });
  fs.writeFileSync(path.join(srv.dataDir, 'update-status.json'), JSON.stringify({ ok: false, at: Math.floor(Date.now() / 1000), version: 'abc1234 Add things', error: 'npm ci failed' }));
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    await a.click('#railHome');
    await a.waitForSelector('#dmList .dm-item:has-text("Party Bot")', { timeout: 15000 });
    await a.click('#dmList .dm-item:has-text("Party Bot")');
    await a.waitForSelector('#messages .msg:has-text("automatic update failed")');
    ok('Party Bot tells the admin privately when an automatic update fails', (await a.textContent('#messages')).includes('npm ci failed'));
    await b.click('#railHome');
    ok('friends don’t get health notes', await b.locator('#dmList .dm-item:has-text("Party Bot")').count() === 0);
    await a.click('#navDev');
    await a.waitForSelector('#devPanel[open] .error:has-text("automatic update failed")');
    ok('the developer panel shows it under Health', true);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
