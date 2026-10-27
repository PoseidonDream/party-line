/* Which features friends actually use, so the admins can see what's worth keeping. Each use is counted per person
   per day (nothing about what was said), mostly from the requests apps send (hub.js calls track()), and for things
   that happen only inside the app (voice effects, pop out…) from a small "feature.used" note it sends.
   Every Monday morning (REPORT_DAY / REPORT_HOUR, the server's time zone: TZ in deploy/.env) Party Bot sends the
   admins last week's report: what nobody used, what was hardly used, and what was used most. */
import { one, all, run } from './db.js';
import * as M from './model.js';
import { askEnabled } from './ask.js';

/* key, name, where to find it (for the developer panel), and for things the server owner switches on: why it's off. */
export const FEATURES = [
  // Chat
  ['chat', '💬 Chat messages', 'Typing in a text channel'],
  ['dm', '✉️ Private chats', 'Home → Private chats'],
  ['groups', '👥 Group chats', 'Home → Private chats → +'],
  ['voicechat', '🗨️ Chat in voice channels', 'Chat button at the top of a voice channel'],
  ['replies', '↩️ Replies', 'Reply on a message'],
  ['reactions', '😀 Reactions', 'The smiley on a message'],
  ['mentions', '📣 @mentions', 'Typing @ in a message'],
  ['richtext', '✍️ Bold, code and quotes', '**bold**, `code`, > quote'],
  ['spoilers', '🙈 Spoilers', '||hidden text||'],
  ['edit', '✏️ Editing messages', 'The pencil on your message'],
  ['photos', '🖼️ Photos and videos', '+ → Photos, videos or files'],
  ['files', '📎 Other files', '+ → Photos, videos or files'],
  ['voicemsg', '🎙️ Voice messages', 'Hold the mic next to the message box'],
  ['gifs', '🎞️ GIFs', '🙂 → GIFs', () => !process.env.GIPHY_KEY && 'needs GIPHY_KEY'],
  ['stickers', '🏷️ Stickers', '🙂 → Stickers'],
  ['customemoji', '🙂 Server emoji', 'Server menu → Emoji & stickers'],
  ['search', '🔎 Search', 'The magnifier at the top (Ctrl+K)'],
  ['pins', '📌 Pinned messages', 'The pin at the top of a chat'],
  ['bookmarks', '🔖 Saved messages', 'The bookmark on a message, Home → Saved messages'],
  ['gallery', '🗂️ Media gallery', 'The picture button at the top of a chat'],
  ['sendlater', '🕒 Send later', 'The clock next to the message box'],
  ['reminders', '⏰ Reminders', 'The clock on a message, or /remind'],
  ['disappearing', '⏳ Disappearing messages', 'The ⏳ in a private or group chat'],
  ['switcher', '⚡ Jump to (Ctrl+P)', 'Ctrl+P, or Home → Jump to'],
  // Fun and together
  ['polls', '📊 Polls', '+ → Poll, or /poll'],
  ['lfg', '🎮 Looking for group', '+ → Looking for group, or /lfg'],
  ['events', '📅 Events and game nights', 'The calendar at the top of a server'],
  ['gamelist', '📝 Game list', 'The 🎮 at the top of a chat, or /game'],
  ['gamevote', '🗳️ Vote tonight’s game', '🎮 → Vote tonight’s game, or /vote'],
  ['dice', '🎲 Dice and coin flip', '/roll, /coinflip'],
  ['music', '🎵 Listen together', '/play in a voice channel'],
  ['watchparty', '🎬 Watch parties', '/watch, or Watch together under a video'],
  ['ask', '🤖 /ask (AI)', '/ask a question', () => !askEnabled() && 'needs ANTHROPIC_API_KEY'],
  ['levels', '🏅 Levels and leaderboard', 'Home → Leaderboard, /rank, /top'],
  ['halloffame', '⭐ Hall of fame', '⭐ reactions on a message'],
  ['home', '🏠 Home dashboard', 'The Home button (top left)'],
  ['profile', '🎨 Profile looks', 'Settings → Profile'],
  ['status', '🟢 Status', 'Click your name at the bottom left'],
  ['friends', '🤝 Friends', 'Home → Friends → Add friend'],
  ['feedback', '💡 Feedback', 'Server menu → Feedback'],
  // Voice
  ['voice', '🔊 Voice channels', 'Click a voice channel'],
  ['screenshare', '🖥️ Screen sharing', 'The screen button in the voice bar'],
  ['watchscreen', '👀 Watching screens', 'Click LIVE, or the bubble of whoever is live'],
  ['camera', '📷 Camera', 'The camera button in the voice bar'],
  ['soundboard', '📯 Soundboard', 'The soundboard button in the voice bar'],
  ['customsounds', '🔉 Your own sounds', 'Soundboard → Add a sound'],
  ['soundkeys', '⌨️ Soundboard keys', 'Soundboard → Keys'],
  ['voicefx', '✨ Voice effects', 'The ✨ in the voice bar'],
  ['draw', '🖍️ Drawing on screens', 'Draw, while watching a screen'],
  ['clips', '🎬 Clip it', '🎬, while watching a screen'],
  ['popout', '🪟 Pop out', 'Pop out, while watching a screen'],
  ['voicestatus', '🏷️ Voice channel status', 'Set a status, in a voice channel'],
  ['calls', '📞 Private calls', 'The phone in a private chat'],
  ['playing', '🕹️ “Playing” status', 'The desktop app shows the game you’re in'],
  // Settings
  ['theme', '🌓 Theme and accent color', 'Settings → Look'],
  ['notifyprefs', '🔔 Notification settings', 'The bell at the top of a chat'],
  ['push', '📲 Notifications when closed', 'Settings → Alerts'],
].map(([key, name, where, off]) => ({ key, name, where, off }));
const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));
/* Things only the app itself sees; it tells the server with "feature.used". */
export const CLIENT_KEYS = new Set(['switcher', 'home', 'watchscreen', 'soundkeys', 'voicefx', 'popout', 'theme', 'levels']);

