/* Things that depend on time passing, fast-forwarded in the database: streaks carry on or start over, level 20's
   shimmering name, group posts that expire, and ended polls staying ended. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ XP_GAP_MS: '1' });
  const browser = await launchBrowser();
  try {
  const a = await signUp(browser, srv.url, 'Poseidon');
  const b = await signUp(browser, srv.url, 'Bora');
  const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d).catch((e) => ({ error: e.message })); }, [t, d]);
  const db = new DatabaseSync(path.join(srv.dataDir, 'party-line.db'));
  const day = (off) => { const d = new Date(Date.now() + off * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // streak continues from yesterday, resets after a missed day
  db.prepare("UPDATE users SET streak = 6, streak_day = ? WHERE name = 'Bora'").run(day(-1));
  await req(b, 'msg.send', { channelId: 1, body: 'day seven', attachments: [] });
  let u = db.prepare("SELECT streak, badges FROM users WHERE name = 'Bora'").get();
  ok('chatting the day after keeps the streak going (6 → 7) and earns On fire', u.streak === 7 && /on_fire/.test(u.badges || ''));
  db.prepare("UPDATE users SET streak = 9, streak_day = ? WHERE name = 'Bora'").run(day(-3));
  await a.reload(); await a.waitForSelector('#room:not([hidden])');
  await a.click('#messages .msg:has-text("day seven") .mini-av');
  ok('a streak that was missed for days shows as gone on the profile', await a.isHidden('#popStreak'));
  await a.keyboard.press('Escape');
  await req(b, 'msg.send', { channelId: 1, body: 'back again', attachments: [] });
  u = db.prepare("SELECT streak FROM users WHERE name = 'Bora'").get();
  ok('…and the next chat starts it again at 1', u.streak === 1);
  // level 20 legend
  db.prepare("UPDATE users SET xp = 12000 WHERE name = 'Bora'").run();
  await req(b, 'msg.send', { channelId: 1, body: 'legend time', attachments: [] });   // +10 XP and a fresh profile for everyone
  await a.waitForTimeout(500);
  await a.reload(); await a.waitForSelector('#messages .msg:has-text("legend time")');
  ok('level 20: the name shimmers for everyone', await a.isVisible('#messages .msg:has-text("legend time") .name-legend, #messages .msg .name-legend'));
  // LFG expiry
  const l = await req(b, 'lfg.create', { channelId: 1, game: 'Peak', need: 2 });
  db.prepare('UPDATE lfg SET created_at = ? WHERE id = ?').run(Date.now() - 13 * 3600e3, l.msg.lfg.id);
  await a.reload(); await a.waitForSelector('#messages .lfg-card');
  ok('a group post 13 hours old shows as Expired', (await a.textContent('#messages .lfg-card .lfg-state')) === 'Expired');
  const j = await req(a, 'lfg.join', { id: l.msg.lfg.id, on: true });
  ok('…and can’t be joined', /closed/.test(j.error || ''));
  await a.click('#railHome'); await a.waitForTimeout(500);
  ok('…and isn’t on Home', !(await a.isVisible('#dashLfg .dash-item:has-text("Peak")')));
  // timed lfg with "at" in the past + 3h
  const l2 = await req(b, 'lfg.create', { channelId: 1, game: 'Minecraft', need: 1, at: Date.now() + 60_000 });
  db.prepare('UPDATE lfg SET at = ? WHERE id = ?').run(Date.now() - 4 * 3600e3, l2.msg.lfg.id);
  const j2 = await req(a, 'lfg.join', { id: l2.msg.lfg.id, on: true });
  ok('a group whose time was 4 hours ago is closed too', /closed/.test(j2.error || ''));
  // poll that ended stays ended after reload
  const p = await req(b, 'poll.create', { channelId: 1, question: 'Ends?', options: ['a', 'b'] });
  await req(b, 'poll.end', { id: p.msg.poll.id });
  await a.click('#railList .rail-btn'); await a.reload(); await a.waitForSelector('#messages .poll-card:has-text("Ends?")');
  ok('an ended poll stays ended after reopening', /final results/.test(await a.textContent('#messages .poll-card:has-text("Ends?") .poll-foot')));
  db.close();
  const errs = [...a.errors, ...b.errors];
  ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
