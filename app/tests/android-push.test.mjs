/* Android notifications while the app is closed (Firebase Cloud Messaging). Google's two services are stand-ins
   here: the sign-in (which checks the server's signed token against the service account's key) and the message
   sender (which records what arrives). A phone app signs up, closes, and gets a private message. */
import crypto from 'node:crypto';
import http from 'node:http';
import { startServer, launchBrowser, signUp, androidContext, openDb } from './lib.mjs';

export default async function (ok) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sent = [], logins = [];
  let goneNext = false, bare404Next = false;
  const google = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        const jwt = new URLSearchParams(body).get('assertion') || '';
        const [h, c, s] = jwt.split('.');
        const good = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s || '', 'base64url'));
        logins.push({ good, claims: JSON.parse(Buffer.from(c || '', 'base64url').toString() || '{}') });
        res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(good ? { access_token: 'access-123', expires_in: 3600 } : { error: 'invalid_grant' }));
      }
      sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      if (bare404Next) { bare404Next = false; res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } })); }
      if (goneNext) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"projects/test-proj/messages/1"}');
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const g = `http://127.0.0.1:${google.address().port}`;
  const account = { type: 'service_account', project_id: 'test-proj', client_email: 'party-line@test-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const srv = await startServer({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(account)).toString('base64'), FIREBASE_TOKEN_URL: `${g}/token`, FCM_BASE_URL: g });
  const browser = await launchBrowser();
  try {
    const TOKEN = `phone-${'x'.repeat(60)}`;
    const ctx = await androidContext(browser, srv.url, { getPushToken: { token: TOKEN }, getVersion: { code: 30, name: '1.0.30', fromPlay: true } });
    const phone = await ctx.newPage();
    await phone.goto(`${srv.url}/app`);
    await phone.click('#tabRegister'); await phone.fill('#authName', 'Lale'); await phone.fill('#authPass', 'pass1234'); await phone.check('#authAgree'); await phone.click('#authBtn');
    await phone.waitForSelector('#room:not([hidden])');
    const db = openDb(srv);
    const subs = () => db.prepare("SELECT endpoint FROM push_subs WHERE endpoint LIKE 'fcm:%'").all().map((r) => r.endpoint);
    for (let i = 0; i < 20 && !subs().length; i++) await phone.waitForTimeout(250);
    ok('the Android app gives the server its notification address when it opens', subs().includes(`fcm:${TOKEN}`));

    await phone.evaluate(() => document.querySelector('#setBtn').click());
    await phone.click('#settings [data-settab="alerts"]');
    ok('…Settings → Alerts shows “Even when Party Line is closed”, on', await phone.isVisible('#pushField') && await phone.isChecked('#setPush'));
    await phone.click('#setPush');
    for (let i = 0; i < 20 && subs().length; i++) await phone.waitForTimeout(250);
    ok('…and turning it off forgets the address', !subs().length);
    await phone.click('#setPush');
    for (let i = 0; i < 20 && !subs().length; i++) await phone.waitForTimeout(250);
    await phone.keyboard.press('Escape');

    // Closed: a private message arrives through Firebase
    const bora = await signUp(browser, srv.url, 'Bora');
    await ctx.close();
    await bora.waitForTimeout(800);
    const laleId = db.prepare("SELECT id FROM users WHERE name = 'Lale'").get().id;
    await bora.evaluate(async (id) => { const { live } = await import('/js/net.js'); await live.req('msg.send', { toUserId: id, body: 'are you coming tonight?', attachments: [] }); }, laleId);
    for (let i = 0; i < 40 && !sent.length; i++) await bora.waitForTimeout(250);
    const m = sent[0] && sent[0].body.message;
    ok('with the app closed, a private message goes to the phone through Firebase', !!m && m.token === TOKEN && m.data.title === 'Bora' && m.data.body === 'are you coming tonight?');
    ok('…opening that chat when tapped, as a high-priority message', !!m && /^\/app\?dm=\d+$/.test(m.data.url) && m.android.priority === 'high');
    ok('…sent with the server’s own signed sign-in (service account, Firebase messaging only)', logins.length >= 1 && logins.every((l) => l.good) && logins[0].claims.iss === account.client_email && /firebase\.messaging/.test(logins[0].claims.scope) && sent[0].auth === 'Bearer access-123' && sent[0].url === '/v1/projects/test-proj/messages:send');
    ok('…signing in to Firebase once, not once per notification', logins.length === 1);
    bare404Next = true;   // what a wrong project in the settings looks like
    await bora.evaluate(async (id) => { const { live } = await import('/js/net.js'); await live.req('msg.send', { toUserId: id, body: 'still there?', attachments: [] }); }, laleId);
    for (let i = 0; i < 20 && bare404Next; i++) await bora.waitForTimeout(250);
    await bora.waitForTimeout(500);
    ok('a plain “not found” (like a wrong project in the settings) keeps the phone’s address', subs().length === 1);
    goneNext = true;
    await bora.evaluate(async (id) => { const { live } = await import('/js/net.js'); await live.req('msg.send', { toUserId: id, body: 'hello?', attachments: [] }); }, laleId);
    for (let i = 0; i < 40 && subs().length; i++) await bora.waitForTimeout(250);
    ok('an address Firebase says is gone (app uninstalled) is forgotten', !subs().length);
    db.close();
    ok(`no JavaScript errors${bora.errors.length ? ': ' + bora.errors.join(' | ') : ''}`, !bora.errors.length);
  } finally { await browser.close(); await srv.stop(); google.close(); }
}
