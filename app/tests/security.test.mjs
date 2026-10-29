/* Security: the browser safety rules the server sends, password and sign-in limits, and limits that stop one person
   (or a broken app) flooding everyone. */
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ CSP_TEST_EVAL: '' });   // the rules exactly as on a real server
  const browser = await launchBrowser();
  const sockets = [];
  try {
    const post = (p, body, token) => fetch(srv.url + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}), body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
    const getAuthed = (p, token) => fetch(srv.url + p, { headers: { authorization: `Bearer ${token}` } });
    /* The live connection, from outside a browser, with request/answer pairs like the app's. */
    const connect = (token) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`${srv.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      sockets.push(ws);
      const pending = new Map(), seen = []; let rid = 0;
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data); seen.push(d);
        if (d.t === 'ready') resolve(api);
        if (d.t === 'ack' && pending.has(d.rid)) { pending.get(d.rid)(d); pending.delete(d.rid); }
      };
      ws.onerror = reject;
      const api = {
        seen,
        req: (t, data) => new Promise((r) => { const id = ++rid; pending.set(id, r); ws.send(JSON.stringify(Object.assign({ t, rid: id }, data))); }),
        closed: new Promise((r) => { ws.onclose = (e) => r(e.code); }),
      };
    });

    // The rules every page comes with
    const home = await fetch(srv.url + '/');
    const policy = home.headers.get('content-security-policy') || '';
    ok('pages only run the server’s own scripts (Content-Security-Policy)', /script-src 'self' https:\/\/www\.youtube\.com(;|$)/.test(policy) && !/script-src[^;]*unsafe-inline/.test(policy) && /object-src 'none'/.test(policy));
    ok('…can’t be shown inside another site', /frame-ancestors 'none'/.test(policy) && home.headers.get('x-frame-options') === 'DENY');
    ok('…and come with the other safety headers', home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('referrer-policy') === 'strict-origin-when-cross-origin' && /geolocation=\(\)/.test(home.headers.get('permissions-policy') || ''));
    ok('HTTPS-only (HSTS) is only sent over HTTPS', !home.headers.get('strict-transport-security'));
    const android = await fetch(srv.url + '/', { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 9; wv) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36' } });
    ok('…the Android app’s WebView may run its own bridge script', /script-src 'self' https:\/\/www\.youtube\.com 'unsafe-inline'/.test(android.headers.get('content-security-policy') || ''));

    const page = await signUp(browser, srv.url, 'Lale');
    const blocked = await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', '<img src="/nothing.png" onerror="window.__pwned = 1">');
      const s = document.createElement('script'); s.textContent = 'window.__pwned = 2'; document.head.appendChild(s);
      await new Promise((r) => setTimeout(r, 500));
      return window.__pwned === undefined;
    });
    ok('…so code slipped into the page doesn’t run', blocked && page.errors.some((e) => /Content Security Policy/.test(e)));
    page.errors.length = 0;

    // Passwords
    const short = await post('/api/register', { name: 'Shorty', password: 'abc1234', agree: true });
    ok('new passwords need at least 8 characters', short.status === 400 && /at least 8 characters/.test(short.error));
    const ana = await post('/api/register', { name: 'Ana', password: 'goodpass1', agree: true });
    const second = await post('/api/login', { name: 'Ana', password: 'goodpass1' });
    const noOne = await post('/api/login', { name: 'Nobody here', password: 'goodpass1' });
    const wrong = await post('/api/login', { name: 'Ana', password: 'nope-nope' });
    ok('a wrong name and a wrong password get the same answer', noOne.error === wrong.error && wrong.status === 400);
    const tooShort = await post('/api/password', { oldPassword: 'goodpass1', newPassword: 'short' }, ana.token);
    ok('…also when changing it', tooShort.status === 400 && /at least 8/.test(tooShort.error));
    const changed = await post('/api/password', { oldPassword: 'goodpass1', newPassword: 'betterpass2' }, ana.token);
    ok('changing your password signs out your other devices, not this one', changed.ok && (await getAuthed('/api/bookmarks', second.token)).status === 401 && (await getAuthed('/api/bookmarks', ana.token)).ok);

    // Guessing one account's password from many places: after 10 wrong tries it waits, even with the right one
    for (let i = 0; i < 9; i++) await post('/api/login', { name: 'Ana', password: `guess-${i}` });
    const locked = await post('/api/login', { name: 'Ana', password: 'betterpass2' });
    ok('after 10 wrong passwords for one account, it waits 15 minutes', locked.status === 400 && /Too many wrong tries/.test(locked.error));

    // Floods
    const live = await connect(ana.token);
    const results = [];
    for (let i = 0; i < 32; i++) results.push(await live.req('msg.send', { channelId: 1, body: `hello ${i}`, attachments: [] }));
    ok('at most 30 messages per person every 30 seconds', results.slice(0, 30).every((r) => r.msg) && /Slow down/.test(results[31].error || ''));
    const burst = await Promise.all(Array.from({ length: 400 }, () => live.req('ping', {})));
    ok('one connection can’t flood the server with requests', burst.filter((r) => r.pong).length >= 250 && burst.some((r) => r.error === 'Slow down a little.'));
    await new Promise((r) => setTimeout(r, 1500));
    ok('…and it recovers a moment later', !!(await live.req('ping', {})).pong);

    const guesses = [];
    for (let i = 0; i < 11; i++) guesses.push(await live.req('server.join', { invite: `nope${i}xyz` }));
    ok('guessing invite links stops after 10 that don’t work', /doesn’t work/.test(guesses[9].error) && /Too many invite links/.test(guesses[10].error));
    const fb = [];
    for (let i = 0; i < 6; i++) fb.push(await live.req('feedback.send', { kind: 'idea', body: `idea ${i}` }));
    ok('feedback: 5 in 10 minutes', fb.slice(0, 5).every((r) => r.id) && /plenty of feedback/.test(fb[5].error || ''));

    // A friend can't push "voice numbers" to an admin who didn't ask
    const admin = await connect((await post('/api/register', { name: 'Poseidon', password: 'adminpass1', agree: true })).token);
    const adminId = admin.seen.find((d) => d.t === 'ready').me.id;
    await live.req('dev.answer', { to: adminId, data: { fake: true } });
    await new Promise((r) => setTimeout(r, 300));
    ok('voice numbers only reach an admin who asked for them', !admin.seen.some((d) => d.t === 'dev.answer'));
    const anaId = live.seen.find((d) => d.t === 'ready').me.id;
    await admin.req('dev.ask', { userId: anaId });
    await live.req('dev.answer', { to: adminId, data: { ok: 1 } });
    await new Promise((r) => setTimeout(r, 300));
    ok('…and do when they ask', admin.seen.some((d) => d.t === 'dev.answer' && d.data.ok === 1));

    // A file name that isn't valid encoding doesn't break the upload
    const upload = await fetch(`${srv.url}/api/upload`, { method: 'POST', headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'text/plain', 'x-file-name': '%E0%A4%A' }, body: 'hi' });
    const file = await upload.json();
    ok('a broken file name is replaced, not an error', upload.ok && file.name === 'file');
    const served = await fetch(srv.url + file.url);
    ok('uploads keep their own, stricter rules (and other files only download)', /sandbox/.test(served.headers.get('content-security-policy') || '') && /^attachment/.test(served.headers.get('content-disposition') || ''));
    ok('no JavaScript errors', page.errors.length === 0);
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    await browser.close();
    await srv.stop();
  }

  // Sign-ins unused for a long time are forgotten (here: 1.5 seconds)
  const srv2 = await startServer({ SESSION_IDLE_MS: '1500' });
  try {
    const r = await (await fetch(`${srv2.url}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ece', password: 'goodpass1', agree: true }) })).json();
    const fresh = await fetch(`${srv2.url}/api/bookmarks`, { headers: { authorization: `Bearer ${r.token}` } });
    await new Promise((res) => setTimeout(res, 2000));
    const stale = await fetch(`${srv2.url}/api/bookmarks`, { headers: { authorization: `Bearer ${r.token}` } });
    ok('a sign-in unused for months is signed out', fresh.ok && stale.status === 401);
  } finally { await srv2.stop(); }
}