const dayOf = (offset = 0) => M.dayKey(offset);
export function count(userId, key) {
  if (!BY_KEY.has(key)) return;
  const u = M.getUser(userId);
  if (!u || u.is_bot) return;
  run('INSERT INTO feature_use (day, feature, user_id, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, feature, user_id) DO UPDATE SET n = n + 1', dayOf(), key, userId);
}
/* For things that are looked at rather than done (opening search, the gallery…): once a minute per person. */
const lastSeen = new Map();
export function countOnce(userId, key, ms = 60_000) {
  const k = `${userId}:${key}`, t = Date.now();
  if (t - (lastSeen.get(k) || 0) < ms) return;
  lastSeen.set(k, t);
  count(userId, key);
}

const BY_TYPE = {
  'poll.create': 'polls', 'poll.vote': 'polls', 'lfg.create': 'lfg', 'lfg.join': 'lfg',
  'remind.set': 'reminders', 'disappear.set': 'disappearing', 'bookmark.set': 'bookmarks', 'later.add': 'sendlater',
  'msg.edit': 'edit', 'msg.pin': 'pins',
  'games.add': 'gamelist', 'games.vote': 'gamelist', 'games.played': 'gamelist', 'games.pick': 'gamelist', 'games.poll': 'gamevote',
  'group.create': 'groups', 'group.add': 'groups', 'call.start': 'calls', 'friend.request': 'friends', 'friend.accept': 'friends',
  'voice.join': 'voice', 'sound.add': 'customsounds', 'emoji.add': 'customemoji', 'gif.fav': 'gifs',
  'event.create': 'events', 'event.rsvp': 'events', 'music.watch': 'watchparty', 'voice.status': 'voicestatus',
  'clip.post': 'clips', 'notify.set': 'notifyprefs', 'feedback.send': 'feedback',
};
const COMMANDS = {
  play: 'music', pause: 'music', resume: 'music', skip: 'music', stop: 'music', queue: 'music', np: 'music', watch: 'watchparty',
  roll: 'dice', coinflip: 'dice', flip: 'dice', poll: 'polls', remind: 'reminders', ask: 'ask', game: 'gamelist', games: 'gamelist',
  vote: 'gamevote', lfg: 'lfg', rank: 'levels', top: 'levels', leaderboard: 'levels',
};
const PROFILE_FIELDS = ['bio', 'banner', 'flair', 'bannerFx', 'nameColor', 'favGames', 'birthday'];

