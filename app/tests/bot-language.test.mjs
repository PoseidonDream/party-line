/* Party Bot speaks each person's language: its messages are saved in English, and each app shows them in the
   language it's set to. Names, event titles and game names stay as written. */
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const tr = await signUp(browser, srv.url, 'Ece', { locale: 'tr-TR' });
    const en = await signUp(browser, srv.url, 'Deniz', { locale: 'en-US' });
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);

    await req(en, 'event.create', { serverId: 1, title: 'Game night', startsAt: Date.now() + 86400_000 });
    const botLine = (p, text) => p.waitForSelector(`#messages .msg:has(.bot-tag) .msg-body:has-text("${text}")`, { timeout: 8000 });
    const trText = await (await botLine(tr, 'etkinliğini')).textContent();
    const enText = await (await botLine(en, 'planned')).textContent();
    ok('a Turkish friend reads Party Bot’s event announcement in Turkish', /Deniz, Game night etkinliğini .* için planladı/.test(trText) && trText.includes('Etkinlikler'));
    ok('…an English friend reads the same message in English', /Deniz planned Game night for/.test(enText));
    ok('…and names and titles stay as written', trText.includes('Deniz') && trText.includes('Game night'));

    await tr.fill('#chatInput', '/roll'); await tr.keyboard.press('Enter');
    const roll = await (await botLine(tr, 'attı')).textContent();
    ok('commands answer in your language too (/roll → “… attı (1 ile 6 arası)”)', /Ece \d+ attı \(1 ile 6 arası\)/.test(roll));
    await tr.fill('#chatInput', '/coinflip'); await tr.keyboard.press('Enter');
    const coin = await (await botLine(tr, 'yazı tura attı')).textContent();
    ok('…including the words inside (Heads/Tails → Tura/Yazı)', /yazı tura attı: (Tura|Yazı)$/.test(coin.trim()));
    await tr.fill('#chatInput', '/remind 10m su iç'); await tr.keyboard.press('Enter');
    await tr.waitForSelector('#botNote:not([hidden])');
    ok('Party Bot’s private notes are translated as well', /hatırlatacağım: su iç/.test(await tr.textContent('#botNoteText')));
    const errs = [...tr.errors, ...en.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
