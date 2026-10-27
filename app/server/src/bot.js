/* Party Bot: commands typed in any text channel or private chat.
   - Listen together: /play <YouTube link> plays it for everyone in your voice channel at the same moment.
     Each device plays it in YouTube's own player; the server only keeps the shared queue and the clock,
     so nothing is downloaded or re-streamed. /pause, /resume, /skip, /stop, /queue.
   - Fun: /roll, /coinflip, /poll, /remind, /help. Levels: /rank, /top.
   - /ask: answers a question with Claude (see ask.js).
   Problems with a command (no voice channel, a bad link) are answered privately to whoever typed it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from './model.js';
import { config } from './config.js';
import { one, all, run } from './db.js';
import { ask as askClaude, checkAsk } from './ask.js';

let host = null;   // { post, broadcastReactions, voiceOf, usersIn, music } from hub.js
let bot = null;
const music = new Map();   // voice channelId -> { serverId, channelName, where, queue: [], now: null }
let seq = 0;

export function initBot(h) {
  host = h;
  bot = M.ensureBot();
  setInterval(fireReminders, Number(process.env.REMIND_TICK_MS) || 15_000).unref();
  setInterval(closeGamePolls, process.env.POLL_MINUTE_MS ? 1000 : 15_000).unref();
  setInterval(birthdays, 10 * 60_000).unref(); setTimeout(birthdays, 20_000).unref();
  setInterval(health, Number(process.env.HEALTH_EVERY) || 10 * 60_000).unref(); setTimeout(health, 60_000).unref();
  return bot;
}
export const botUser = () => bot;

const fail = (msg) => { throw new M.UserError(msg); };
/* Names in bold for what people did; a real @mention (which highlights and notifies) only for reminders. */
const at = (id) => `<@${id}>`;
const who = (id) => `**${(M.getUser(id) || { name: 'Someone' }).name}**`;
const post = (where, body) => host.post(where, body);

/* ---------- Listen together ---------- */
/* Video ids from the usual YouTube link shapes, or a bare 11-character id. */
export function youtubeId(text) {
  const s = String(text || '').trim();
  const m = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(s);
  return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : null;
}
async function videoTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(4000) });
    if (r.status === 401 || r.status === 403) return { title: null, blocked: true };
    if (r.ok) return { title: String((await r.json()).title || '').slice(0, 120) || 'YouTube video' };
  } catch {}
  return { title: 'YouTube video' };
}
/* What every device needs to play in sync. Times are the server's clock (ms). While playing, the position in
   seconds is (serverNow - startedAt) / 1000; while paused it's pausedAt. */
const view = (st) => st && st.now ? {
  now: { videoId: st.now.videoId, file: st.now.file || null, video: !!st.now.video, title: st.now.title, by: st.now.by, seq: st.now.seq, startedAt: st.now.startedAt, pausedAt: st.now.pausedAt },
  queue: st.queue.map((x) => ({ videoId: x.videoId, file: x.file || null, video: !!x.video, title: x.title, by: x.by })),
} : null;
const share = (channelId) => { const st = music.get(channelId); if (st) host.music(st.serverId, channelId, view(st)); };
export const musicStates = (serverIds) => [...music].filter(([, st]) => st.now && serverIds.has(st.serverId)).map(([channelId, st]) => ({ channelId, state: view(st) }));
const position = (now) => now.startedAt == null ? now.pausedAt : Math.max(0, (Date.now() - now.startedAt) / 1000);
const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function startNext(st) {
  const next = st.queue.shift();
  // Start 1.5 s from now, so every device has time to load the video and begin at the same moment.
  st.now = next ? Object.assign(next, { seq: ++seq, startedAt: Date.now() + 1500, pausedAt: null }) : null;
  return st.now;
}
function myMusic(user) {
  const v = host.voiceOf(user.id);
  if (!v) fail('Join a voice channel first. Music plays for everyone in your voice channel.');
  const st = music.get(v.channelId);
  if (!st || !st.now) fail('Nothing is playing in your voice channel. Start something with /play and a YouTube link.');
  return { v, st };
}

