/* Languages: the app follows the device's language at first, and anyone can switch on the sign-in screen or in
   Settings → Look, any time. Only the app's own words change: what people write and their names stay as they are. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, openPage } from './lib.mjs';

const I18N = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'i18n');

export default async function (report) {
  const ok = (name, pass, why) => report(pass || !why ? name : `${name} (${why})`, pass);
  // The translation files: every language has the same lines, with the same {0} slots.
  const tables = Object.fromEntries(['de', 'es', 'fr', 'it', 'ru', 'tr'].map((c) => [c, JSON.parse(fs.readFileSync(path.join(I18N, `${c}.json`), 'utf8'))]));
  const keys = Object.keys(tables.de).sort().join('\n');
  ok(`six languages, each with the same ${Object.keys(tables.de).length} lines`, Object.values(tables).every((t) => Object.keys(t).sort().join('\n') === keys) && Object.keys(tables.de).length > 1000);
  const slots = (s) => (s.match(/\{\d\}/g) || []).sort().join('');
  const badSlots = Object.entries(tables).flatMap(([c, t]) => Object.entries(t).filter(([en, out]) => !out || (slots(out) !== slots(en) && !/\w\{1\}[.,]/.test(en))).map(([en]) => `${c}: ${en}`));
  ok('…and every translation keeps the name and number slots', badSlots.length === 0, badSlots.slice(0, 3).join(' | '));

  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    // A German phone: German from the start
    const p = await openPage(browser, srv.url, { locale: 'de-DE' });
    await p.waitForSelector('#tabLogin:has-text("Anmelden")');
    ok('a phone set to German opens Party Line in German', (await p.textContent('#tabRegister')) === 'Konto erstellen' && (await p.inputValue('#joinLang')) === 'de');
    ok('…including the hints inside text boxes', (await p.getAttribute('#authName', 'placeholder')) === 'z. B. Deniz');
    await p.selectOption('#joinLang', 'tr');
    await p.waitForSelector('#tabLogin:has-text("Giriş yap")');
    ok('the sign-in screen has a language picker (Türkçe here)', (await p.textContent('#tabRegister')) === 'Hesap oluştur');
    ok('…the picker lists each language in its own words', (await p.$$eval('#joinLang option', (os) => os.map((o) => o.textContent))).join(',') === 'English,Deutsch,Español,Français,Italiano,Русский,Türkçe');

    // Make an account in Turkish. The name "Robot" is also a word the app uses (a voice effect), so it must not change.
    await p.click('#tabRegister');
    ok('…the button follows the tab, still in Turkish', (await p.textContent('#authBtn')) === 'Hesap oluştur');
    await p.fill('#authName', 'Robot'); await p.fill('#authPass', 'pass1234');
    await p.click('#authBtn');
    await p.waitForSelector('#authError:not(:empty)');
    ok('…errors are in Turkish too', (await p.textContent('#authError')).includes('topluluk kurallarını'));
    await p.check('#authAgree'); await p.click('#authBtn');
    await p.waitForSelector('#room:not([hidden])');
    ok('inside the app it stays in Turkish', (await p.getAttribute('#setBtn', 'title')) === 'Ayarlar');

    // What people write stays as written
    const req = (t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
    await req('msg.send', { channelId: 1, body: 'Settings', attachments: [] });
    await p.waitForSelector('#messages .msg-body:text-is("Settings")');
    ok('a message that happens to match an app word is not translated', await p.locator('#messages .msg-body:text-is("Settings")').count() === 1);
    ok('…nor is a person’s name', (await p.textContent('#meName')).trim() === 'Robot' && (await p.locator('#messages .msg-name .nm:text-is("Robot")').count()) >= 1);

    // Switch in Settings → Look
    await p.click('#setBtn'); await p.click('#settings [data-settab="look"]');
    ok('Settings → Look has the language, set to Türkçe', (await p.inputValue('#setLang')) === 'tr');
    await p.selectOption('#setLang', 'ru');
    await p.waitForSelector('#settings [data-settab="look"]:has-text("Вид")');
    ok('…switching to Русский changes everything at once', (await p.getAttribute('#setBtn', 'title')) === 'Настройки' && (await p.textContent('#settings [data-settab="account"]')).trim() === 'Аккаунт');
    const fx = await p.evaluate(async () => { const { t } = await import('/js/i18n.js'); return [t('Noise filter: {0}', t('Strong')), t('{0} is typing…', 'Robot')]; });
    ok('…lines put together from pieces translate each piece, but never a name', fx[0] === 'Шумоподавление: Сильный' && fx[1] === 'Robot печатает…', fx.join(' / '));
    ok('…like the member count under a server', /^В сети: 1 · участников: 1$/.test((await p.textContent('#countText')).trim()));
    ok('…dates follow the language', await p.evaluate(async () => { const { fmtDay } = await import('/js/util.js'); return /окт|ноя|дек|янв|фев|мар|апр|мая|июн|июл|авг|сен/.test(fmtDay(Date.now() - 3 * 86400_000)); }));
    await p.keyboard.press('Escape');

    await p.reload(); await p.waitForSelector('#room:not([hidden])');
    await p.waitForFunction(() => document.querySelector('#setBtn').title === 'Настройки');
    ok('the choice is remembered after a restart', (await p.evaluate(() => document.documentElement.lang)) === 'ru');

    await p.click('#setBtn'); await p.click('#settings [data-settab="look"]');
    await p.selectOption('#setLang', 'en');
    await p.waitForSelector('#settings [data-settab="look"]:has-text("Look")');
    ok('…and back to English, every word is back', (await p.getAttribute('#setBtn', 'title')) === 'Settings' && (await p.textContent('#settings [data-settab="account"]')).trim() === 'Account');
    ok('no JavaScript errors while switching', p.errors.length === 0, p.errors.join(' | '));
  } finally {
    await browser.close();
    await srv.stop();
  }
}
