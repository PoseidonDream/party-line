/* Settings come from environment variables (see deploy/.env.example). */
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export const config = {
  port: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 3000,   // 0 = any free port (tests)
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', 'data')),
  webDir: path.resolve(env.WEB_DIR || path.join(here, '..', '..', 'web')),
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
  maxFile: 25 * 1024 * 1024,
  // Commit and date of this version: from the Docker build, or from git when run from a checkout.
  version: env.GIT_COMMIT || (() => { try { return execSync("git log -1 --format='%h %cs'", { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })(),
  previewPrivate: env.LINK_PREVIEW_PRIVATE === '1',   // tests only: let link previews fetch local test pages   // audio, documents, zips and other files
  trustProxy: env.TRUST_PROXY === '1',
  // 1 = every new account joins the main server by itself. Otherwise new people need an invite link.
  autoJoin: env.AUTO_JOIN === '1',
  // Shown on the privacy policy and community rules pages as the way to reach whoever runs this server.
  contactEmail: env.CONTACT_EMAIL || '',
  // Optional email (codes to confirm an address, and password resets by email). Without SMTP_HOST, email stays hidden.
  smtp: { host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || env.SMTP_USER || '' },
  mailDir: env.MAIL_DIR || '',   // tests only: emails are written here as files instead of sent
};
