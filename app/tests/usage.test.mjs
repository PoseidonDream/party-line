/* What friends use: features are counted as people use them, the developer panel lists them least used first, and
   Party Bot privately sends the admins the weekly report (on the report day, once). */
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';

export default async function (ok) {
  // The report goes out on REPORT_DAY from REPORT_HOUR: today, from midnight, checked every few seconds.
  const srv = await startServer({ REPORT_DAY: String(new Date().getDay()), REPORT_HOUR: '0', USAGE_TICK_MS: '5000', USAGE_FIRST_MS: '600000' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d).then((r) => r, (e) => ({ error: e.message })); }, [t, d]);
    const botNotes = () => { const db = openDb(srv); try { return db.prepare("SELECT body FROM messages WHERE dm_id IS NOT NULL AND user_id = (SELECT id FROM users WHERE is_bot = 1) ORDER BY id").all().map((r) => r.body); } finally { db.close(); } };

    const first = await req(b, 'msg.send', { channelId: 1, body: 'hello **all**', attachments: [] });
    await req(a, 'msg.send', { channelId: 1, body: 'hi!', attachments: [], replyTo: first.msg.id });
    await req(b, 'poll.create', { channelId: 1, question: 'Pizza?', options: ['Yes', 'No'] });
    await req(a, 'react', { id: first.msg.id, emoji: '😂', on: true });
    await req(b, 'msg.send', { channelId: 1, body: '/roll', attachments: [] });
    await b.evaluate(async () => { const { api } = await import('/js/net.js'); await api('/api/search?q=hello'); });
    await b.keyboard.press('Control+p'); await b.waitForSelector('#jumpDlg[open]'); await b.keyboard.press('Escape');
    await b.waitForTimeout(500);

    const denied = await req(b, 'usage.stats', {});
    ok('only admins can see the numbers', denied.error === 'Admins only.');
    await a.keyboard.press('Control+Shift+D');
    await a.click('#devPanel [data-tab="features"]');
    await a.waitForSelector('#devPanel .usage-table tbody tr');
    const rows = await a.$$eval('#devPanel .usage-table tbody tr', (trs) => trs.map((tr) => ({ key: tr.dataset.key, cells: [...tr.children].map((td) => td.textContent) })));
    const row = (k) => rows.find((r) => r.key === k) || { cells: [] };
    ok('Developer → Features: messages, replies and bold text are counted, with how many people', row('chat').cells[1] === '2' && row('chat').cells[2] === '2' && row('replies').cells[1] === '1' && row('richtext').cells[1] === '1');
    ok('…polls, reactions, /roll, search and Ctrl+P too', ['polls', 'reactions', 'dice', 'search', 'switcher'].every((k) => row(k).cells[1] === '1'));
    const at = (k) => rows.findIndex((r) => r.key === k);
    ok('…least used first: unused ones like Clip it say “never”, and come before chat', row('clips').cells[1] === '0' && row('clips').cells[4] === 'never' && at('clips') < at('chat'));
    ok('…and features the server owner hasn’t switched on are marked off (GIFs without a Giphy key)', /Off: needs GIPHY_KEY/.test(row('gifs').cells[0]));

    await a.click('#usageSend');
    await a.waitForSelector('.toast:has-text("sent you the report")');
    const now = botNotes().find((t) => /Weekly feature report/.test(t)) || '';
    ok('“Send me the report now”: Party Bot privately lists what nobody used, what was hardly used and what was used most',
      /\*\*Nobody used\*\* \(\d+\):.*Clip it/.test(now) && /\*\*Hardly used:\*\*/.test(now) && /Most used:.*Chat messages \(2\)/.test(now));
    ok('…and Bora (not an admin) gets nothing', !(await b.evaluate(() => document.body.textContent.includes('Weekly feature report'))));

    // The weekly one: on the report day, once.
    const t0 = Date.now();
    while (botNotes().filter((x) => /Weekly feature report/.test(x)).length < 2 && Date.now() - t0 < 15000) await a.waitForTimeout(500);
    const weekly = botNotes().filter((x) => /Weekly feature report/.test(x));
    ok('on the report day, Party Bot sends the admins last week’s report by itself', weekly.length === 2 && /only partly counted/.test(weekly[1]));
    await a.waitForTimeout(6000);
    ok('…only once', botNotes().filter((x) => /Weekly feature report/.test(x)).length === 2);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
