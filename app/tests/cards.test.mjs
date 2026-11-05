/* Link cards: what WhatsApp, Instagram or Discord show when someone pastes Party Line's address or an invite link
   (Open Graph tags: a title, a line about it and a picture). Invite links say who invited you, and to which server. */
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';

const WHATSAPP = 'WhatsApp/2.24.1 A';
const tag = (html, prop) => { const m = new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(html); return m && m[1]; };

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const page = async (p) => (await fetch(srv.url + p, { headers: { 'user-agent': WHATSAPP } })).text();
    const home = await page('/');
    ok('the main address has a card: title, description and a picture', tag(home, 'og:title') === 'Party Line' && /voice, chat/.test(tag(home, 'og:description')) && tag(home, 'og:image') === `${srv.url}/img/share.png`);
    const img = await fetch(`${srv.url}/img/share.png`);
    ok('…the picture is there (1200×630)', img.ok && img.headers.get('content-type') === 'image/png' && tag(home, 'og:image:width') === '1200');

    const a = await signUp(browser, srv.url, 'Deniz');
    const req = (t, d) => a.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
    const { code } = await req('invite.create', { serverId: 1, hours: 24 });
    const inv = await page(`/invite/${code}`);
    ok('an invite link’s card says who invited you, and to which server', tag(inv, 'og:title') === 'Deniz invited you to Party Line' && /Join Party Line/.test(tag(inv, 'og:description')));
    ok('…and the link still opens the app to join', inv.includes('id="join"'));
    const s2 = (await req('server.create', { name: 'Fun & "Games" <3' })).id;
    const db = openDb(srv); const perm = db.prepare('SELECT invite FROM servers WHERE id = ?').get(s2).invite;
    const odd = await page(`/invite/${perm}`);
    ok('…names are written safely (a server called Fun & "Games" <3)', tag(odd, 'og:title') === 'You’re invited to Fun &amp; &quot;Games&quot; &lt;3' && !odd.includes('"Games" <3'));
    db.prepare('UPDATE invites SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, code); db.close();
    ok('…an expired invite says so', tag(await page(`/invite/${code}`), 'og:title') === 'This invite has expired');
    ok(`no JavaScript errors${a.errors.length ? ': ' + a.errors.join(' | ') : ''}`, !a.errors.length);
  } finally { await browser.close(); await srv.stop(); }
}