async function play(ctx) {
  const v = host.voiceOf(ctx.user.id);
  if (!v) fail('Join a voice channel first. Music plays for everyone in your voice channel.');
  const cmd = ctx.video ? '/watch' : '/play';
  if (!ctx.args) fail(`Paste a YouTube link after ${cmd}, like: ${cmd} https://youtu.be/dQw4w9WgXcQ`);
  const id = youtubeId(ctx.args);
  if (!id) fail(`That doesn’t look like a YouTube link. Copy the link from YouTube’s Share button and paste it after ${cmd}.`);
  const { title, blocked } = await videoTitle(id);
  if (blocked) fail('That video’s owner doesn’t allow playing it outside YouTube. Try another one.');
  if (!host.voiceOf(ctx.user.id)) fail('You left voice before the video loaded.');
  enqueue(ctx, v, { videoId: id, title, by: ctx.user.id, video: !!ctx.video });
}
/* /watch: the same, but it opens on the big screen for everyone (a watch party instead of background music). */
const watch = (ctx) => play(Object.assign(ctx, { video: true }));
function enqueue(ctx, v, item) {
  const title = item.title;
  let st = music.get(v.channelId);
  if (!st) { st = { serverId: v.serverId, queue: [], now: null }; music.set(v.channelId, st); }
  st.where = ctx.where;
  st.channelName = v.channelName;
  if (st.queue.length >= 50) fail('The queue is full (50 videos). Skip some first.');
  st.queue.push(item);
  if (!st.now) {
    startNext(st);
    post(ctx.where, `${item.video || item.file ? '🎬 Now showing' : '🎵 Now playing'} **${title}** in 🔊 ${v.channelName}, added by ${who(ctx.user.id)}`);
  } else post(ctx.where, `➕ ${who(ctx.user.id)} added **${title}** to the queue in 🔊 ${v.channelName} (number ${st.queue.length})`);
  share(v.channelId);
}
function pause(ctx) {
  const { v, st } = myMusic(ctx.user);
  if (st.now.startedAt == null) fail('The music is already paused. /resume starts it again.');
  st.now.pausedAt = position(st.now); st.now.startedAt = null;
  post(ctx.where, `⏸️ ${who(ctx.user.id)} paused **${st.now.title}**`);
  share(v.channelId);
}
function resume(ctx) {
  const { v, st } = myMusic(ctx.user);
  if (st.now.startedAt != null) fail('The music is already playing.');
  st.now.startedAt = Date.now() + 500 - st.now.pausedAt * 1000; st.now.pausedAt = null;
  post(ctx.where, `▶️ ${who(ctx.user.id)} resumed **${st.now.title}**`);
  share(v.channelId);
}
function skip(ctx) {
  const { v, st } = myMusic(ctx.user);
  const was = st.now.title;
  const next = startNext(st);
  post(ctx.where, `⏭️ ${who(ctx.user.id)} skipped **${was}**` + (next ? `. Now playing **${next.title}**` : '. That was the last one in the queue.'));
  share(v.channelId);
}
function stop(ctx) {
  const { v, st } = myMusic(ctx.user);
  st.queue = []; st.now = null;
  post(ctx.where, `⏹️ ${who(ctx.user.id)} stopped the music.`);
  share(v.channelId);
}
function queue(ctx) {
  const { st } = myMusic(ctx.user);
  const n = st.now;
  const lines = [`🎵 **Now:** ${n.title} (${fmtTime(position(n))}${n.startedAt == null ? ', paused' : ''}), added by ${who(n.by)}`];
  st.queue.forEach((x, i) => lines.push(`${i + 1}. ${x.title}, added by ${who(x.by)}`));
  if (!st.queue.length) lines.push('Nothing else in the queue. Add more with /play.');
  return { ephemeral: lines.join('\n') };
}
/* Watch together: a video someone shared in the chat plays for everyone in your voice channel, in sync, in the
   same player and queue as /play. Each device streams it straight from the server. */
