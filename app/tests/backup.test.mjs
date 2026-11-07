/* "Download a backup" in the developer panel: a .tgz with the database and every uploaded file, in the same
   format deploy/backup.sh makes (so `backup.sh restore` takes it). And in the desktop app, a backup saved on this
   computer each time Party Line opens there, keeping only the newest. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

const { saveBackup } = createRequire(import.meta.url)('../desktop/src/backup.js');
// A stand-in for the desktop app's bridge: "saving" fetches the backup, and counts (across reloads)
const BRIDGE = `window.partyLineDesktop = {
  version: '9.9.9', setBadge() {}, focus() {}, onPtt() {}, onActivity() {}, setTheme() {}, onHotkey() {}, setOverlay() {},
  async saveBackup(url) { const b = await (await fetch(url)).arrayBuffer(); localStorage.setItem('__saved', String(Number(localStorage.getItem('__saved') || 0) + 1)); return { file: 'x.tgz', bytes: b.byteLength }; },
  async backupFolder() { return '/Users/me/Documents/Party Line backups'; }, openBackupFolder() { window.__opened = 1; },
};`;

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-backup-'));
  let errsD = [];
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
    // The desktop app's part: saving the newest backup in a folder, and deleting the older one after
    const link = () => a.evaluate(async () => { const { api } = await import('/js/net.js'); return (await api('/api/dev/backup-link', { method: 'POST' })).url; });
    const folder = path.join(dir, 'Party Line backups');
    const first = await saveBackup(srv.url + await link(), folder, fetch);
    await a.waitForTimeout(1100);
    const second = await saveBackup(srv.url + await link(), folder, fetch);
    const kept = fs.readdirSync(folder);
    ok('the desktop app saves the newest backup in “Party Line backups” and deletes the older one', kept.length === 1 && kept[0] === path.basename(second.file) && first.file !== second.file && second.bytes > 0);
    ok('…a whole backup, ready to restore', execFileSync('tar', ['tzf', second.file], { encoding: 'utf8' }).includes('snapshot.db'));
    const cut = await saveBackup('x', folder, async () => new Response(fs.readFileSync(second.file).subarray(0, 300))).then(() => 'saved', (e) => e.message);
    ok('…and one that comes through incomplete isn’t kept: the older good one stays', /incomplete/.test(cut) && String(fs.readdirSync(folder)) === path.basename(second.file));

    // The page's part, in the desktop app: a switch in the developer panel, then a backup each time it opens
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(BRIDGE);
    const d = await ctx.newPage(); d.errors = []; d.on('pageerror', (e) => d.errors.push(e.message));
    const token = await a.evaluate(() => localStorage.getItem('pl:token'));
    await d.goto(srv.url + '/app'); await d.evaluate((t) => localStorage.setItem('pl:token', t), token);
    await d.reload(); await d.waitForSelector('#room:not([hidden])');
    await d.click('#railHome'); await d.click('#navDev');
    await d.waitForSelector('#devPanel[open] #devBackupHere');
    ok('in the desktop app, the developer panel offers “Back up to this computer each time I open Party Line here”, off at first', !(await d.isChecked('#devBackupHere')));
    await d.check('#devBackupHere');
    await d.waitForFunction(() => localStorage.getItem('__saved') === '1', null, { timeout: 15000 });
    await d.waitForSelector('#devBackupHereInfo:has-text("Last one")');
    ok('…turning it on saves one straight away, and says where', (await d.textContent('#devBackupHereInfo')).includes('Party Line backups'));
    await d.locator('#devBackupHere').scrollIntoViewIfNeeded();
    await d.locator('#devPanel').screenshot({ path: path.join(RESULTS, 'backup-here.png') });
    await d.reload(); await d.waitForSelector('#room:not([hidden])'); await d.waitForTimeout(2000);
    ok('…opening the app again right away doesn’t save another (at most one a day)', await d.evaluate(() => localStorage.getItem('__saved')) === '1');
    await d.evaluate(() => localStorage.setItem('pl:backupHereLast', JSON.stringify({ at: Date.now() - 25 * 3600_000, bytes: 1 })));
    await d.reload(); await d.waitForSelector('#room:not([hidden])');
    await d.waitForFunction(() => localStorage.getItem('__saved') === '2', null, { timeout: 15000 });
    await d.waitForSelector('.toast:has-text("Backup saved on this computer")');
    ok('…later, opening Party Line on that computer saves a new one (and the older one is deleted)', true);
    const bNone = await b.evaluate(() => localStorage.getItem('__saved'));
    ok('…only there: other devices don’t', bNone === null);
    errsD = d.errors;
    await ctx.close();

    const errs = [...a.errors, ...b.errors, ...errsD];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}
