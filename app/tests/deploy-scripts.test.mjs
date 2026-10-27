/* The server's automatic updates (deploy/auto-update.sh + update.sh), in a sandbox: a pretend GitHub (a bare git
   repo), a checkout like the one on the server, and a stand-in for docker that says how many people are in voice.
   Checks it waits while people are in voice, gives up waiting after 2 hours, updates when the coast is clear, and
   tells Party Bot (update-status.json) whether it worked. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(here, '..', '..', 'deploy');

export default async function (ok) {
  if (process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v git && command -v flock'], { stdio: 'ignore' }).status !== 0) { ok('deploy scripts: skipped (needs bash, git and flock)', true); return; }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-deploy-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  try {
    // pretend GitHub, and the "dev" checkout that pushes new versions to it
    const remote = path.join(box, 'remote.git'), dev = path.join(box, 'dev'), server = path.join(box, 'server'), bin = path.join(box, 'bin'), data = path.join(box, 'data');
    git(box, 'init', '-q', '--bare', '-b', 'app', remote);
    git(box, 'clone', '-q', remote, dev);
    git(dev, 'checkout', '-q', '-b', 'app');
    const cron = path.join(box, 'cron-file');
    for (const f of ['auto-update.sh', 'update.sh']) {
      fs.writeFileSync(path.join(dev, f), fs.readFileSync(path.join(DEPLOY, f), 'utf8').replaceAll('/etc/cron.d/party-line-update', cron).replaceAll('/tmp/party-line-auto-update.lock', path.join(box, 'lock')));
      fs.chmodSync(path.join(dev, f), 0o755);
    }
    fs.writeFileSync(path.join(dev, 'version.txt'), '1\n');
    git(dev, 'add', '.'); git(dev, 'commit', '-q', '-m', 'version 1'); git(dev, 'push', '-q', '-u', 'origin', 'app');
    git(box, 'clone', '-q', '-b', 'app', remote, server);
    // docker stand-in: voice count from a file, status written to the data folder, "up" fails when told to
    fs.mkdirSync(bin); fs.mkdirSync(data);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
args="$*"
case "$args" in
  *voice-count*) cat "${box}/voice" 2>/dev/null || echo 0 ;;
  *update-status.json*) cat > "${data}/update-status.json" ;;
  "compose up -d --build") [ -f "${box}/fail" ] && { echo "build error: something broke" >&2; exit 1; }; echo "built" ;;
  *) ;;
esac
`);
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const run = () => spawnSync(path.join(server, 'auto-update.sh'), [], { cwd: box, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    const version = () => fs.readFileSync(path.join(server, 'version.txt'), 'utf8').trim();
    const push = (v) => { fs.writeFileSync(path.join(dev, 'version.txt'), `${v}\n`); git(dev, 'commit', '-q', '-am', `version ${v}`); git(dev, 'push', '-q'); };
    const status = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'update-status.json'), 'utf8')); } catch { return null; } };

    let r = run();
    ok('nothing new: it does nothing', r.status === 0 && !r.stdout.trim() && version() === '1');
    push(2);
    fs.writeFileSync(path.join(box, 'voice'), '3');
    r = run();
    ok('a new version while 3 people are in voice: it waits', /new version waiting: 3 in voice/.test(r.stdout) && version() === '1' && fs.existsSync(path.join(server, '.update-waiting')));
    fs.writeFileSync(path.join(server, '.update-waiting'), String(Math.floor(Date.now() / 1000) - 7300));
    r = run();
    ok('…but not more than 2 hours (a forgotten open tab)', /updating to/.test(r.stdout) && version() === '2' && status() && status().ok === true);
    ok('the first update switches on the 10-minute check', fs.existsSync(cron) && /auto-update\.sh/.test(fs.readFileSync(cron, 'utf8')));
    push(3);
    fs.writeFileSync(path.join(box, 'voice'), '0');
    r = run();
    ok('nobody in voice: it updates right away', version() === '3' && !fs.existsSync(path.join(server, '.update-waiting')));
    push(4);
    fs.writeFileSync(path.join(box, 'fail'), '');
    r = run();
    const st = status();
    ok('a failed update is reported to the server (so Party Bot can warn the admins)', st && st.ok === false && /something broke/.test(st.error) && /version 4/.test(st.version));
    r = run();
    ok('right after a failed build it doesn’t hammer: no new try within the hour', !/updating to/.test(r.stdout));
    fs.rmSync(path.join(box, 'fail'));
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(path.join(server, '.last-try'), old, old);
    r = run();
    ok('an hour later it builds the downloaded version again, and this time it works', /updating to/.test(r.stdout) && status().ok === true
      && fs.readFileSync(path.join(server, '.built'), 'utf8').trim() === git(server, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(server, '.env'), 'AUTO_UPDATE=0\n');
    push(5);
    r = run();
    ok('AUTO_UPDATE=0 in .env turns it off', r.status === 0 && version() !== '5');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
}
