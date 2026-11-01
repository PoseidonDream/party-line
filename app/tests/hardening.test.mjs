/* The security checklist, checked from the outside: no private files reachable, no other sites allowed in (CORS),
   no server internals in errors, one oversized message can't stop the server, invisible direction-flipping
   characters are removed, a member can't touch a server they're not in (or admin tools), code in messages and names
   stays text, passwords are strongly hashed (older ones upgraded at sign-in), sign-ins are stored only as
   fingerprints, the database is private to the server, and a script hammering the API is slowed down. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ API_PER_MIN: '400' });
  const browser = await launchBrowser();
  try {
    const get = (p, init) => fetch(srv.url + p, init);

    // Exposed files
    const probes = ['/.git/config', '/.env', '/deploy/.env', '/../deploy/.env', '/%2e%2e/%2e%2e/deploy/.env', '/server/src/index.js', '/src/index.js', '/package.json',
      '/party-line.db', '/data/party-line.db', '/uploads/..%2f..%2fpackage.json', '/uploads/../package.json', '/node_modules/express/package.json', '/js/main.js.map', '/.gitignore'];
    const leaks = [];
    for (const p of probes) {
      const r = await get(p); const body = await r.text();
      const isApp = body.includes('<title>Party Line</title>');   // an unknown address may show the app itself, which is fine
      if (r.status === 200 && !isApp) leaks.push(`${p} (${r.status})`);
      if (/TURN_SECRET|pass_hash|SQLite format|"dependencies"|import express/.test(body)) leaks.push(`${p} shows private content`);
    }
    ok(`no private files can be opened from outside (.env, .git, source code, database, packages)${leaks.length ? ': ' + leaks.join(', ') : ''}`, !leaks.length);

    // CORS and errors
    const cors = await get('/api/info', { headers: { origin: 'https://evil.example' } });
    const pre = await get('/api/login', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    ok('other websites aren’t allowed to read the API (no CORS headers)', !cors.headers.get('access-control-allow-origin') && !pre.headers.get('access-control-allow-origin'));
    const broken = await get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": nope' });
    const brokenBody = await broken.text();
    ok('a broken request gets a short answer, without the server’s insides', broken.status === 400 && !/at \w+ \(|node_modules|\.js:\d+|SyntaxError/.test(brokenBody));
    ok('…and the server doesn’t say what it’s built with', !cors.headers.get('x-powered-by'));

    // People
    const vic = await signUp(browser, srv.url, 'Vic');
    const third = await signUp(browser, srv.url, 'Third');
    const mal = await signUp(browser, srv.url, 'Mal');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); try { return { ok: await live.req(t, d) }; } catch (e) { return { err: String(e.message || e) }; } }, [t, d]);
    const db = openDb(srv);
    const idOf = (n) => db.prepare('SELECT id FROM users WHERE name = ?').get(n).id;

    // One oversized message
    await mal.evaluate(() => { window.__bigClosed = new Promise((r) => { const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?token=' + JSON.parse(localStorage.getItem('pl:token'))); ws.onopen = () => ws.send(JSON.stringify({ t: 'msg.send', rid: 1, channelId: 1, body: 'x'.repeat(400 * 1024) })); ws.onclose = (e) => r(e.code); }); });
    const code = await mal.evaluate(() => window.__bigClosed);
    const alive = await get('/api/info').then((r) => r.ok).catch(() => false);
    ok('one oversized message only closes that connection: the server keeps running', alive && code === 1009);
    ok('…and everyone else stays connected', !!(await req(vic, 'msg.send', { channelId: 1, body: 'still here', attachments: [] })).ok);

    // Direction-flipping characters
    const flip = '‮';
    const r1 = await get('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Ev${flip}il`, password: 'pass1234', agree: true }) });
    const created = (await r1.json()).user;
    const sent = await req(vic, 'msg.send', { channelId: 1, body: `see https://good.example/${flip}gpj.exe`, attachments: [] });
    const s2 = (await req(vic, 'server.create', { name: `Vic${flip} place` })).ok.id;
    ok('invisible direction-flipping characters are removed from names, servers and messages', created.name === 'Evil' && !sent.ok.msg.body.includes(flip) && db.prepare('SELECT name FROM servers WHERE id = ?').get(s2).name === 'Vic place');

    // A member of one server can't touch another
    const c2 = db.prepare("SELECT id FROM channels WHERE server_id = ? AND kind = 'text'").get(s2).id;
    const secret = (await req(vic, 'msg.send', { channelId: c2, body: 'only for my server', attachments: [] })).ok.msg.id;
    const dm = (await req(vic, 'msg.send', { toUserId: idOf('Third'), body: 'just between us', attachments: [] })).ok.msg.id;
    const tries = {
      'post in it': await req(mal, 'msg.send', { channelId: c2, body: 'hi', attachments: [] }),
      'edit a message there': await req(mal, 'msg.edit', { id: secret, body: 'changed' }),
      'delete a message there': await req(mal, 'msg.delete', { id: secret }),
      'react to it': await req(mal, 'react', { id: secret, emoji: '🔥', on: true }),
      'make a channel': await req(mal, 'chan.create', { serverId: s2, kind: 'text', name: 'mine' }),
      'make an invite': await req(mal, 'invite.create', { serverId: s2 }),
      'give itself a role': await req(mal, 'role.assign', { serverId: s2, userId: idOf('Mal'), roleId: 1, on: true }),
      'rename it': await req(mal, 'server.rename', { id: s2, serverId: s2, name: 'mine now' }),
      'delete it': await req(mal, 'server.delete', { id: s2, serverId: s2 }),
      'pin someone else’s private message': await req(mal, 'msg.pin', { id: dm, on: true }),
    };
    const got = Object.entries(tries).filter(([, r]) => r.ok).map(([k]) => k);
    const reads = await mal.evaluate(async ([c2, V]) => {
      const h = { authorization: 'Bearer ' + JSON.parse(localStorage.getItem('pl:token')) };
      const j = (u) => fetch(u, { headers: h }).then((r) => r.text());
      return [await j(`/api/channels/${c2}/messages`), await j(`/api/pins?channelId=${c2}`), await j(`/api/media?channelId=${c2}`), await j('/api/search?q=only'), await j('/api/search?q=between')].join(' ');
    }, [c2, idOf('Vic')]);
    const still = db.prepare('SELECT body FROM messages WHERE id = ?').get(secret);
    ok(`someone not in a server can’t post, change, delete or manage anything in it${got.length ? ' (could: ' + got.join(', ') + ')' : ''}`, !got.length && still && still.body === 'only for my server');
    ok('…or read it, or other people’s private chats', !/only for my server|just between us/.test(reads));
    const adminTries = ['dev.stats', 'report.list', 'usage.stats', 'feedback.list', 'invite.list'].map((t) => [t, null]);
    adminTries.push(['admin.resetPassword', { userId: idOf('Vic') }], ['admin.kick', { serverId: 1, userId: idOf('Vic') }]);
    const adminGot = [];
    for (const [t, d] of adminTries) { const r = await req(mal, t, d || { serverId: s2 }); if (r.ok && !(t === 'invite.list' && !(r.ok.invites || []).length)) adminGot.push(t); }
    ok(`admin tools refuse people who aren’t admins${adminGot.length ? ' (allowed: ' + adminGot.join(', ') + ')' : ''}`, !adminGot.length);

    // Code in messages and names stays text
    await req(mal, 'msg.send', { channelId: 1, body: '<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> [click](javascript:window.__xss=3)', attachments: [] });
    await req(mal, 'profile.set', { bio: '<img src=x onerror="window.__xss=4">', custom: '<b onmouseover="window.__xss=5">hi</b>' });
    await vic.waitForSelector('#messages .msg:has-text("onerror")');
    const xss = await vic.evaluate(() => ({ ran: window.__xss, imgs: document.querySelectorAll('#messages .msg-body img:not(.c-emoji)').length, js: document.querySelectorAll('a[href^="javascript:"]').length, scripts: document.querySelectorAll('#messages script').length }));
    ok('code typed into a message or profile shows as text and never runs', xss.ran === undefined && !xss.imgs && !xss.js && !xss.scripts);

    // Passwords and sign-ins
    const hashOf = (n) => db.prepare('SELECT pass_hash FROM users WHERE name = ?').get(n).pass_hash;
    ok('passwords are kept as strong scrypt fingerprints (N=2^15, r=8, p=3)', /^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{64}$/.test(hashOf('Vic')));
    const salt = crypto.randomBytes(16);
    db.prepare('UPDATE users SET pass_hash = ? WHERE name = ?').run(`${salt.toString('hex')}:${crypto.scryptSync('pass1234', salt, 32).toString('hex')}`, 'Third');
    const login = await get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Third', password: 'pass1234' }) });
    ok('an older, weaker fingerprint still signs in, and is upgraded on the spot', login.ok && hashOf('Third').startsWith('scrypt:32768:8:3:'));
    const token = await vic.evaluate(() => JSON.parse(localStorage.getItem('pl:token')));
    const rows = db.prepare('SELECT * FROM sessions').all();
    ok('sign-ins are stored only as fingerprints: a copy of the database can’t be used to sign in', rows.length > 0 && !JSON.stringify(rows).includes(token));
    db.close();
    if (process.platform !== 'win32') {
      const mode = (f) => fs.statSync(path.join(srv.dataDir, f)).mode & 0o777;
      ok('the database file is readable by the server only', mode('party-line.db') === 0o600 && (fs.statSync(srv.dataDir).mode & 0o077) === 0);
    }

    // A script hammering the API
    const burst = await Promise.all(Array.from({ length: 450 }, () => get('/api/info').then((r) => r.status)));
    ok('a script hammering the API is told to slow down', burst.includes(429) && burst.filter((s) => s === 200).length >= 50);

    const errs = [...vic.errors, ...third.errors, ...mal.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
