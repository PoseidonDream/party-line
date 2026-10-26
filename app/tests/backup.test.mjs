/* "Download a backup" in the developer panel: a .tgz with the database and every uploaded file, in the same
   format deploy/backup.sh makes (so `backup.sh restore` takes it). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-backup-'));
  try {
    const a = await signUp(browser, srv.url, 'Poseidon', { acceptDownloads: true });
    const b = await signUp(browser, srv.url, 'Bora');
    await b.setInputFiles('#fileInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('remember the milk') });
    await b.click('#chatForm button[type=submit]');
    await b.waitForSelector('#tray', { state: 'hidden' });

    const refused = await b.evaluate(async () => { const { api } = await import('/js/net.js'); return api('/api/dev/backup-link', { method: 'POST' }).catch((e) => e.message); });
    ok('only admins can download a backup', refused === 'Admins only.');

    await a.click('#railHome'); await a.click('#navDev');
    await a.waitForSelector('#devPanel[open] #devBackup');
    const [download] = await Promise.all([a.waitForEvent('download', { timeout: 15000 }), a.click('#devBackup')]);
    const file = path.join(dir, download.suggestedFilename());
    await download.saveAs(file);
    ok('the developer panel downloads party-line-backup-DATE.tgz', /^party-line-backup-\d{8}-\d{4}\.tgz$/.test(download.suggestedFilename()));
    execFileSync('tar', ['xzf', file, '-C', dir]);
    const db = new DatabaseSync(path.join(dir, 'snapshot.db'), { readOnly: true });
    const names = db.prepare('SELECT name FROM users ORDER BY id').all().map((r) => r.name);
    db.close();
    ok('it has every account', names.includes('Poseidon') && names.includes('Bora'));
    const files = fs.readdirSync(path.join(dir, 'uploads'));
    ok('and every uploaded file', files.some((f) => fs.readFileSync(path.join(dir, 'uploads', f), 'utf8') === 'remember the milk'));
    await a.waitForTimeout(300);
    ok('no temporary copy is left behind on the server', !fs.readdirSync(srv.dataDir).some((f) => f.startsWith('.backup-')));

    const again = await a.evaluate(async (u) => (await fetch(u)).status, new URL(download.url()).pathname);
    ok('a download link works only once', again === 404);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}
