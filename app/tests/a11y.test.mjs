/* Accessibility: axe-core checks the main screens in the dark and the light look (labels, roles, contrast, keyboard
   access to scrolling areas, heading order). */
import { createRequire } from 'node:module';
import { startServer, launchBrowser, signUp } from './lib.mjs';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

export default async function (ok) {
  const srv = await startServer({ XP_GAP_MS: '1' });
  const browser = await launchBrowser();
  try {
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
    await req(b, 'msg.send', { channelId: 1, body: 'hello **there** https://example.com', attachments: [] });
    await req(b, 'poll.create', { channelId: 1, question: 'Pizza?', options: ['Yes', 'No'] });
    await req(b, 'lfg.create', { channelId: 1, game: 'Valorant', need: 2 });
    for (const theme of ['dark', 'light']) {
      const a = await signUp(browser, srv.url, theme === 'dark' ? 'Poseidon' : 'Lale');
      if (theme === 'light') {
        await a.evaluate(() => { const s = JSON.parse(localStorage.getItem('pl:settings') || '{}'); s.theme = 'light'; localStorage.setItem('pl:settings', JSON.stringify(s)); });
        await a.reload(); await a.waitForSelector('#room:not([hidden])');
      }
      await req(a, 'msg.send', { channelId: 1, body: 'hi from me', attachments: [] });
      const found = [];
      const audit = async (where) => {
        await a.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));   // they fade in and go away
        await a.addScriptTag({ path: AXE }).catch(() => {});
        const v = await a.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.nodes[0].target.join(' ')})`));
        for (const x of v) found.push(`${where}: ${x}`);
      };
      await audit('chat');
      await a.click('#railHome'); await audit('home');
      await a.click('#navFriends'); await audit('friends');
      await a.click('#navTop'); await audit('leaderboard'); await a.click('[data-toptab="ach"]'); await audit('achievements'); await a.keyboard.press('Escape');
      await a.click('#railList .rail-btn');
      await a.click('#setBtn');
      for (const t of ['profile', 'look', 'voice', 'alerts', 'account']) { await a.click(`#settings [role="tab"][data-settab="${t}"]`); await audit(`settings ${t}`); }
      await a.keyboard.press('Escape');
      await a.click('#attachBtn'); await a.click('#attachPoll'); await audit('new poll'); await a.keyboard.press('Escape');
      await a.click('#voiceList .chan:has-text("Lobby")'); await a.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); await audit('voice');
      ok(`${theme} look: no accessibility problems${found.length ? ': ' + [...new Set(found)].slice(0, 6).join(' | ') : ''}`, !found.length);
      await a.click('#vcLeaveBtn');
      await a.context().close();
    }
  } finally { await browser.close(); await srv.stop(); }
}
