/* SQLite storage. One file (DATA_DIR/party-line.db) holds every account, server, channel and message. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'party-line.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  avatar TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS messages_dm ON messages(dm_id, id);
CREATE TABLE IF NOT EXISTS dms (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('outgoing', 'incoming', 'friends')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  last_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, target)
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

/* Upgrades for databases made by older versions. */
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (!columns('messages').includes('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!columns('users').includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER');
if (!columns('messages').includes('pinned_at')) db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER; ALTER TABLE messages ADD COLUMN pinned_by INTEGER;');
if (!columns('messages').includes('embeds')) db.exec('ALTER TABLE messages ADD COLUMN embeds TEXT');
for (const [col, def] of [['status', "TEXT NOT NULL DEFAULT 'online'"], ['custom_status', 'TEXT'], ['bio', 'TEXT'], ['banner', 'TEXT'],
  ['birthday', 'TEXT'], ['news_seen', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!columns('users').includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
}
if (!columns('channels').includes('topic')) db.exec('ALTER TABLE channels ADD COLUMN topic TEXT; ALTER TABLE channels ADD COLUMN category_id INTEGER;');
if (!columns('servers').includes('kind')) db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'; ALTER TABLE servers ADD COLUMN pair_key TEXT;");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS servers_pair ON servers(pair_key) WHERE pair_key IS NOT NULL');
if (!columns('servers').includes('afk_channel_id')) db.exec('ALTER TABLE servers ADD COLUMN afk_channel_id INTEGER');
if (!columns('sessions').includes('device')) db.exec('ALTER TABLE sessions ADD COLUMN device TEXT');
if (!columns('users').includes('totp_secret')) db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT; ALTER TABLE users ADD COLUMN totp_pending TEXT;');
if (!columns('users').includes('is_bot')) db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_message ON reactions(message_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  starts_at INTEGER NOT NULL,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  announce_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  perms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS sounds (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  upload_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reset_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  note TEXT,
  device TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  consumed INTEGER NOT NULL DEFAULT 0,
  decided_by INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS gif_cache (
  giphy_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_polls (
  message_id INTEGER PRIMARY KEY,
  channel_id INTEGER,
  dm_id INTEGER,
  options TEXT NOT NULL,
  ends_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS game_ideas (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  note TEXT,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  played_at INTEGER
);
CREATE INDEX IF NOT EXISTS game_ideas_where ON game_ideas (channel_id, dm_id);
CREATE TABLE IF NOT EXISTS game_votes (
  game_id INTEGER NOT NULL REFERENCES game_ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
CREATE TABLE IF NOT EXISTS emoji (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, kind, name)
);
CREATE TABLE IF NOT EXISTS fav_gifs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, upload_id)
);
CREATE TABLE IF NOT EXISTS birthday_posts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  PRIMARY KEY (user_id, year)
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (user_id, target)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id INTEGER,
  server_id INTEGER,
  action TEXT NOT NULL,
  details TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_previews (
  url TEXT PRIMARY KEY,
  data TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
// Which sign-in a push subscription belongs to, so signing that device out also stops its notifications.
if (!columns('push_subs').includes('session')) db.exec('ALTER TABLE push_subs ADD COLUMN session TEXT');

const cache = new Map();
/* Prepared statements are cached by their SQL text. */
export function q(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export const one = (sql, ...a) => q(sql).get(...a);
export const all = (sql, ...a) => q(sql).all(...a);
export const run = (sql, ...a) => q(sql).run(...a);
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