export function watchFile(user, where, att) {
  const v = host.voiceOf(user.id);
  if (!v) fail('Join a voice channel first. The video plays for everyone in your voice channel.');
  enqueue({ user, where }, v, { videoId: null, file: { url: att.url, type: att.type }, title: `🎬 ${String(att.name || 'Video').slice(0, 110)}`, by: user.id, video: true });
  return {};
}
/* A device finished the video (or YouTube refused to play it). The first report for the current video moves on. */
export function musicEvent(user, d) {
  const v = host.voiceOf(user.id);
  const st = v && v.channelId === Number(d.channelId) && music.get(v.channelId);
  if (!st || !st.now || st.now.seq !== Number(d.seq)) return {};
  const was = st.now;
  if (d.kind === 'error') {
    // 101/150: the owner blocks embedding. Other errors (bad id, removed video) are skipped too.
    const why = was.file ? 'this video format doesn’t play in browsers (MP4 or WebM work best)' : d.code === 101 || d.code === 150 ? 'its owner doesn’t allow playing it outside YouTube' : 'YouTube couldn’t play it';
    post(st.where, `⚠️ Skipped **${was.title}**: ${why}.`);
  } else if (d.kind === 'ended' && position(was) < 5) return {};   // a device that thinks it ended right at the start is wrong
  const next = startNext(st);
  if (next) post(st.where, `${next.video || next.file ? '🎬 Now showing' : '🎵 Now playing'} **${next.title}** in 🔊 ${st.channelName}, added by ${who(next.by)}`);
  share(v.channelId);
  return {};
}
/* The player's buttons run the same commands as typing them. */
export function musicControl(user, action) {
  const run = { pause, resume, skip, stop }[action];
  if (!run) fail('Unknown action.');
  const v = host.voiceOf(user.id);
  const st = v && music.get(v.channelId);
  return run({ user, where: (st && st.where) || null, args: '' });
}
/* The last person left the voice channel: the music stops. */
export function voiceEmptied(channelId) {
  if (music.delete(channelId)) host.music(null, channelId, null);
}

