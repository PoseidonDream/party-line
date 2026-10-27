/* Streaks and achievements. A streak counts the days in a row someone chatted or hung out in voice (on the
   server's clock). Achievements are kept on the person as { key: when }. hub.js calls these and tells everyone
   about changes. */
import { run } from './db.js';
import * as M from './model.js';

export const ACHIEVEMENTS = [
  { key: 'first_words', emoji: '💬', name: 'First words', how: 'Send your first message.' },
  { key: 'chatterbox', emoji: '🗣️', name: 'Chatterbox', how: 'Send 1,000 messages.' },
  { key: 'night_owl', emoji: '🦉', name: 'Night owl', how: 'Chat between 2 and 5 at night.' },
  { key: 'early_bird', emoji: '🐦', name: 'Early bird', how: 'Chat between 5 and 7 in the morning.' },
  { key: 'voice_veteran', emoji: '🎧', name: 'Voice veteran', how: 'Spend 10 hours in voice with friends.' },
  { key: 'marathon', emoji: '🏃', name: 'Marathon', how: 'Stay in voice for 3 hours in a row.' },
  { key: 'on_fire', emoji: '🔥', name: 'On fire', how: 'Keep a 7-day streak.' },
  { key: 'unstoppable', emoji: '☄️', name: 'Unstoppable', how: 'Keep a 30-day streak.' },
  { key: 'double_digits', emoji: '🔟', name: 'Double digits', how: 'Reach level 10.' },
  { key: 'poll_master', emoji: '📊', name: 'Poll master', how: 'Start 10 polls.' },
  { key: 'famous', emoji: '⭐', name: 'Famous', how: 'Get a message into the hall of fame.' },
  { key: 'squad_up', emoji: '🎮', name: 'Squad up', how: 'Fill a Looking for group post.' },
  { key: 'picasso', emoji: '🎨', name: 'Picasso', how: 'Draw on someone’s screen share.' },
  { key: 'director', emoji: '🎬', name: 'Director', how: 'Save a clip of a screen share.' },
  { key: 'planner', emoji: '📅', name: 'Planner', how: 'Plan an event.' },
];
const KEYS = new Set(ACHIEVEMENTS.map((a) => a.key));

/* True if it's new. */
export function award(userId, key) {
  const u = M.getUser(userId);
  if (!u || u.is_bot || !KEYS.has(key)) return false;
  const badges = u.badges ? JSON.parse(u.badges) : {};
  if (badges[key]) return false;
  badges[key] = Date.now();
  run('UPDATE users SET badges = ? WHERE id = ?', JSON.stringify(badges), userId);
  return true;
}
/* Counts today for the streak. True if the streak changed (the first activity of the day). */
function touchStreak(u) {
  const today = M.dayKey(0);
  if (u.streak_day === today) return false;
  const streak = u.streak_day === M.dayKey(-1) ? u.streak + 1 : 1;
  run('UPDATE users SET streak = ?, streak_day = ?, best_streak = MAX(best_streak, ?) WHERE id = ?', streak, today, streak, u.id);
  u.streak = streak;
  return true;
}
function streakBadges(u, got) {
  if (u.streak >= 7 && award(u.id, 'on_fire')) got.push('on_fire');
  if (u.streak >= 30 && award(u.id, 'unstoppable')) got.push('unstoppable');
}
/* Each result: { got: [new achievement keys], changed: whether others should get the person's new profile }. */
export function onMessage(userId) {
  run('UPDATE users SET msg_count = msg_count + 1 WHERE id = ?', userId);
  const u = M.getUser(userId), got = [];
  if (!u || u.is_bot) return { got, changed: false };
  const changed = touchStreak(u);
  const h = new Date().getHours();
  const earn = (key, when) => { if (when && award(userId, key)) got.push(key); };
  earn('first_words', true);
  earn('chatterbox', u.msg_count >= 1000);
  earn('night_owl', h >= 2 && h < 5);
  earn('early_bird', h >= 5 && h < 7);
  streakBadges(u, got);
  return { got, changed: changed || got.length > 0 };
}
/* A minute in voice with someone else; `since` is when they joined the channel. */
export function onVoiceMinute(userId, since) {
  run('UPDATE users SET voice_min = voice_min + 1 WHERE id = ?', userId);
  const u = M.getUser(userId), got = [];
  if (!u || u.is_bot) return { got, changed: false };
  const changed = touchStreak(u);
  if (u.voice_min >= 600 && award(userId, 'voice_veteran')) got.push('voice_veteran');
  if (since && Date.now() - since >= 3 * 3600_000 && award(userId, 'marathon')) got.push('marathon');
  streakBadges(u, got);
  return { got, changed: changed || got.length > 0 };
}
export function onPoll(userId) {
  run('UPDATE users SET poll_count = poll_count + 1 WHERE id = ?', userId);
  const u = M.getUser(userId);
  return { got: u && u.poll_count >= 10 && award(userId, 'poll_master') ? ['poll_master'] : [], changed: false };
}
/* Achievements that come from one thing happening (famous, squad_up, picasso, director, planner, double_digits). */
export const once = (userId, key) => ({ got: award(userId, key) ? [key] : [], changed: false });
