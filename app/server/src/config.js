/* Settings come from environment variables (see deploy/.env.example). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', 'data')),
  webDir: path.resolve(env.WEB_DIR || path.join(here, '..', '..', 'web')),
  // Needed to make a new account. Leave empty to let anyone sign up.
  groupPassword: env.GROUP_PASSWORD || '',
  // Accounts with these names are admins. Make the account yourself right after the first start.
  adminNames: list(env.ADMIN_NAMES || 'Poseidon'),
  // Optional TURN relay for people on strict networks (deploy/docker-compose.yml runs one).
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '',
  stunUrls: list(env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  // Optional media server for big voice channels (deploy/docker-compose.yml, profile "sfu").
  // When set, voice goes through it instead of directly between people.
  livekit: { url: env.LIVEKIT_URL || '', key: env.LIVEKIT_KEY || '', secret: env.LIVEKIT_SECRET || '' },
  maxImage: 15 * 1024 * 1024,
  maxVideo: 50 * 1024 * 1024,
  maxAvatar: 2 * 1024 * 1024,
  maxFile: 25 * 1024 * 1024,   // audio, documents, zips and other files
  trustProxy: env.TRUST_PROXY === '1',
};