/* ---------- fun ---------- */
function roll(ctx) {
  const m = /^(?:(\d{1,2})?d)?(\d{1,4})?$/i.exec(ctx.args.replace(/\s+/g, ''));
  if (!m) fail('Try /roll, /roll 20 (a 20-sided die) or /roll 2d6 (two 6-sided dice).');
  const count = Math.min(Math.max(Number(m[1] || 1), 1), 20), sides = Math.min(Math.max(Number(m[2] || 6), 2), 1000);
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  const total = rolls.reduce((a, b) => a + b, 0);
  post(ctx.where, `🎲 ${who(ctx.user.id)} rolled **${total}**` + (count > 1 ? ` (${count}d${sides}: ${rolls.join(' + ')})` : ` (1 to ${sides})`));
}
function coinflip(ctx) {
  post(ctx.where, `🪙 ${who(ctx.user.id)} flipped a coin: **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**`);
}
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
function poll(ctx) {
  const parts = ctx.args.split('|').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) fail('Write a question, then the choices separated by |, like: /poll Pizza or burgers? | Pizza | Burgers');
  const [question, ...choices] = parts;
  host.poll(ctx.user, ctx.where, question, choices.length ? choices : ['Yes', 'No']);   // the same poll card as the + button makes
}
/* Party Bot's own reaction for each choice under a poll, so everyone votes with one click. */
function seedReactions(msg, emojis) {
  let reactions = [];
  for (const e of emojis) reactions = M.react(bot.id, msg.id, e, true);
  host.broadcastReactions(msg, reactions);
}
/* ---------- XP and levels (see M.addXp) ---------- */
function levelServer(where) {
  const ch = where.channelId && M.getChannel(where.channelId), srv = ch && M.getServer(ch.server_id);
  if (!srv || srv.kind !== 'server') fail('Levels are per server: try this in a server channel.');
  const xp = M.xpOf(srv.id), members = new Set(M.memberIds(srv.id));
  const board = Object.entries(xp).map(([id, n]) => [Number(id), n]).filter(([id, n]) => members.has(id) && n > 0).sort((a, b) => b[1] - a[1]);
  return { srv, xp, board };
}
function rank(ctx) {
  const { xp, board } = levelServer(ctx.where);
  const m = /<@(\d+)>/.exec(ctx.args), id = m ? Number(m[1]) : ctx.user.id, n = xp[id] || 0, lvl = M.levelOf(n);
  const place = board.findIndex(([x]) => x === id) + 1, next = 30 * (lvl + 1) ** 2;
  post(ctx.where, `🏅 ${who(id)} is **level ${lvl}** (${n} XP${place ? `, #${place} here` : ''}). ${next - n} XP to level ${lvl + 1}.`);
}
function top(ctx) {
  const { srv, board } = levelServer(ctx.where);
  if (!board.length) return { ephemeral: 'Nobody has any XP here yet. Chat or hang out in voice to earn some!' };
  const medals = ['🥇', '🥈', '🥉'];
  post(ctx.where, `🏆 **Top of ${srv.name}**\n` + board.slice(0, 10).map(([id, n], i) => `${medals[i] || `${i + 1}.`} ${who(id)}: level ${M.levelOf(n)} (${n} XP)`).join('\n'));
}
const UNITS = { s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };
function remind(ctx) {
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]+)\s+([\s\S]+)$/i.exec(ctx.args);
  const unit = m && UNITS[m[2].toLowerCase()];
  if (!unit) fail('Say when, then what, like: /remind 10m take the pizza out (s, m, h or d).');
  const secs = Math.round(Number(m[1].replace(',', '.')) * unit);
  if (secs < 5 || secs > 30 * 86400) fail('Reminders can be from 5 seconds to 30 days away.');
  const pending = one('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?', ctx.user.id).n;
  if (pending >= 25) fail('You already have 25 reminders waiting.');
  const text = m[3].trim().slice(0, 500);
  run('INSERT INTO reminders (user_id, channel_id, dm_id, body, due_at) VALUES (?, ?, ?, ?, ?)',
    ctx.user.id, ctx.where.channelId || null, ctx.where.dmId || null, text, Date.now() + secs * 1000);
  const when = secs < 60 ? `${secs} seconds` : secs < 3600 ? `${Math.round(secs / 60)} minutes` : secs < 86400 ? `${+(secs / 3600).toFixed(1)} hours` : `${+(secs / 86400).toFixed(1)} days`;
  return { ephemeral: `⏰ Okay, I’ll remind you here in ${when}: ${text}` };
}
/* "Remind me about this" (a message): Party Bot sends it back to you privately, with a link to the message. */
function fireMsgReminders() {
  for (const r of M.dueMsgReminders()) {
    const m = M.getMessage(r.message_id);
    const dm = M.dmWith(bot.id, r.user_id, true);
    if (!m) { post({ dmId: dm.id }, '⏰ Reminder: the message you asked me to remind you about has been deleted.'); continue; }
    const where = r.jump.startsWith('c:') ? ` in ${(M.getChannel(m.channel_id) || {}).kind === 'voice' ? '🔊 ' : '#'}${(M.getChannel(m.channel_id) || { name: '?' }).name}` : ' in your private chat';
    const quote = M.readableBody(m.body).replace(/\s+/g, ' ').slice(0, 200) || (m.attachments ? '(a file)' : '');
    post({ dmId: dm.id }, `⏰ You asked me to remind you about this message from ${who(m.user_id)}${where}:\n> ${quote}\n<m:${r.jump}:${m.id}>`);
  }
}
function fireReminders() {
  fireMsgReminders();
  for (const r of all('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50', Date.now())) {
    run('DELETE FROM reminders WHERE id = ?', r.id);
    try { post(r.channel_id ? { channelId: r.channel_id } : { dmId: r.dm_id }, `⏰ ${at(r.user_id)} reminder: ${r.body}`); } catch {}
  }
}
/* /game Name: add a game to this chat's list of games to play (the 🎮 button). /games: what's on it. */
function game(ctx) {
  if (!ctx.args) return games(ctx);
  const [name, url] = ctx.args.split(/\s+(?=https?:\/\/)/);
  M.addGame(ctx.user.id, ctx.where, { name, url });
  host.games(ctx.where);
  return { ephemeral: `🎮 Added **${name.trim().slice(0, 80)}** to this chat’s game list. See it all with the 🎮 button at the top.` };
}
/* Vote tonight's game: a poll of this chat's games nobody has ticked off yet (most wanted first, up to 10).
   Everyone votes with reactions, and Party Bot announces the winner when time's up. */
