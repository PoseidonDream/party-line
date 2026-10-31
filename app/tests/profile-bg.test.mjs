/* Profile pictures, backgrounds and the profile preview: Settings → Profile shows your profile as friends see it
   (banner color, effect, ring, name color, About me) as you change things. Adding a profile picture or a background
   opens a crop window: drag and zoom to pick which part of the photo or GIF to use. */
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
    await a.waitForSelector('#cropDlg[open] .crop-frame.wide');
    ok('adding a background opens a crop window', true);
    await a.fill('#cropZoom', '3'); await a.dispatchEvent('#cropZoom', 'input');
    const fb = await a.locator('#cropFrame').boundingBox();
    await a.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2); await a.mouse.down();
    await a.mouse.move(fb.x + fb.width / 2 - 80, fb.y + fb.height / 2 - 20, { steps: 6 }); await a.mouse.up();
    const picked = await a.$eval('#cropFrame', (e) => ({ size: e.style.backgroundSize, pos: e.style.backgroundPosition }));
    await a.click('#cropOk');
    await a.waitForSelector('#prevBanner.has-bg');
    const pos = await a.$eval('#prevBanner', (e) => e.style.backgroundPosition), size = await a.$eval('#prevBanner', (e) => e.style.backgroundSize);
    ok('zooming and dragging picks the part that shows', picked.pos !== '50% 50%' && pos === picked.pos && size === picked.size && size === '300%');
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

    // Profile picture: a photo in four colored quarters (red, green / blue, yellow); pick the top-left one.
    const quarters = Buffer.from(await a.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const g = c.getContext('2d');
      [['#ff0000', 0, 0], ['#00ff00', 100, 0], ['#0000ff', 0, 100], ['#ffff00', 100, 100]].forEach(([col, x, y]) => { g.fillStyle = col; g.fillRect(x, y, 100, 100); });
      return c.toDataURL('image/png').split(',')[1]; }), 'base64');
    await a.setInputFiles('#setAvFile', { name: 'me.png', mimeType: 'image/png', buffer: quarters });
    await a.waitForSelector('#cropDlg[open] .crop-frame:not(.wide)');
    await a.fill('#cropZoom', '2'); await a.dispatchEvent('#cropZoom', 'input');
    const af = await a.locator('#cropFrame').boundingBox();
    await a.mouse.move(af.x + af.width / 2, af.y + af.height / 2); await a.mouse.down();
    await a.mouse.move(af.x + af.width / 2 + 300, af.y + af.height / 2 + 300, { steps: 8 }); await a.mouse.up();
    await a.click('#cropOk');
    await a.waitForFunction(() => /uploads/.test(document.querySelector('#setAv').style.backgroundImage));
    const color = await a.evaluate(async () => {
      const url = /url\("([^"]+)"\)/.exec(document.querySelector('#setAv').style.backgroundImage)[1];
      const bmp = await createImageBitmap(await (await fetch(url)).blob()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return [...g.getImageData(bmp.width / 2, bmp.height / 2, 1, 1).data].slice(0, 3);
    });
    ok('a profile picture uses exactly the part you picked (the top-left quarter, red)', color[0] > 200 && color[1] < 60 && color[2] < 60, color.join(','));
    await a.setInputFiles('#setAvFile', { name: 'me.gif', mimeType: 'image/gif', buffer: GIF });
    await a.waitForSelector('#cropDlg[open]');
    await a.fill('#cropZoom', '2.5'); await a.dispatchEvent('#cropZoom', 'input');
    await a.click('#cropOk');
    await a.waitForSelector('#setAv.has-img.fit');
    ok('a GIF profile picture stays a GIF and shows the part you picked', /2\d\d(\.\d)?% auto/.test(await a.$eval('#setAv', (e) => e.style.getPropertyValue('--fit-size'))));

    await a.click('#setBgRemove');
    await a.waitForSelector('#prevBanner:not(.has-bg)');
    ok('…and it can be removed', await a.isHidden('#setBgRemove'));
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
