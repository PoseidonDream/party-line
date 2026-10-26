/* Rich text: italic, bold, underline, strike, code, code blocks, quotes and spoilers, without mangling
   snake_case words or links. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const send = async (text) => { await a.fill('#chatInput', text); await a.keyboard.press('Enter'); };
    await send('*soft* **loud** __under__ ~~gone~~ `npm start` and ||Bruce Willis was dead||');
    const m = '#messages .msg:has-text("soft")';
    await b.waitForSelector(m);
    ok('italic, bold, underline, strike and code', await b.isVisible(`${m} em:text-is("soft")`) && await b.isVisible(`${m} b:text-is("loud")`)
      && await b.isVisible(`${m} u:text-is("under")`) && await b.isVisible(`${m} s:text-is("gone")`) && await b.isVisible(`${m} code.inline-code:text-is("npm start")`));
    const hidden = await b.locator(`${m} .spoiler`).evaluate((x) => getComputedStyle(x).color);
    await b.click(`${m} .spoiler`); await b.waitForTimeout(300);   // it fades in
    const shown = await b.locator(`${m} .spoiler`).evaluate((x) => getComputedStyle(x).color);
    ok('spoilers stay hidden until clicked', hidden === 'rgba(0, 0, 0, 0)' && shown !== hidden);

    await a.fill('#chatInput', '> quoted line\nreply below');
    await a.keyboard.press('Enter');
    await b.waitForSelector('#messages blockquote:text-is("quoted line")');
    ok('> makes a quote', await b.isVisible('#messages .msg:has-text("reply below")'));
    await a.fill('#chatInput', '```js\nconst x = 1;\n  indented()\n```');
    await a.keyboard.press('Enter');
    await b.waitForSelector('#messages pre.code-block');
    ok('``` makes a code block that keeps spacing', (await b.textContent('#messages pre.code-block')) === 'const x = 1;\n  indented()');
    await send('my_snake_case_file and https://example.com/a_b_c*d*');
    await b.waitForSelector('#messages .msg:has-text("my_snake_case_file")');
    ok('snake_case words and links aren’t mangled', await b.locator('#messages .msg:has-text("my_snake_case_file") em').count() === 0
      && (await b.getAttribute('#messages .msg:has-text("my_snake_case_file") a', 'href')) === 'https://example.com/a_b_c*d*');
    await b.screenshot({ path: `${RESULTS}/richtext.png` });
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
