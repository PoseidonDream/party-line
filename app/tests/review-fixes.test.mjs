/* The full code review's fixes, checked from the outside: admin rights belong to an account (not a name), 18+ messages
   don't leak to under-18s through side doors, moderators can't remove the owner, making channels and pinning need
   permissions, blocking covers group chats and calls, roles can't hand out more than you have, an owner leaving hands
   the server on, and a deleted message's number is never given to another message. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, openDb } from './lib.mjs';

/* What an authenticator app shows for a key (RFC 6238), `offset` 30-second steps away. */
function totp(key, offset = 0) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of key) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

export default async function (ok) {
  const srv = await startServer({ HOF_STARS: '1' });
  const conns = [];
  const post = (p, body) => fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const connect = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const pending = new Map(), seen = []; let rid = 0;
    const api = { seen, token, req: (t, data) => new Promise((res, rej) => { const id = ++rid; pending.set(id, (d) => (d.error ? rej(new Error(d.error)) : res(d))); ws.send(JSON.stringify(Object.assign({ t, rid: id }, data))); }) };
    ws.onmessage = (e) => { const d = JSON.parse(e.data); seen.push(d); if (d.t === 'ready') { api.ready = d; resolve(api); } if (d.t === 'ack' && pending.has(d.rid)) { pending.get(d.rid)(d); pending.delete(d.rid); } };
    ws.onerror = reject;
    conns.push(ws);
  });
  const join = async (name) => { const r = await post('/api/register', { name, password: 'pass1234', agree: true }); return Object.assign(await connect(r.token), { id: r.user.id, name, admin: r.user.admin }); };
  const tryReq = (l, t, d) => l.req(t, d).then((r) => r, (e) => ({ error: e.message }));
  const db = () => openDb(srv);
  const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); };
  try {
    // ---- 1. Admin rights belong to the account ----
    const P = await join('Poseidon');
    ok('the first account with the admin name is the admin', P.admin === true);
    await P.req('profile.rename', { name: 'Captain' });
    const stolen = await post('/api/register', { name: 'Poseidon', password: 'pass1234', agree: true });
    ok('after the admin renames, nobody can sign up with the admin name', stolen.status === 400 && /taken/.test(stolen.error));
    const K = await join('Kid');
    ok('…or rename to it', /taken/.test((await tryReq(K, 'profile.rename', { name: 'poseidon' })).error || ''));
    await srv.kill(); await srv.restart();
    const P2 = await connect(P.token), K2 = await connect(K.token);
    let d = db(); const admins = d.prepare('SELECT id FROM users WHERE is_admin = 1').all().map((r) => r.id); d.close();
    ok('after a restart the renamed admin is still the only admin', admins.length === 1 && admins[0] === P.id && P2.ready.me.admin === true);
    Object.assign(P, P2); Object.assign(K, K2);

    // ---- 2. 18+ messages don't leak ----
    const A = await join('Adult'), B = await join('Bea');
    for (const x of [P, A, B]) await x.req('age.set', { born: yearsAgo(30) });
    const serverId = P.ready.servers[0].id;
    const after = await P.req('chan.create', { serverId, kind: 'text', name: 'after-dark' });
    await P.req('chan.edit', { id: after.id, adult: true });
    const secret = (await A.req('msg.send', { channelId: after.id, body: 'grown-up talk', attachments: [] })).msg;
    ok('an under-18 can’t bookmark a message in an 18+ channel', /gone/.test((await tryReq(K, 'bookmark.set', { id: secret.id, on: true })).error || ''));
    ok('…or set a reminder on it, or react to it', /gone/.test((await tryReq(K, 'remind.set', { id: secret.id, at: Date.now() + 120_000 })).error || '') && /gone/.test((await tryReq(K, 'react', { id: secret.id, emoji: '👍', on: true })).error || ''));
    await B.req('react', { id: secret.id, emoji: '⭐', on: true });   // enough for the hall of fame here
    await new Promise((r) => setTimeout(r, 300));
    d = db(); const hof = d.prepare("SELECT COUNT(*) AS n FROM channels WHERE name = 'hall-of-fame'").get().n; d.close();
    ok('a starred message in an 18+ channel isn’t copied into #hall-of-fame', hof === 0);

    // ---- 3. Moderators can't remove the owner or an admin ----
    const M = await join('Mod');
    const modRole = (await P.req('role.create', { serverId, name: 'Mods', perms: ['kick', 'voice', 'server'] })).id;
    await P.req('role.assign', { roleId: modRole, userId: M.id, on: true });
    ok('a moderator can’t remove an admin from the server', /owner or an admin/.test((await tryReq(M, 'admin.kick', { serverId, userId: P.id })).error || ''));

    // ---- 10. Roles can't hand out more than you have ----
    const helper = (await P.req('role.create', { serverId, name: 'Helpers', perms: ['server'] })).id;
    const H = await join('Helper');
    await P.req('role.assign', { roleId: helper, userId: H.id, on: true });
    ok('someone with Manage server can’t make a role with powers they don’t have', /permissions you have/.test((await tryReq(H, 'role.create', { serverId, name: 'All', perms: ['kick'] })).error || ''));
    ok('…or give themselves a stronger role', /permissions you have/.test((await tryReq(H, 'role.assign', { roleId: modRole, userId: H.id, on: true })).error || ''));
    ok('…but can make one with the powers they have', !!(await tryReq(H, 'role.create', { serverId, name: 'Also helpers', perms: ['server'] })).id);

    // ---- 4. Making channels needs Manage channels ----
    ok('a member without Manage channels can’t make channels', /Manage channels/.test((await tryReq(K, 'chan.create', { serverId, kind: 'text', name: 'spam' })).error || ''));

    // ---- 9. Pinning in servers needs Manage messages ----
    const general = P.ready.servers[0].channels.find((c) => c.kind === 'text').id;
    const note = (await P.req('msg.send', { channelId: general, body: 'House rules: be nice', attachments: [] })).msg;
    ok('a member can’t pin or unpin in a server', /Manage messages/.test((await tryReq(K, 'msg.pin', { id: note.id, on: true })).error || ''));
    ok('…a moderator can', !(await tryReq(P, 'msg.pin', { id: note.id, on: true })).error);

    // ---- 5. Blocking covers group chats and calls ----
    const room = await M.req('call.start', { userId: K.id });   // they called once, before the block
    await K.req('block.set', { userId: M.id, on: true });
    ok('someone you blocked can’t put you in a group chat', /people you know/.test((await tryReq(M, 'group.create', { userIds: [K.id, A.id] })).error || ''));
    ok('…or call you through your old call room', /can’t call/.test((await tryReq(M, 'voice.join', { channelId: room.channelId })).error || ''));

    // ---- 25. The owner leaving hands the server on ---
    const own = await K.req('server.create', { name: 'Kid’s place' });
    d = db(); const code = d.prepare('SELECT invite FROM servers WHERE id = ?').get(own.id).invite; d.close();
    await A.req('server.join', { invite: code });
    await K.req('server.leave', { id: own.id });
    d = db(); const owner = d.prepare('SELECT owner_id FROM servers WHERE id = ?').get(own.id); d.close();
    ok('when the owner leaves, the server passes to the next member', owner && owner.owner_id === A.id);

    // ---- 23. A deleted message's number is never reused ----
    const gone = (await A.req('msg.send', { channelId: general, body: 'oops', attachments: [] })).msg;
    await A.req('remind.set', { id: gone.id, at: Date.now() + 120_000 });
    await A.req('msg.delete', { id: gone.id });
    await srv.kill(); await srv.restart();   // even across a restart
    const A2 = await connect(A.token);
    const next = (await A2.req('msg.send', { channelId: general, body: 'second try', attachments: [] })).msg;
    d = db(); const reminders = d.prepare('SELECT COUNT(*) AS n FROM msg_reminders WHERE message_id = ?').get(gone.id).n; d.close();
    ok(`a deleted message’s number isn’t given to the next one (${gone.id} → ${next.id})`, next.id > gone.id);
    ok('…and reminders about it go with it', reminders === 0);

    // ---- 6. With 2-step sign-in on, a password reset by email also needs the app's code ----
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-mail-'));
    const srv2 = await startServer({ MAIL_DIR: mailDir });
    try {
      const codeFor = () => { const f = fs.readdirSync(mailDir).sort().pop(); return /\b(\d{6})\b/.exec(JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8')).text)[1]; };
      const post2 = (p, body) => fetch(srv2.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
      const reg = await post2('/api/register', { name: 'Tia', password: 'pass1234', agree: true });
      const T = await new Promise((resolve) => {
        const ws = new WebSocket(`${srv2.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(reg.token)}`); let rid = 0; const pending = new Map();
        const api = { req: (t, data) => new Promise((res, rej) => { const id = ++rid; pending.set(id, (x) => (x.error ? rej(new Error(x.error)) : res(x))); ws.send(JSON.stringify(Object.assign({ t, rid: id }, data))); }) };
        ws.onmessage = (e) => { const x = JSON.parse(e.data); if (x.t === 'ready') resolve(api); if (x.t === 'ack' && pending.has(x.rid)) { pending.get(x.rid)(x); pending.delete(x.rid); } };
        conns.push(ws);
      });
      ok('adding an email needs the password', /password is wrong/.test((await tryReq(T, 'email.start', { email: 'tia@example.com' })).error || ''));
      await T.req('email.start', { email: 'tia@example.com', password: 'pass1234' });
      await T.req('email.confirm', { code: codeFor() });
      const { secret } = await T.req('totp.start', {});
      await T.req('totp.confirm', { code: totp(secret) });
      await post2('/api/reset-email', { name: 'Tia' });
      const mailed = codeFor();
      const without = await post2('/api/reset-email/confirm', { name: 'Tia', code: mailed, newPassword: 'newpass99' });
      ok('a reset by email asks for the 6-digit code too when 2-step sign-in is on', without.status === 400 && /2-step/.test(without.error));
      const withCode = await post2('/api/reset-email/confirm', { name: 'Tia', code: mailed, newPassword: 'newpass99', totp: totp(secret, 1) });
      ok('…and works with it', !!withCode.token);
    } finally { await srv2.stop(); }
  } finally { for (const ws of conns) try { ws.close(); } catch {} await srv.stop(); }
}
