# Security check (1 November 2026)

A full pass over Party Line against a 20-point checklist: the server, the web app, the desktop and Android apps, the deploy kit and the git history. Each point says what was checked, what was found, and what was changed. Every point is covered by automatic tests (named in brackets), so a later change that breaks one fails the tests.

**Found and fixed in this pass**

- **One oversized message could stop the whole server.** A message over 256 KB on the live connection raised an error that nothing caught, and the server process exited. Any signed-in person could have knocked everyone offline. Now only that one connection closes. [hardening]
- **Invisible text-direction characters** (like U+202E) were accepted in names, server and channel names, events and messages. They can make a name or link read backwards, for example `exe.gpj` showing as `jpg.exe`. Now they're removed from everything the server receives, together with stray control characters and look-alike invisible spaces in names. [hardening]
- **Password hashing was below today's recommended strength.** It used scrypt N=2^14. Now it's N=2^15, r=8, p=3, the strength OWASP recommends. Older passwords are upgraded automatically the next time each person signs in. The hashing now runs off the main thread, so a sign-in never freezes the server for others. [hardening]
- **Outdated packages:** the server's email library (nodemailer) and its request parser (body-parser) had known high-severity problems, and the desktop app ran on Electron 33, which no longer gets security fixes. All are updated. [CI: package-security]

## 1. Hide my API keys
API keys (Claude, Giphy, LiveKit, TURN, email) live only in `deploy/.env` on the server and are read by the server. The web, desktop and Android apps never receive them: they only see the setting names in help messages. [secrets: "the web app … has no server settings in it"]

## 2. Check my env variables
`deploy/.env` is in `.gitignore`, created by `setup.sh` with `chmod 600` (only root can read it), and never served. `deploy/.env.example` has only empty values and placeholders. [secrets, hardening: ".env can't be opened"]

## 3. Protect my admin routes
Every admin and developer action (developer panel, reports, feedback, usage, password resets, kicks, backups) checks for admin rights on the server, not only in the app. A backup download needs a one-time link that expires in 2 minutes. The "how many people are in voice" address only answers from inside the machine. [hardening: "admin tools refuse people who aren't admins", security]

## 4. Add proper authentication
- Sign-in keys are 256-bit random values. The server stores only a fingerprint of each one, so a copy of the database can't be used to sign in.
- Unused sign-ins end after 4 months. Changing your password signs out every other device.
- Optional 2-step sign-in uses authenticator codes, and each code works only once.
- A wrong name and a wrong password get the same answer, in the same time.

[security, hardening]

## 5. Check user access
I probed all 100+ live actions as a member trying to reach another person's private server, messages and private chats. Nothing could be read or changed: posting, editing, deleting, reacting, making channels or invites, giving yourself roles, renaming or deleting the server, and pinning other people's private messages were all refused. Channel history, pins, media and search return nothing from servers you're not in. [hardening]

## 6. Sanitize my forms
Every text the server stores has a length limit (names 24, channels 32, messages 4,000 characters, and so on). It was checked by sending oversized and odd input to every action. Requests over 64 KB (web) or 256 KB (live connection) are refused. Control characters and direction-flipping characters are removed centrally, before any action runs. Keys like `__proto__` are dropped from requests. [hardening]

## 7. Protect against XSS
Everything people write is put on the page as plain text, never as HTML. Links only work for `http(s)`. The page's Content-Security-Policy runs only the server's own scripts, so even a slip couldn't run injected code. Uploaded files are served with their own strict rules: they can't run scripts, and unknown types only download. [hardening: "code typed into a message or profile … never runs", security]

## 8. Add rate limiting
- **Sign-in and sign-up:** 20 tries per address per 10 minutes, and 10 wrong passwords per account per 15 minutes.
- **Messages and feedback:** 30 messages per 30 seconds, and 5 feedback reports per 10 minutes.
- **Uploads and GIF search:** 60 uploads per minute, and 30 GIF searches per minute.
- **Invites:** guessing invite links stops after 10 that don't work.
- **Live connection:** 60 requests a second.
- **New in this pass:** a ceiling of 1,200 requests a minute per address for the whole API.

[security, hardening]