const POLL_MINUTES = [15, 30, 60, 120];
const minute = () => Number(process.env.POLL_MINUTE_MS) || 60_000;   // tests make minutes short
/* intro: replaces the "X started a vote" line (game nights use their own). */
export function startGamePoll(user, where, minutes, intro) {
  const open = M.gamesOf(where).filter((g) => !g.playedAt).slice(0, 10);
  if (open.length < 2) fail('Add at least 2 games to the list first (or untick ones you’ve played).');
  const running = one('SELECT message_id FROM game_polls WHERE channel_id IS ? AND dm_id IS ?', where.channelId || null, where.dmId || null);
  if (running && M.getMessage(running.message_id)) fail('There’s already a vote running here. Wait for the result first.');
  if (running) run('DELETE FROM game_polls WHERE message_id = ?', running.message_id);   // its message was deleted: that vote is over
  const mins = POLL_MINUTES.includes(Number(minutes)) ? Number(minutes) : 30;
  const ends = Date.now() + mins * minute();
  const emojis = NUMBERS.slice(0, open.length);
  const msg = post(where, `🗳️ **What do we play tonight?** ${intro || `${who(user.id)} started a vote.`} Vote for every game you’d play with the reactions below. Result <t:${Math.floor(ends / 1000)}:R>.\n`
    + open.map((g, i) => `${emojis[i]} ${g.name}${g.note ? ` · ${g.note}` : ''}`).join('\n'));
  if (!msg) fail('Couldn’t start the vote.');
  seedReactions(msg, emojis);
  run('INSERT INTO game_polls (message_id, channel_id, dm_id, options, ends_at) VALUES (?, ?, ?, ?, ?)', msg.id, where.channelId || null, where.dmId || null,
    JSON.stringify(open.map((g, i) => ({ emoji: emojis[i], name: g.name, url: g.url || null }))), ends);
  return {};
}
/* Game nights (events with a game vote): the vote opens before the event starts and ends when it starts,
   mentioning everyone going. Without enough games on the list, Party Bot just says so. */
function gameNightVotes() {
  for (const e of M.gameVotesDue(minute())) {
    if (!e.announce_channel_id || !M.getChannel(e.announce_channel_id)) continue;
    const where = { channelId: e.announce_channel_id }, ev = M.eventView(e);
    const going = ev.going.map((id) => `<@${id}>`).join(' ');
    const intro = `**${e.title}** starts <t:${Math.floor(e.starts_at / 1000)}:R>${going ? ` ${going}` : ''}.`;
    const left = Math.max(1, Math.round((e.starts_at - Date.now()) / minute()));
    const mins = POLL_MINUTES.filter((m) => m <= left).pop() || POLL_MINUTES[0];
    try { startGamePoll(M.getUser(e.creator_id) || bot, where, mins, intro); }
    catch (err) { post(where, `🎮 ${intro} No game vote this time: ${err instanceof M.UserError ? err.message : 'something went wrong.'}`); }
  }
}
function closeGamePolls() {
  gameNightVotes();
  for (const p of all('SELECT * FROM game_polls WHERE ends_at <= ?', Date.now())) {
    run('DELETE FROM game_polls WHERE message_id = ?', p.message_id);
    if (!M.getMessage(p.message_id)) continue;   // the poll was deleted
    const where = p.channel_id ? { channelId: p.channel_id } : { dmId: p.dm_id };
    const votes = new Map(all('SELECT emoji, COUNT(*) AS n FROM reactions WHERE message_id = ? AND user_id != ? GROUP BY emoji', p.message_id, bot.id).map((r) => [r.emoji, r.n]));
    const options = JSON.parse(p.options).map((o) => Object.assign(o, { n: votes.get(o.emoji) || 0 }));
    const top = Math.max(...options.map((o) => o.n));
    let text;
    if (!top) text = '🗳️ Nobody voted, so no game was picked. 😴 Maybe next time!';
    else {
      const best = options.filter((o) => o.n === top), win = best[Math.floor(Math.random() * best.length)];
      const votesText = `${top} vote${top === 1 ? '' : 's'}`;
      text = best.length > 1
        ? `🏆 It’s a tie between ${best.map((o) => `**${o.name}**`).join(' and ')} (${votesText} each), so I picked… **${win.name}**! 🎮${win.url ? ` ${win.url}` : ''}`
        : `🏆 Tonight’s game: **${win.name}** with ${votesText}! 🎮${win.url ? ` ${win.url}` : ''}`;
    }
    try { host.post(where, text, p.message_id); } catch {}
  }
}
function games(ctx) {
  const list = M.gamesOf(ctx.where);
  const open = list.filter((g) => !g.playedAt), done = list.length - open.length;
  if (!list.length) return { ephemeral: 'No games on this chat’s list yet. Add one with /game and its name, or the 🎮 button at the top.' };
  return { ephemeral: [`🎮 **Games to play here** (${open.length}${done ? `, plus ${done} played` : ''})`, ...open.slice(0, 15).map((g, i) => `${i + 1}. ${g.name}${g.votes.length ? ` · 👍 ${g.votes.length}` : ''}${g.note ? ` · ${g.note}` : ''}`)].join('\n') };
}
function vote(ctx) {
  const m = /^(\d+)\s*(m|min|mins|minutes|h|hour|hours)?$/i.exec(ctx.args);
  const mins = m ? Number(m[1]) * (/^h/i.test(m[2] || '') ? 60 : 1) : 30;
  if (ctx.args && (!m || !POLL_MINUTES.includes(mins))) fail('Votes can last 15m, 30m, 1h or 2h, like: /vote 1h');
  return startGamePoll(ctx.user, ctx.where, mins);
}
/* The question shows up right away for everyone, and the answer arrives as a reply to it. */
async function ask(ctx) {
  const q = checkAsk(ctx.user, ctx.args);
  const asked = post(ctx.where, `❓ ${who(ctx.user.id)} asked: ${q.slice(0, 1500)}`);
  if (!asked) return { ephemeral: 'Party Bot couldn’t post in this chat just now. Try again in a bit.' };   // post() returns null when it fails
  askClaude(ctx.user, ctx.where, q)
    .then((answer) => host.post(ctx.where, answer, asked.id))
    .catch((e) => host.post(ctx.where, `😕 ${e instanceof M.UserError ? e.message : 'Party Bot couldn’t answer just now.'}`, asked.id));
}
/* Birthdays: from 9 in the morning (the server's time zone, TZ in deploy/.env; BIRTHDAY_HOUR changes the hour), Party Bot wishes a happy birthday
   in every server the person is in, once a year. Feb 29 birthdays are celebrated on Feb 28 in other years. */
