# Party Line app (server version)

Party Line as its own app: a server your group runs, a website and a desktop app that both connect to it.

| Folder | What it is |
|---|---|
| `server/` | Node.js server: accounts, servers, channels, saved messages, friends, private chats, photo and video uploads, who's online, and the handshakes that connect voice. Data goes in one SQLite file. Also serves the website. |
| `web/` | The website (plain HTML, CSS and JavaScript, no build step). Same look as the original Party Line. |
| `mobile/` | The Android app (Capacitor). It opens your server like the desktop app, and keeps voice running in the background with an "In voice" notification. Built by GitHub (Actions → Android app). See [SIGNING.md](SIGNING.md), and [PLAY_STORE.md](PLAY_STORE.md) for Google Play. |
| `desktop/` | The Windows, Mac and Linux app (Electron). It opens your server and adds a screen and window picker, push to talk that works in games, a tray icon and auto-updates. |
| `../deploy/` | Everything to run it on a $5 server: Docker, automatic HTTPS (Caddy), a voice relay (coturn) and a setup script. See [deploy/DEPLOY.md](../deploy/DEPLOY.md). |

## What changed from the peer-to-peer site

- **Real accounts:** each person has their own name and password, so nobody can use someone else's name.
- **Chats are saved on the server:** history, friends and private messages are there on every device, even when nobody else is online.
- **Messages reach people who are offline.** They see them next time they open Party Line.
- **Photos and videos are saved** and can be opened later.
- **Voice and screen sharing still go directly between people** (WebRTC), so they cost the server almost nothing. A built-in relay helps people on strict networks connect.
- **Desktop app** with push to talk while you're in a game.

The original site (`index.html` at the top of the repository) is untouched and still works on GitHub Pages.

## Run it on your computer

```
cd app/server
npm install
npm start
```

Open http://localhost:3000. Settings (environment variables):

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `DATA_DIR` | Where the database and uploads go | `server/data` |
| `ADMIN_NAMES` | Comma-separated account names with admin powers | `Poseidon` |
| `TURN_URLS`, `TURN_SECRET` | Voice relay for strict networks (set up for you by `deploy/`) | none |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy such as Caddy | off |

Desktop app during development:

```
cd app/desktop
npm install
npm start
```

## Tests

`app/tests` opens real Chromium windows that sign up, chat, share photos, add friends, send private messages, talk in voice, share a screen and use admin tools against a throwaway server. GitHub runs them on every change (Actions → Tests).

```
cd app/server && npm install
cd ../tests && npm install && npm run install-browser
npm test                 # everything
npm test -- chat-voice   # just one file
```

Screenshots land in `app/tests/results/`.

## Languages
The app is written in English. `web/js/i18n.js` swaps each piece of English text on screen for its translation from `web/i18n/<language>.json` (English text → translation), so the code keeps using plain English. What people write, and names, are never translated (the `SKIP` list in `i18n.js`).

When you add or change text in the app, add the same English line to all six files (`de`, `es`, `fr`, `it`, `ru`, `tr`); a line that's missing just shows in English. Text put together in code goes through `t()`: `t('{0} is typing…', name)`, and an app word inside it too: `t('Noise filter: {0}', t('Strong'))`. `tests/languages.test.mjs` checks every file has the same lines and keeps the `{0}` slots. The developer panel stays in English.

## Admin powers

Accounts named in `ADMIN_NAMES`, plus each server's creator for their own server, can:
- delete any message or channel
- disconnect someone from voice, mute them for everyone, or remove them from a server
- read the feedback inbox (admins only)
- rename or delete a server (the main "Party Line" server can't be deleted)
