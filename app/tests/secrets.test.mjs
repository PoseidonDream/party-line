/* No secrets in the code: every file in the repository is searched for real-looking keys and passwords (API keys,
   private keys, filled-in passwords), the files that hold secrets stay out of git, and the web app (which anyone can
   download) never contains a server setting's value. */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATTERNS = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/],
  ['a GitHub token', /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ['a private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['a filled-in secret setting', /^[ \t#]*(TURN_SECRET|LIVEKIT_SECRET|LIVEKIT_KEY|SMTP_PASS|ANTHROPIC_API_KEY|GIPHY_KEY|BACKUP_SECRET|PL_KEYSTORE_PASSWORD|PL_KEY_PASSWORD)[ \t]*=[ \t]*(?![^\n]*(change|example|your|xxx|\$|<|…|\.\.\.|abcd efgh|the 16))[^\s'"]{6,}/m],
];

export default async function (ok) {
  const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const found = [];
  for (const f of files) {
    if (/node_modules|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|webm|mp3|ogg|wav|aab|apk|jar|zip|gz)$/i.test(f)) continue;
    let text; try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (f.endsWith('secrets.test.mjs')) continue;
    for (const [what, re] of PATTERNS) if (re.test(text)) found.push(`${what} in ${f}`);
  }
  ok(`no keys or passwords in any of the ${files.length} files in git${found.length ? ': ' + found.join(', ') : ''}`, !found.length);
  const tracked = files.filter((f) => /(^|\/)\.env$|\.jks$|\.keystore$|\.p12$|\.pem$|(^|\/)id_rsa|party-line\.db|google-services\.json|key\.properties$/.test(f));
  ok(`files that hold secrets (.env, signing keys, the database) aren’t in git${tracked.length ? ': ' + tracked.join(', ') : ''}`, !tracked.length);
  const ignored = (p) => { try { execSync(`git check-ignore -q "${p}"`, { cwd: root }); return true; } catch { return false; } };
  ok('…and git is set to leave them out (deploy/.env, backups, the server’s data folder)', ignored('deploy/.env') && ignored('deploy/backups/x.tgz') && ignored('app/server/data/party-line.db'));
  const web = execSync('git ls-files app/web', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const webLeaks = web.filter((f) => /\.(js|html|css)$/.test(f) && /process\.env|TURN_SECRET\s*[:=]|LIVEKIT_SECRET\s*[:=]|ANTHROPIC_API_KEY\s*[:=]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  ok(`the web app, which anyone can download, has no server settings in it${webLeaks.length ? ': ' + webLeaks.join(', ') : ''}`, !webLeaks.length);
}