/* A request someone's app sent, that worked: what it used. */
export function track(user, d, reply) {
  try {
    if (!user || user.is_bot || !d || (reply && reply.error)) return;
    const use = (k) => count(user.id, k);
    if (Object.hasOwn(BY_TYPE, d.t)) use(BY_TYPE[d.t]);
    if (d.t === 'react') { if (d.on) { use('reactions'); if (d.emoji === '⭐') use('halloffame'); } }   // adding one, not taking it away
    else if (d.t === 'sound.play') { use('soundboard'); if (!d.builtin) use('customsounds'); }
    else if (d.t === 'profile.set') {
      if ('status' in d || 'custom' in d) use('status');
      if (PROFILE_FIELDS.some((f) => f in d)) use('profile');
    } else if (d.t === 'presence.activity') { if (d.name) countOnce(user.id, 'playing', 3_600_000); }
    else if (d.t === 'draw') { if (d.end) use('draw'); }
    else if (d.t === 'feature.used') { if (CLIENT_KEYS.has(d.key)) countOnce(user.id, d.key); }
    else if (d.t === 'msg.send') message(user, d, reply);
  } catch (e) { console.error('usage', e); }
}
function message(user, d, reply) {
  const body = String(d.body || '');
  const cmd = /^\/([a-z]+)(?:\s|$)/i.exec(body.trim());
  if (reply && reply.command) { const k = cmd && COMMANDS[cmd[1].toLowerCase()]; if (k) count(user.id, k); return; }
  const use = (k) => count(user.id, k);
  if (d.channelId) {
    const ch = M.getChannel(Number(d.channelId)), srv = ch && M.getServer(ch.server_id);
    use(srv && srv.kind === 'group' ? 'groups' : ch && ch.kind === 'voice' ? 'voicechat' : 'chat');
  } else use('dm');
  if (d.replyTo) use('replies');
  if (/<@\d+>/.test(body)) use('mentions');
  if (/\|\|[\s\S]+?\|\|/.test(body)) use('spoilers');
  if (/\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|^> /m.test(body)) use('richtext');
  if (/^<g:[\w-]+>$/.test(body)) use('gifs');
  if (/^<s:\d+>$/.test(body)) use('stickers');
  else if (/<:\w+:\d+>/.test(body)) use('customemoji');
  for (const a of d.attachments || []) {
    const up = M.getUpload(String(a && a.id || ''));
    if (!up) continue;
    if (/^Voice message/.test(up.name)) use('voicemsg');
    else if (/^(image|video)\//.test(up.type)) use('photos');
    else use('files');
  }
}

/* Uses and people per feature between two days (inclusive, 'YYYY-MM-DD'). */
function between(from, to) {
  const out = new Map(FEATURES.map((f) => [f.key, { uses: 0, people: 0 }]));
  for (const r of all('SELECT feature, SUM(n) AS uses, COUNT(DISTINCT user_id) AS people FROM feature_use WHERE day BETWEEN ? AND ? GROUP BY feature', from, to)) {
    if (out.has(r.feature)) out.set(r.feature, { uses: r.uses, people: r.people });
  }
  return out;
}
const since = () => (one('SELECT MIN(day) AS d FROM feature_use') || {}).d || null;

/* For the developer panel: the last 7 days (today included) next to the 7 before, least used first. */
export function stats() {
  const week = between(dayOf(-6), dayOf(0)), prev = between(dayOf(-13), dayOf(-7));
  const last = new Map(all('SELECT feature, MAX(day) AS d FROM feature_use GROUP BY feature').map((r) => [r.feature, r.d]));
  const people = (one('SELECT COUNT(DISTINCT user_id) AS n FROM feature_use WHERE day BETWEEN ? AND ?', dayOf(-6), dayOf(0)) || {}).n || 0;
  const features = FEATURES.map((f) => ({ key: f.key, name: f.name, where: f.where, off: (f.off && f.off()) || null, ...week.get(f.key), before: prev.get(f.key).uses, lastDay: last.get(f.key) || null }))
    .sort((a, b) => (!!a.off - !!b.off) || (a.uses - b.uses) || (a.people - b.people) || plain(a.name).localeCompare(plain(b.name)));
  return { features, people, since: since(), from: dayOf(-6), to: dayOf(0) };
}

const plain = (name) => name.replace(/^\P{L}+/u, '');   // without the emoji, for sorting
const fmtDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
/* The report Party Bot sends: the 7 days from `from` to `to`. */
export function report(from = dayOf(-7), to = dayOf(-1)) {
  const got = between(from, to), first = since();
  const people = (one('SELECT COUNT(DISTINCT user_id) AS n FROM feature_use WHERE day BETWEEN ? AND ?', from, to) || {}).n || 0;
  const on = FEATURES.filter((f) => !(f.off && f.off())), off = FEATURES.filter((f) => f.off && f.off());
  const rows = on.map((f) => ({ f, ...got.get(f.key) }));
  const unused = rows.filter((r) => !r.uses).sort((a, b) => plain(a.f.name).localeCompare(plain(b.f.name)));
  const used = rows.filter((r) => r.uses).sort((a, b) => b.uses - a.uses || b.people - a.people);
  const most = used.slice(0, 5), hardly = used.slice(5).reverse().slice(0, 6);   // the top 5, then the least used of the rest
  const lines = [`📊 **Weekly feature report** · ${fmtDay(from)} – ${fmtDay(to)}`, `${people} ${people === 1 ? 'person was' : 'people were'} active.`];
  if (unused.length) lines.push('', `**Nobody used** (${unused.length}): ${unused.map((r) => r.f.name).join(', ')}`);
  if (hardly.length) lines.push('', '**Hardly used:**', ...hardly.map((r) => `• ${r.f.name}: ${times(r.uses)}, ${r.people} ${r.people === 1 ? 'person' : 'people'}`));
  if (most.length) lines.push('', `**Most used:** ${most.map((r) => `${r.f.name} (${r.uses})`).join(', ')}`);
  if (off.length) lines.push('', `Switched off on this server, so not counted: ${off.map((f) => `${f.name} (${f.off().replace(/[A-Z_]{4,}/, '`$&`')})`).join(', ')}.`);
  if (!first || first > from) lines.push(`_Counting started ${first ? fmtDay(first) : 'today'}, so this week is only partly counted._`);
  lines.push('_Every feature’s numbers: Developer → Features. Only admins get this report._');
  return lines.join('\n');
}

/* Monday morning: last week's report to every admin, once. */
const kvGet = (k) => (one('SELECT value FROM kv WHERE key = ?', k) || {}).value;
const kvSet = (k, v) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, v);
export function initUsage(tellAdmins) {
  const check = () => {
    try {
      const d = new Date();
      if (kvGet('usage_pruned') !== dayOf()) { kvSet('usage_pruned', dayOf()); run('DELETE FROM feature_use WHERE day < ?', dayOf(-180)); }
      const day = process.env.REPORT_DAY ? Number(process.env.REPORT_DAY) : 1, hour = process.env.REPORT_HOUR ? Number(process.env.REPORT_HOUR) : 9;
      if (d.getDay() !== day || d.getHours() < hour || kvGet('usage_report') === dayOf()) return;
      kvSet('usage_report', dayOf());
      tellAdmins(report());
    } catch (e) { console.error('usage report', e); }
  };
  setInterval(check, Number(process.env.USAGE_TICK_MS) || 10 * 60_000).unref();
  setTimeout(check, Number(process.env.USAGE_FIRST_MS) || 90_000).unref();
}
