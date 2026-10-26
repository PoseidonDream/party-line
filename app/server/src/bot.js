/* Party Bot: commands typed in any text channel or private chat.
   - Listen together: /play <YouTube link> plays it for everyone in your voice channel at the same moment.
     Each device plays it in YouTube's own player; the server only keeps the shared queue and the clock,
     so nothing is downloaded or re-streamed. /pause, /resume, /skip, /stop, /queue.
   - Fun: /roll, /coinflip, /poll, /remind, /help.
   - /ask: answers a question with Claude (see ask.js).
   Problems with a command (no voice channel, a bad link) are answered privately to whoever typed it. */
import * as M from './model.js';
import { one, all, run } from './db.js';
import { ask as askClaude, checkAsk } from './ask.js';

let host = null;   // { post, broadcastReactions, voiceOf, usersIn, music } from hub.js
let bot = null;
const music = new Map();   // voice channelId -> { serverId, channelName, where, queue: [], now: null }
let seq = 0;

export function initBot(h) {
  host = h;
  bot = M.ensureBot();
  setInterval(fireReminders, 15_000).unref();
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
  now: { videoId: st.now.videoId, file: st.now.file || null, title: st.now.title, by: st.now.by, seq: st.now.seq, startedAt: st.now.startedAt, pausedAt: st.now.pausedAt },
  queue: st.queue.map((x) => ({ videoId: x.videoId, file: x.file || null, title: x.title, by: x.by })),
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
  if (!ctx.args) fail('Paste a YouTube link after /play, like: /play https://youtu.be/dQw4w9WgXcQ');
  const id = youtubeId(ctx.args);
  if (!id) fail('That doesn’t look like a YouTube link. Copy the link from YouTube’s Share button and paste it after /play.');
  const { title, blocked } = await videoTitle(id);
  if (blocked) fail('That video’s owner doesn’t allow playing it outside YouTube. Try another one.');
  if (!host.voiceOf(ctx.user.id)) fail('You left voice before the video loaded.');
  enqueue(ctx, v, { videoId: id, title, by: ctx.user.id });
}
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
    post(ctx.where, `🎵 Now playing **${title}** in 🔊 ${v.channelName}, added by ${who(ctx.user.id)}`);
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
  enqueue({ user, where }, v, { videoId: null, file: { url: att.url, type: att.type }, title: `🎬 ${String(att.name || 'Video').slice(0, 110)}`, by: user.id });
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
  if (next) post(st.where, `🎵 Now playing **${next.title}** in 🔊 ${st.channelName}, added by ${who(next.by)}`);
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
  if (choices.length > 10) fail('A poll can have up to 10 choices.');
  const emojis = choices.length ? NUMBERS.slice(0, choices.length) : ['👍', '👎'];
  const body = `📊 **${question}**\n` + (choices.length ? choices.map((c, i) => `${emojis[i]} ${c}`).join('\n') + '\n' : '') + `Vote with the reactions below. Poll by ${who(ctx.user.id)}`;
  const msg = post(ctx.where, body);
  let reactions = [];
  for (const e of emojis) reactions = M.react(bot.id, msg.id, e, true);
  host.broadcastReactions(msg, reactions);
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
function fireReminders() {
  for (const r of all('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50', Date.now())) {
    run('DELETE FROM reminders WHERE id = ?', r.id);
    try { post(r.channel_id ? { channelId: r.channel_id } : { dmId: r.dm_id }, `⏰ ${at(r.user_id)} reminder: ${r.body}`); } catch {}
  }
}
/* The question shows up right away for everyone, and the answer arrives as a reply to it. */
async function ask(ctx) {
  const q = checkAsk(ctx.user, ctx.args);
  const asked = post(ctx.where, `❓ ${who(ctx.user.id)} asked: ${q.slice(0, 1500)}`);
  askClaude(ctx.user, ctx.where, q)
    .then((answer) => host.post(ctx.where, answer, asked.id))
    .catch((e) => host.post(ctx.where, `😕 ${e instanceof M.UserError ? e.message : 'Party Bot couldn’t answer just now.'}`, asked.id));
}
const HELP = [
  '**Party Bot commands**',
  '🎵 **Listen together** (join a voice channel first; everyone in it hears the same thing at the same moment)',
  '/play <YouTube link>: play it, or add it to the queue',
  '/pause, /resume, /skip, /stop',
  '/queue: what’s playing and what’s next',
  '🎬 **Watch together**: press Watch together under a video someone shared in the chat',
  '🎲 **Fun**',
  '/roll: a 6-sided die. /roll 20 or /roll 2d6 for others',
  '/coinflip: heads or tails',
  '/poll Question | Choice 1 | Choice 2: everyone votes with reactions',
  '/remind 10m take the pizza out: a reminder in this chat (s, m, h or d)',
  '🤖 **Ask**',
  '/ask anything: Party Bot answers (it reads the last few messages here for context)',
].join('\n');

export const COMMANDS = {
  play, pause, resume, skip, stop, queue, np: queue, roll, coinflip, flip: coinflip, poll, remind, ask,
  help: () => ({ ephemeral: HELP }),
};
/* For the command hints in the message box. */
export const COMMAND_LIST = [
  ['play', '<YouTube link>', 'Play a video for everyone in your voice channel'],
  ['pause', '', 'Pause the music'], ['resume', '', 'Resume the music'], ['skip', '', 'Skip to the next video'],
  ['stop', '', 'Stop the music and clear the queue'], ['queue', '', 'What’s playing and what’s next'],
  ['roll', '[20 or 2d6]', 'Roll dice'], ['coinflip', '', 'Heads or tails'],
  ['poll', 'Question | Choice | Choice', 'Start a poll with reaction votes'],
  ['remind', '10m what', 'Get a reminder in this chat'], ['ask', 'question', 'Party Bot answers with AI'], ['help', '', 'All bot commands'],
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
