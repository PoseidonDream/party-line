/* Backups to this computer (turned on by an admin in the developer panel, on the computer they choose): when Party Line
   opens there (at most once a day), the newest full backup of the server is saved in Documents/Party Line backups (or
   the folder they chose). The older one is deleted only after the new one is completely written and checked, so
   there's always one good copy. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const NAME = /^party-line-backup-[\w-]+\.tgz(\.part)?$/;

async function saveBackup(href, dir, fetchFn) {
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetchFn(href);
  if (!res.ok || !res.body) throw new Error(`The server didn’t send a backup (${res.status}).`);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `party-line-backup-${stamp}.tgz`), part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { mode: 0o600 }));
    // A whole, readable archive (not cut off halfway), or it doesn't count
    await pipeline(fs.createReadStream(part), zlib.createGunzip(), new Writable({ write: (c, e, next) => next() }));
    fs.renameSync(part, file);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw new Error(/unexpected end|incorrect header|invalid/i.test(e.message) ? 'The backup came through incomplete.' : e.message);
  }
  for (const f of fs.readdirSync(dir)) if (NAME.test(f) && path.join(dir, f) !== file) fs.rmSync(path.join(dir, f), { force: true });
  return { file, bytes: fs.statSync(file).size };
}

module.exports = { saveBackup, NAME };
