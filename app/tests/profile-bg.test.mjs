/* Profile backgrounds and the profile preview: Settings → Profile shows your profile as friends see it (banner color,
   effect, ring, name color, About me) as you change things. A picture or GIF can go at the top of your profile, and
   dragging it in the preview chooses which part shows. */
import { startServer, launchBrowser, signUp } from './lib.mjs';

// A tiny animated GIF (2 frames, 2×2): it must arrive as a GIF, not turned into a still picture.
const GIF = Buffer.from('R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQEZAD/ACwAAAAAAgACAAACAoRRACH5BARkAP8ALAAAAAACAAIAgAAA/wAAAAIChFEAOw==', 'base64');

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Ayla');
    const b = await signUp(browser, srv.url, 'Bora');
    await a.fill('#chatInput', 'hi there'); await a.keyboard.press('Enter');

    await a.click('#setBtn'); await a.click('#settings [data-settab="profile"]');
    ok('Settings → Profile starts with a preview of your profile', await a.isVisible('.profile-preview #prevBanner') && (await a.textContent('#prevName')).includes('Ayla'));
    await a.click('input[name="bannerFx"][value="stars"] + span');
    ok('…which shows the banner effect you pick right away', /fx-stars/.test(await a.getAttribute('#prevBanner', 'class')));
    await a.fill('#setBio', 'gamer at night');
    ok('…and your About me as you type', (await a.textContent('#prevBio')) === 'gamer at night');

    await a.setInputFiles('#setBgFile', { name: 'party.gif', mimeType: 'image/gif', buffer: GIF });
    await a.waitForSelector('#prevBanner.has-bg');
    ok('a picture or GIF can be added as the profile background', /\/uploads\//.test(await a.$eval('#prevBanner', (e) => e.style.backgroundImage)));
    const box = await a.locator('#prevBanner').boundingBox();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await a.mouse.down();
    await a.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 }); await a.mouse.up();
    const pos = await a.$eval('#prevBanner', (e) => e.style.backgroundPosition);
    ok('dragging it in the preview moves it', pos !== '50% 50%' && /%/.test(pos));
    await a.click('#setProfileSave');
    await a.waitForSelector('.toast:has-text("Profile saved")');
    await a.keyboard.press('Escape');

    const served = await fetch(srv.url + (await a.$eval('#prevBanner', (e) => /url\("([^"]+)"\)/.exec(e.style.backgroundImage)[1])));
    ok('the GIF is kept as a GIF (it stays animated)', served.headers.get('content-type') === 'image/gif' && Buffer.from(await served.arrayBuffer()).equals(GIF));

    await b.click('#messages .msg:has-text("hi there") .mini-av');
    await b.waitForSelector('#userPop:not([hidden]) #popBanner.has-bg');
    const seen = await b.$eval('#popBanner', (e) => ({ pos: e.style.backgroundPosition, cls: e.className }));
    ok('friends see the background where it was dragged, with the effect on top', seen.pos === pos && /fx-stars/.test(seen.cls));

    await a.click('#setBtn'); await a.click('#settings [data-settab="profile"]');
    await a.click('#setBgRemove');
    await a.waitForSelector('#prevBanner:not(.has-bg)');
    ok('…and it can be removed', await a.isHidden('#setBgRemove'));
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
