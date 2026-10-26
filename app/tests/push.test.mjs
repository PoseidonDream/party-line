/* Push notifications when Party Line is closed. A small local server stands in for Google's/Mozilla's push
   service and decrypts what Party Line sends, like a phone would. */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { startServer, launchBrowser, signUp, openPage, RESULTS } from './lib.mjs';

/* RFC 8291: how a browser decrypts a Web Push message. */
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16), idLen = body[20], asPublic = body.subarray(21, 21 + idLen), data = body.subarray(21 + idLen);
  const hmac = (key, ...parts) => { const h = crypto.createHmac('sha256', key); for (const p of parts) h.update(p); return h.digest(); };
  const uaPublic = ua.getPublicKey();
  const ikm = hmac(hmac(authSecret, ua.computeSecret(asPublic)), Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  let end = plain.length - 1; while (end > 0 && plain[end] === 0) end--;   // padding: 0x02 then zeros
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

export default async function (ok) {
  const got = [];
  let answer = 201;
  // Push services are HTTPS only: make a throwaway certificate for 127.0.0.1 that the test server trusts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const fake = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(answer); res.end(); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const endpoint = `https://127.0.0.1:${fake.address().port}/push/bora`;
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const waitPush = async (n, ms = 6000) => { const t = Date.now(); while (got.length < n && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 100)); return got.length >= n; };

  const srv = await startServer({ LINK_PREVIEW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    let b = await signUp(browser, srv.url, 'Bora');

    await b.click('#setBtn');
    ok('Settings offers notifications “even when Party Line is closed” in a browser', await b.isVisible('#pushField'));
    await b.keyboard.press('Escape');

    const sub = { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
    const r = await b.evaluate(async (s) => { const { api } = await import('/js/net.js'); return api('/api/push/subscribe', { method: 'POST', body: { subscription: s, device: 'test' } }).catch((e) => e.message); }, sub);
    ok('the server accepts a push subscription', r && r.ok);
    const bad = await b.evaluate(async (s) => { const { api } = await import('/js/net.js'); return api('/api/push/subscribe', { method: 'POST', body: { subscription: Object.assign({}, s, { endpoint: 'https://evil.example/x' }) } }).catch((e) => e.message); }, sub);
    ok('it refuses push addresses that aren’t a real push service', /push address/.test(bad));

    await b.fill('#chatInput', 'hi everyone'); await b.keyboard.press('Enter');
    await a.click('#messages .msg:has-text("hi everyone") .mini-av'); await a.click('#popMsg');
    await a.fill('#chatInput', 'you there?'); await a.keyboard.press('Enter');
    await a.waitForSelector('#messages .msg:has-text("you there?")');
    await a.waitForTimeout(1000);
    ok('no push while they have Party Line open', got.length === 0);

    const bCtx = b.context(); await bCtx.close();
    await a.waitForTimeout(500);
    await a.fill('#chatInput', 'dinner at **8**?'); await a.keyboard.press('Enter');
    ok('a private message sends a push once they’ve closed Party Line', await waitPush(1));
    const p1 = decrypt(got[0].body, ua, authSecret);
    ok('it’s encrypted for their browser, and reads “Poseidon: dinner at 8?”', p1.title === 'Poseidon' && p1.body === 'dinner at 8?' && /^\/\?dm=\d+$/.test(p1.url));
    ok('it’s signed with the server’s key (VAPID)', /^vapid t=.+, k=.+/.test(got[0].headers.authorization || ''));

    await a.click('#railList .rail-btn'); await a.click('#textList .chan:has-text("general")');
    await a.fill('#chatInput', 'just chatting'); await a.keyboard.press('Enter');
    await a.waitForTimeout(1200);
    ok('ordinary server messages don’t buzz their phone', got.length === 1);
    await a.fill('#chatInput', '@Bor'); await a.waitForSelector('#mentionPop:not([hidden])'); await a.keyboard.press('Enter');
    await a.type('#chatInput', 'come play'); await a.keyboard.press('Enter');
    ok('an @mention does', await waitPush(2));
    const p2 = decrypt(got[1].body, ua, authSecret);
    ok('and says where: “Poseidon in #general”', p2.title.startsWith('Poseidon in #general') && p2.body === '@Bora come play');

    // A browser that was uninstalled or reset: the push service answers 410 Gone
    b = await openPage(browser, srv.url);   // signed out on a fresh device: doesn't count as online
    answer = 410;
    await a.click('#railHome'); await a.click('#dmList .dm-item:has-text("Bora")');
    await a.fill('#chatInput', 'one more'); await a.keyboard.press('Enter');
    await waitPush(3);
    answer = 201;
    await a.fill('#chatInput', 'and another'); await a.keyboard.press('Enter');
    await a.waitForTimeout(1500);
    ok('when the push service says the browser is gone, the server forgets it', got.length === 3);
    await a.screenshot({ path: `${RESULTS}/push.png` });

    const errs = [...a.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