export function birthdays() {
  const d = new Date();
  if (d.getHours() < (process.env.BIRTHDAY_HOUR ? Number(process.env.BIRTHDAY_HOUR) : 9)) return;
  const today = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const leap = new Date(d.getFullYear(), 1, 29).getMonth() === 1;
  const days = today === '02-28' && !leap ? ['02-28', '02-29'] : [today];
  for (const u of all(`SELECT id FROM users WHERE is_bot = 0 AND birthday IN (${days.map(() => '?').join(',')})`, ...days)) {
    if (one('SELECT 1 AS x FROM birthday_posts WHERE user_id = ? AND year = ?', u.id, d.getFullYear())) continue;
    run('INSERT INTO birthday_posts (user_id, year) VALUES (?, ?)', u.id, d.getFullYear());
    for (const sid of M.serverIdsOf(u.id)) {
      const srv = M.getServer(sid);
      if (!srv || srv.kind !== 'server') continue;
      const ch = one("SELECT id FROM channels WHERE server_id = ? AND kind = 'text' ORDER BY (name = 'general') DESC, position, id LIMIT 1", sid);
      if (ch) post({ channelId: ch.id }, `🎂 Happy birthday ${at(u.id)}! 🎉🥳 Have an amazing day!`);
    }
  }
}
/* Server health: Party Bot privately tells the admins when something needs them (disk nearly full, memory
   nearly used up, an automatic update failed, last night's backup didn't happen). Each problem is reported again
   at most every 12 hours while it lasts, and once more when it's fixed. */
