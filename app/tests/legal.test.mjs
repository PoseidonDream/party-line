/* The legal side: the privacy policy, terms of service and cookie policy pages, the cookie notice, the box people tick
   to sign up (and that the server keeps when they did, and for which version), YouTube loading only after people
   allow it, "Download my data", and the app asking again when the terms change. */
import fs from 'node:fs';
import { startServer, launchBrowser, signUp, openDb, joinVoice, openPage } from './lib.mjs';
import { FAKE_YT } from './bot.test.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    // The pages
    const pages = {};
    for (const p of ['privacy', 'terms', 'cookies']) { const r = await fetch(`${srv.url}/${p}`); pages[p] = { status: r.status, html: await r.text() }; }
    ok('the Privacy policy, Terms of service and Cookie policy pages open', Object.values(pages).every((p) => p.status === 200));
    ok('…the privacy policy says what’s kept, why, for how long, and your rights', ['What the server keeps', 'Why, and on what basis', 'How long it’s kept', 'Your rights', 'Download my data'].every((s) => pages.privacy.html.includes(s)));
    ok('…it lists the outside services (YouTube, push, email, Giphy, Claude)', ['YouTube', 'push service', 'Giphy', 'Anthropic'].every((s) => pages.privacy.html.includes(s)));
    ok('…the cookie policy lists what’s stored on the device', ['pl:token', 'pl:settings', 'pl:consent'].every((s) => pages.cookies.html.includes(s)));
    const info = await (await fetch(`${srv.url}/api/info`)).json();
    ok('the server says which version of the terms is current', /^\d{4}-\d{2}-\d{2}$/.test(info.termsVersion || ''));

    // The cookie notice
    const v = await openPage(browser, `${srv.url}/terms`);
    const navLinks = await v.$$eval('.legal-nav a', (as) => as.map((a) => a.getAttribute('href')));
    ok('…each page links to the others at the bottom', ['/privacy', '/terms', '/rules', '/cookies', '/delete-account'].every((h) => navLinks.includes(h)));
    await v.goto(srv.url);
    await v.waitForSelector('#cookieBanner:not([hidden])');
    ok('a first visit shows the cookie notice, with a link to the cookie policy', await v.locator('#cookieBanner a[href="/cookies"]').count() === 1);
    await v.click('#cookieNecessary');
    ok('…“Necessary only” saves the choice and hides it', await v.isHidden('#cookieBanner') && (await v.evaluate(() => JSON.parse(localStorage.getItem('pl:consent')))).youtube === false);
    await v.reload(); await v.waitForSelector('#join:not([hidden])');
    ok('…and it doesn’t come back', await v.isHidden('#cookieBanner'));

    // The sign-up box
    await v.click('#tabRegister'); await v.fill('#authName', 'Lale'); await v.fill('#authPass', 'pass1234'); await v.click('#authBtn');
    await v.waitForSelector('#authError:not([hidden])');
    ok('signing up without ticking the box is refused, and says why', (await v.textContent('#authError')).includes('13 or older'));
    const r = await fetch(`${srv.url}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sneaky', password: 'pass1234' }) });
    ok('…the server refuses it too', r.status === 400 && /13 or older/.test((await r.json()).error || ''));
    await v.check('#authAgree'); await v.click('#authBtn'); await v.waitForSelector('#room:not([hidden])');
    const db = openDb(srv);
    const row = db.prepare('SELECT agreed_at, agreed_version FROM users WHERE name = ?').get('Lale');
    ok('…ticking it makes the account and keeps when they agreed, and to which version', row.agreed_at > Date.now() - 60_000 && row.agreed_version === info.termsVersion);
    ok('…so the “we updated our terms” window doesn’t open', !await v.evaluate(() => document.querySelector('#termsDlg').open));

    // YouTube only after it's allowed
    let ytLoads = 0;
    await v.context().route('https://www.youtube.com/iframe_api', (rt) => { ytLoads++; return rt.fulfill({ contentType: 'text/javascript', body: FAKE_YT }); });
    await joinVoice(v); await v.click('#textList .chan:has-text("general")');
    await v.fill('#chatInput', '/play https://youtu.be/dQw4w9WgXcQ'); await v.keyboard.press('Enter');
    await v.waitForSelector('#musicCard:not([hidden]) #musicConsent:not([hidden])', { timeout: 8000 });
    ok('Listen together: with “Necessary only”, nothing loads from YouTube; it asks first', ytLoads === 0);
    await v.click('#musicConsentOk');
    await v.waitForFunction(() => window.__yt && window.__yt.getPlayerState() === 1, null, { timeout: 8000 });
    ok('…“Allow YouTube” loads the player, and remembers the choice', ytLoads === 1 && (await v.evaluate(() => JSON.parse(localStorage.getItem('pl:consent')))).youtube === true);
    await v.click('#musicStop').catch(() => {}); await v.click('#vcLeaveBtn');

    // Settings → Account → Privacy
    await v.click('#setBtn'); await v.click('#settings [data-settab="account"]');
    await v.click('#privacyBox > summary');
    ok('Settings → Account → Privacy shows the YouTube choice', await v.isChecked('#setYouTube'));
    await v.uncheck('#setYouTube');
    ok('…and it can be taken back', (await v.evaluate(() => JSON.parse(localStorage.getItem('pl:consent')))).youtube === false);
    await v.evaluate(async () => { const { live } = await import('/js/net.js'); return live.req('msg.send', { channelId: 1, body: 'my own words', attachments: [] }); });
    const [dl] = await Promise.all([v.waitForEvent('download'), v.click('#exportData')]);
    const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    ok('“Download my data” gives a file with the account, profile and messages', data.account.name === 'Lale' && data.account.agreedToTerms.version === info.termsVersion && data.messages.some((m) => m.text === 'my own words') && 'profile' in data && Array.isArray(data.devices));
    ok('…without the password or the 2-step secret', !/pass_hash|scrypt|totp_secret|pass1234/.test(JSON.stringify(data)));
    const anon = await fetch(`${srv.url}/api/account/export`);
    ok('…and only for the person signed in', anon.status === 401);
    await v.keyboard.press('Escape');

    // New terms: the app asks again
    db.prepare("UPDATE users SET agreed_version = '2020-01-01' WHERE name = 'Lale'").run();
    await v.reload(); await v.waitForSelector('#termsDlg[open]', { timeout: 8000 });
    ok('when the terms change, the app asks people to look at them and agree', await v.locator('#termsDlg a[href="/terms"]').count() >= 1);
    await v.keyboard.press('Escape');
    ok('…Esc doesn’t skip it', await v.evaluate(() => document.querySelector('#termsDlg').open));
    await v.click('#termsAgree');
    await v.waitForFunction(() => !document.querySelector('#termsDlg').open);
    ok('…“I agree” keeps the new version', db.prepare("SELECT agreed_version FROM users WHERE name = 'Lale'").get().agreed_version === info.termsVersion);
    db.close();

    // A video preview asks before playing from YouTube (the preview is put in by hand: no internet in tests)
    const w = await signUp(browser, srv.url, 'Ece');
    await w.context().route('https://www.youtube-nocookie.com/**', (rt) => rt.fulfill({ contentType: 'text/html', body: '<p>video</p>' }));
    const sent = await w.evaluate(async () => { const { live } = await import('/js/net.js'); return live.req('msg.send', { channelId: 1, body: 'look at this song', attachments: [] }); });
    const db2 = openDb(srv);
    db2.prepare('UPDATE messages SET embeds = ? WHERE id = ?').run(JSON.stringify([{ url: 'https://youtu.be/dQw4w9WgXcQ', site: 'YouTube', title: 'A song', image: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22480%22 height=%22360%22%3E%3Crect width=%22480%22 height=%22360%22 fill=%22%23333%22/%3E%3C/svg%3E', big: true, youtube: 'dQw4w9WgXcQ' }]), sent.msg.id);
    db2.close();
    await w.reload(); await w.waitForSelector('#room:not([hidden])');
    await w.click('.embed-img');
    await w.waitForSelector('#confirmDlg[open]');
    ok('a YouTube video preview asks before loading anything from YouTube', (await w.textContent('#cfTitle')).includes('YouTube') && !await w.locator('iframe.embed-video').count());
    ok('…its picture is described for screen readers', (await w.getAttribute('.embed-img img', 'alt')) === 'Preview: A song');
    await w.click('#cfOk');
    const src = await (await w.waitForSelector('iframe.embed-video')).getAttribute('src');
    ok('…and plays in YouTube’s privacy-enhanced mode once allowed', src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'));
    const errs = [...v.errors, ...w.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