## 9. Secure my API endpoints
Every route except the public ones requires a sign-in key. The public routes are sign-in, sign-up, password reset, server info, push key, uploaded files and signed link pictures:
- Uploaded files use 144-bit random names that can't be guessed.
- Link pictures only load with the server's own signature, so nobody can use the server as a proxy.

[security, hardening]

## 10. Check my CORS settings
The server sends no CORS headers, so no other website can read from it. Sign-in uses a key sent by the app, not cookies, so another site can't act as you either (no CSRF). [hardening]

## 11. Add security headers
- **Content-Security-Policy:** only the server's own scripts can run.
- **Framing:** `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so other sites can't embed the app.
- **Other headers:** `X-Content-Type-Options: nosniff`, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy.
- **HSTS:** browsers stay on HTTPS.
- **Hidden server details:** `X-Powered-By` is off, and Caddy no longer sends a `Server` header.

Checked on the live server. [security]

## 12. Turn off debug mode
The server runs with `NODE_ENV=production`. Errors reach the app as a short message ("Something went wrong on the server."), never with code details. The test-only `CSP_TEST_EVAL` switch is off unless a test sets it. No passwords, keys or codes are written to the logs, and the logs are capped at 15 MB per service. [hardening: "a broken request gets a short answer"]

## 13. Update my dependencies
- **Server:** nodemailer 6 → 10, ws 8.22, body-parser fixed. `npm audit` now finds 0 problems. livekit-client stays on 2.9: it has no known problems, and newer versions don't work with the media server (LiveKit 1.8) that big voice channels use.
- **Desktop:** Electron 33 → 45 (a supported version), electron-builder 26 and electron-updater 6.8.11. 0 problems in what ships.
- **Android:** Capacitor 7.6.10.
- **Ongoing:** the GitHub tests now check the shipped packages of all three apps every Monday and on every change. GitHub emails you if a new serious problem shows up.

The remaining audit notes are only in desktop build tools (minimatch inside electron-builder), which never ship inside the app.

## 14. Remove unused packages
Every package is used. Server: Claude SDK (/ask), Express (web), LiveKit client (big voice), nodemailer (email), qrcode (2-step), web-push (notifications), ws (live connection). Desktop: electron-updater. Android: Capacitor. Nothing removed.

## 15. Check for exposed files
`.env`, `.git`, source code, `package.json`, the database, `node_modules` and source maps can't be opened from outside. Paths that try to climb folders (`../`) don't work. Checked locally and on the live server. [hardening]

## 16. Secure my database
- **Queries:** every query passes values as parameters, never pasted into the SQL, so SQL injection isn't possible.
- **Access:** the database is never served and isn't reachable from the internet. Only the app container uses it, running as the non-root `node` user.
- **Files:** the database, uploads and keys are now readable by the server only (`umask 077`, files 600). Backups on the server are also private (`backups/` is 700).

[hardening: "the database file is readable by the server only"]

## 17. Hash passwords properly
Passwords are hashed with scrypt N=2^15, r=8, p=3, a 16-byte random salt and a constant-time compare, and old hashes upgrade at sign-in. Passwords need at least 8 characters, and the server never stores or logs them. [hardening]

## 18. Check git for leaked secrets
All 142 commits in the history were searched for API keys, tokens, private keys and filled-in passwords: none found. Only empty settings and placeholders like `abcd efgh ijkl mnop` appear. Signing keys and the keystore were never committed; GitHub keeps them as encrypted secrets. A new test searches every file on each run, so a key can't slip in unnoticed. [secrets]

## 19. Run a full security audit
This page. Besides the checklist: the desktop app opens only your server (sandboxed windows, no Node access for pages, links open in the browser), and the Android app only talks to your server over HTTPS.

## 20. Make no mistakes
The full test suite runs on every change (650+ checks), including the two new security tests, `hardening` and `secrets`.

## Worth knowing
- **Pins:** anyone in a chat can pin a message there. That's on purpose: friends share the pin board. If you'd rather only moderators could, say so.
- **Hosting:** the server is only as safe as the machine. Keep the VPS's own updates on (`unattended-upgrades` on Ubuntu) and use an SSH key, not a password, for `root`.