const warned = new Map();   // problem key -> last warned at
export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8')); } catch { return null; } };
export function healthProblems() {
  const out = [];
  try {
    const st = fs.statfsSync(config.dataDir), free = st.bavail * st.bsize, total = st.blocks * st.bsize;
    if (free < 2 * 1024 ** 3 || free / total < 0.1) out.push(['disk', `💾 The server’s disk is nearly full: ${(free / 1024 ** 3).toFixed(1)} GB free of ${(total / 1024 ** 3).toFixed(0)} GB. Big videos and files use the most. Ask friends to clean up old ones, or move to a bigger server.`]);
  } catch {}
  const memFree = os.freemem() / os.totalmem();
  if (memFree < 0.05) out.push(['memory', `🧠 The server’s memory is nearly used up (${Math.round(memFree * 100)}% free). If things get slow, restart it: \`cd /opt/party-line/deploy && docker compose restart\`.`]);
  const up = readJson('update-status.json');
  // Keyed by the version it tried, not the time: an update that keeps failing the same way is one problem (told
  // every 12 hours), not a new one every 10 minutes.
  if (up && up.ok === false) out.push([`update:${up.version || ''}`, `⚠️ An automatic update failed${up.version ? ` (to ${up.version})` : ''}, so the server is still on the old version. ${up.error ? `The error: ${up.error}` : ''} See \`tail /var/log/party-line-update.log\` on the server.`]);
  const bk = readJson('backup-status.json');
  if (bk && bk.at && Date.now() / 1000 - bk.at > 50 * 3600) out.push(['backup', `🗄️ The nightly backup hasn’t run for ${Math.round((Date.now() / 1000 - bk.at) / 3600)} hours. Check \`tail /var/log/party-line-backup.log\` on the server.`]);
  if (bk && bk.offsiteError) out.push([`offsite:${bk.at}`, `🗄️ Last night’s backup couldn’t be copied off the server: ${bk.offsiteError}`]);
  return out;
}
function health() {
  const problems = healthProblems(), now = Date.now();
  const tell = (text) => {
    for (const admin of M.allUsers().filter((u) => u.admin && !u.bot)) {
      try { post({ dmId: M.dmWith(bot.id, admin.id, true).id }, text); } catch {}
    }
  };
  for (const [key, text] of problems) {
    const last = warned.get(key);
    if (last && now - last < 12 * 3600_000) continue;
    warned.set(key, now);
    tell(`${text}\n_Only admins get these health notes._`);
  }
  for (const key of [...warned.keys()]) {
    if (problems.some(([k]) => k === key)) continue;
    warned.delete(key);
    if (key === 'disk' || key === 'memory') tell(key === 'disk' ? '✅ The server’s disk has room again.' : '✅ The server’s memory is fine again.');
  }
}
const HELP = [
  '**Party Bot commands**',
  '🎵 **Listen together** (join a voice channel first; everyone in it hears the same thing at the same moment)',
  '/play <YouTube link>: play it, or add it to the queue',
  '/watch <YouTube link>: a watch party: the same, on the big screen for everyone',
  '/pause, /resume, /skip, /stop',
  '/queue: what’s playing and what’s next',
  '🎬 **Watch together**: press Watch together under a video someone shared in the chat',
  '🎲 **Fun**',
  '/roll: a 6-sided die. /roll 20 or /roll 2d6 for others',
  '/coinflip: heads or tails',
  '/poll Question | Choice 1 | Choice 2: a poll (or press + then Poll for more options)',
  '/remind 10m take the pizza out: a reminder in this chat (s, m, h or d)',
  '🏅 **Levels** (chatting and time in voice earn XP)',
  '/rank: your level here (or /rank @someone). /top: the leaderboard',
  '🎮 **Games**',
  '/game Name: add a game to this chat’s list for later (or use the 🎮 button). /games: the list',
  '/vote: everyone votes on tonight’s game from the list (/vote 1h for a longer vote)',
  '🤖 **Ask**',
  '/ask anything: Party Bot answers (it reads the last few messages here for context)',
].join('\n');

export const COMMANDS = {
  play, watch, pause, resume, skip, stop, queue, np: queue, roll, coinflip, flip: coinflip, poll, remind, ask, game, games, vote, rank, top, leaderboard: top,
  help: () => ({ ephemeral: HELP }),
};
/* For the command hints in the message box. */
export const COMMAND_LIST = [
  ['play', '<YouTube link>', 'Play a video for everyone in your voice channel'], ['watch', '<YouTube link>', 'Watch a YouTube video together on the big screen'],
  ['pause', '', 'Pause the music'], ['resume', '', 'Resume the music'], ['skip', '', 'Skip to the next video'],
  ['stop', '', 'Stop the music and clear the queue'], ['queue', '', 'What’s playing and what’s next'],
  ['roll', '[20 or 2d6]', 'Roll dice'], ['coinflip', '', 'Heads or tails'],
  ['poll', 'Question | Choice | Choice', 'Start a poll'],
  ['remind', '10m what', 'Get a reminder in this chat'], ['rank', '[@someone]', 'Level and XP in this server'], ['top', '', 'The server’s XP leaderboard'], ['ask', 'question', 'Party Bot answers with AI'], ['game', 'Name', 'Add a game to this chat’s list'], ['games', '', 'Games to play here'], ['vote', '[15m, 30m, 1h or 2h]', 'Vote on tonight’s game from the list'], ['help', '', 'All bot commands'],
];

export const isCommand = (body) => { const m = /^\/([a-z]+)(?:\s|$)/i.exec(String(body || '').trim()); return !!(m && Object.hasOwn(COMMANDS, m[1].toLowerCase())); };
export async function runCommand(user, where, body) {
  const m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(String(body).trim());
  try {
    return (await COMMANDS[m[1].toLowerCase()]({ user, where, args: m[2].trim() })) || {};
  } catch (e) {
    if (e instanceof M.UserError) return { ephemeral: e.message };
    throw e;
  }
}
