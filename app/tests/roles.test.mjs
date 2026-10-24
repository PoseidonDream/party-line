/* Channel tidying (categories, drag and drop, topics) and roles (colors, permissions, who has them). */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const c = await signUp(browser, srv.url, 'Cem');

    ok('people without the permission can’t edit channels', await b.locator('.chan-gear').count() === 0);
    await a.click('#serverBtn'); await a.click('#mCategory');
    await a.fill('#cfInput', '🎮 Games'); await a.click('#cfOk');
    await b.waitForSelector('.custom-cat .cat-toggle:has-text("🎮 Games")');
    ok('a new category shows for everyone', true);
    await a.locator('#textList li:has-text("game-night")').dragTo(a.locator('.custom-cat .cat-head'));
    await b.waitForSelector('.custom-cat .chan-list li:has-text("game-night")');
    ok('dragging a channel into a category moves it for everyone', await b.locator('#textList li:has-text("game-night")').count() === 0);
    await a.locator('#textList li:has-text("clips-and-highlights")').dragTo(a.locator('#textList li:has-text("general")'));
    await b.waitForFunction(() => [...document.querySelectorAll('#textList .chan-name')].map((x) => x.textContent).join(',') === 'clips-and-highlights,general');
    ok('dragging reorders channels', true);

    await a.click('#textList .chan:has-text("general")');
    await a.locator('#textList li:has-text("general")').hover();
    await a.click('#textList li:has-text("general") .chan-gear');
    await a.fill('#chTopic', 'Say hi and share memes');
    await a.click('#chanForm button[type=submit]');
    await b.click('#textList .chan:has-text("general")');
    await b.waitForSelector('#viewSub:text-is("Say hi and share memes")');
    ok('a channel topic shows at the top', true);

    await c.click('#textList .chan:has-text("general")');
    await c.fill('#chatInput', 'spam spam spam'); await c.keyboard.press('Enter');
    const cMsg = '#messages .msg:has-text("spam spam spam")';
    await b.waitForSelector(cMsg);
    await b.locator(cMsg).hover();
    ok('without a role, you can’t delete other people’s messages', await b.locator(`${cMsg} .msg-tool.del`).count() === 0);

    await a.click('#serverBtn'); await a.click('#mRoles');
    await a.click('#roleNew');
    await a.waitForSelector('#roleForm:not([hidden])');
    await a.fill('#roleName', 'Mods');
    await a.click('#roleColors .swatch[title="#d9534f"]');
    await a.check('#rolePerms input[data-perm="messages"]');
    await a.check('#rolePerms input[data-perm="channels"]');
    await a.click('#roleForm button[type=submit]');
    await a.waitForSelector('#rolesList .role-item:has-text("Mods (0)")');
    await a.check('#roleMembers label:has-text("Bora") input');
    await a.waitForSelector('#rolesList .role-item:has-text("Mods (1)")');
    ok('roles can be made with a color and permissions, and given to people', true);
    await a.screenshot({ path: `${RESULTS}/roles.png` });
    await a.keyboard.press('Escape');

    await b.fill('#chatInput', 'I am a mod now'); await b.keyboard.press('Enter');
    await c.waitForSelector('#messages .msg:has-text("I am a mod now")');
    const color = await c.evaluate(() => getComputedStyle([...document.querySelectorAll('#messages .msg-name')].find((x) => x.textContent.startsWith('Bora'))).color);
    ok(`names show in their role’s color (${color})`, color === 'rgb(217, 83, 79)');
    await b.locator(cMsg).hover();
    await b.click(`${cMsg} .msg-tool.del`, { modifiers: ['Shift'] });
    await c.waitForSelector(cMsg, { state: 'detached' });
    ok('a role with Moderate messages can delete other people’s messages', true);
    ok('a role with Manage channels can edit channels', await b.locator('.chan-gear').count() > 0);
    ok('without Manage server, the role list is view-only', await b.evaluate(() => { document.querySelector('#mRoles').click(); return true; }) && await b.isHidden('#roleNew'));
    await b.keyboard.press('Escape');

    await c.click('#messages .msg:has-text("I am a mod now") .mini-av');
    await c.waitForSelector('#popRoles:not([hidden]) .role-chip:text-is("Mods")');
    ok('the profile pop-up shows someone’s roles', true);

    const errs = [...a.errors, ...b.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
