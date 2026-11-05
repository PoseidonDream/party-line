/* A tidy app: the channel header shows only what's used all the time (calls, search, notifications) and keeps the
   rest in the ⋯ menu, with a dot when something in there has news. Admins can tuck away features nobody uses
   (Developer panel → Features): the button leaves its usual spot for everyone and waits in ⋯ → More. */
import { startServer, launchBrowser, signUp, joinVoice, fromMore } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const admin = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);

    // The header
    const shown = await b.$$eval('.head-actions > button', (bs) => bs.filter((x) => x.offsetParent !== null).map((x) => x.id));
    ok(`a server channel’s header shows just Notifications, Search and ⋯ (${shown.join(', ')})`, JSON.stringify(shown) === JSON.stringify(['notifBtn', 'searchBtn', 'moreBtn']));
    await b.click('#moreBtn');
    const items = await b.$$eval('#moreMenu > [data-proxy]', (bs) => bs.filter((x) => !x.hidden).map((x) => x.dataset.proxy));
    ok('…and ⋯ has the rest: events, games, media, pins, invite, feedback', ['eventsBtn', 'gamesBtn', 'galleryBtn', 'pinsBtn', 'copyInvite', 'feedbackBtn'].every((k) => items.includes(k)));
    await b.keyboard.press('Escape');
    await req(admin, 'event.create', { serverId: 1, title: 'Game night', startsAt: Date.now() + 86400_000 });
    await b.waitForSelector('#moreBadge:not([hidden])');
    ok('…a dot on ⋯ says when something inside is new (an event here)', true);
    await fromMore(b, 'eventsBtn');
    await b.waitForSelector('#eventsDlg[open]');
    ok('…and its items work (Events opens)', true);
    await b.keyboard.press('Escape');

    // Tucking away
    await admin.keyboard.press('Control+Shift+D');
    await admin.click('#devPanel [data-tab="features"]');
    await admin.waitForSelector('#devPanel tr[data-key="soundboard"] .tuck-btn');
    await admin.click('#devPanel tr[data-key="soundboard"] .tuck-btn');
    await b.waitForFunction(() => document.querySelector('#soundBtn').classList.contains('feature-hidden'));
    await joinVoice(b);
    ok('an admin can tuck the soundboard away: its button leaves the voice bar for everyone', await b.isHidden('#soundBtn'));
    await b.click('#moreBtn');
    await b.waitForSelector('#moreTucked:not([hidden]) [data-proxy="soundBtn"]');
    await b.click('#moreTucked [data-proxy="soundBtn"]');
    await b.waitForSelector('#soundPop:not([hidden])');
    ok('…and it waits in ⋯ → More, still working', true);
    await b.keyboard.press('Escape');
    await admin.waitForSelector('#devPanel tr[data-key="soundboard"] .tuck-btn:has-text("Put back")');
    await admin.click('#devPanel tr[data-key="soundboard"] .tuck-btn');
    await b.waitForFunction(() => !document.querySelector('#soundBtn').classList.contains('feature-hidden'));
    ok('…and put back just as easily', await b.isVisible('#soundBtn'));
    const refused = await b.evaluate(async () => { const { live } = await import('/js/net.js'); try { await live.req('features.hide', { key: 'soundboard', hide: true }); return false; } catch { return true; } });
    ok('only admins can tuck features away', refused);
    const errs = [...admin.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
