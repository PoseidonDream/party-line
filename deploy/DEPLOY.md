# Putting Party Line online

This guide gets your own Party Line server running for about **$5 a month**. Once it's up, friends can use it in two ways:

- **Website:** open your address (for example `https://mygroup.duckdns.org`) in any browser, on a PC or a phone.
- **Desktop app:** install Party Line on Windows, Mac or Linux. It connects to the same server, so everyone is in the same place.

You need about 30 minutes. You don't need to know how to program.

## What you'll pay

| Thing | Cost | Notes |
|---|---|---|
| A small server (VPS) | about $4–6 a month | Hetzner CX22 (about €4), DigitalOcean Basic ($6) or Vultr ($5). The smallest plan is enough for a friend group. |
| A web address | free | A free name from [DuckDNS](https://www.duckdns.org), such as `mygroup.duckdns.org`. If you already own a domain, you can use that instead. |
| The desktop app builds | free | GitHub builds the installers for you. |

## Step 1: Get a free web address

1. Go to [duckdns.org](https://www.duckdns.org) and sign in (with Google, GitHub and so on).
2. Type a name, for example `mygroup`, and press **add domain**. Your address is now `mygroup.duckdns.org`.
3. Leave the page open. You'll paste your server's IP address there in step 3.

## Step 2: Rent the server

Using Hetzner as the example (the others are almost the same):

1. Make an account at [hetzner.com/cloud](https://www.hetzner.com/cloud) and create a project.
2. Press **Add server** and choose:
   - **Location:** the one closest to your friends.
   - **Image:** Ubuntu 24.04.
   - **Type:** the cheapest shared one (CX22).
   - **SSH key:** add one if you know how. If not, skip it and Hetzner emails you a root password.
3. Press **Create & Buy**. After a few seconds you'll see the server's **IPv4 address**, something like `203.0.113.10`.

## Step 3: Point your address at the server

Back on DuckDNS, paste the server's IPv4 address into the **current ip** box next to your name and press **update ip**.

## Step 4: Install Party Line (one command)

1. Open a terminal: **PowerShell** on Windows, **Terminal** on Mac.
2. Connect to your server, using your own IP address:
   ```
   ssh root@203.0.113.10
   ```
   Type `yes` if it asks about a fingerprint, then the root password (it doesn't show while you type).
3. Paste this and press Enter:
   ```
   curl -fsSL https://raw.githubusercontent.com/PoseidonDream/party-line/app/deploy/setup.sh | bash
   ```
4. It asks four questions:
   - **Your server's address:** `mygroup.duckdns.org`
   - **Group password:** the password friends need to make an account. Pick something only your group knows.
   - **Admin account name:** press Enter to keep `Poseidon`.
   - **Public IP:** press Enter. It fills this in for you.
5. Wait for **Done!**. The first time takes a few minutes.

## Step 5: Make your admin account first

Open `https://mygroup.duckdns.org`, press **Create account** and sign up with the name **Poseidon** (or whatever you chose as admin). Do this before you share the link, so nobody else takes the admin name.

Then send your friends the address and the group password. Each person picks their own name and password once, and their devices remember them after that.

## Step 6: Build the desktop app

GitHub builds the Windows, Mac and Linux installers for you.

1. On GitHub, open the repository → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**.
   - Name: `PARTY_LINE_SERVER`
   - Value: `https://mygroup.duckdns.org`

   This builds your address into the app, so friends never have to type it.
2. Go to **Actions** → **Desktop app** → **Run workflow**.
3. After about 10 minutes, open **Releases** on the repository's front page. You'll find:
   - `Party-Line-…-win-x64.exe` for **Windows**
   - `Party-Line-…-mac-universal.dmg` for **Mac**
   - `Party-Line-…-linux-x86_64.AppImage` for **Linux**
4. Send friends the link to the release page.

The installers aren't signed with a paid certificate (see [app/SIGNING.md](../app/SIGNING.md) to add one), so the first time:
- **Windows** shows "Windows protected your PC". Click **More info → Run anyway**.
- **Mac** says the app can't be checked. Right-click the app → **Open** → **Open**.

The app updates itself: when you publish a newer release, everyone gets it on their next restart. To make one, push a tag such as `desktop-v1.0.1`, or run the workflow again after raising `version` in `app/desktop/package.json`.

## Phones

- **Android:** there's a real app. Run **Actions → Android app → Run workflow** (after setting `PARTY_LINE_SERVER` in step 6) and share the `.apk` it makes. In the app, voice keeps running when the phone locks or you switch apps. See [app/SIGNING.md](../app/SIGNING.md) to sign it so updates install over the old version.
- **iPhone:** use the website in Safari → Share → **Add to Home Screen**. A real iPhone app needs Apple's $99/year developer account and a Mac; the steps are in [app/SIGNING.md](../app/SIGNING.md).

The website also works in any phone browser for chat, voice and watching screen shares. On the website, voice stops when the phone locks. Sharing your screen from a phone isn't supported.

## Looking after it

Connect with `ssh root@YOUR-IP`, then:

| To… | Run |
|---|---|
| Update right now (it also updates by itself, see below) | `/opt/party-line/deploy/update.sh` |
| See what the automatic updates did | `tail /var/log/party-line-update.log` |
| Make a backup right now | `/opt/party-line/deploy/backup.sh` |
| Put a backup back | `/opt/party-line/deploy/backup.sh restore /opt/party-line/deploy/backups/FILE.tgz` |
| See what the server is doing | `cd /opt/party-line/deploy && docker compose logs -f --tail 100` |
| Restart it | `cd /opt/party-line/deploy && docker compose restart` |
| Change the group password | edit `/opt/party-line/deploy/.env`, then run `docker compose up -d` in that folder |

**Updates install by themselves.** Every 10 minutes the server checks GitHub for a newer Party Line and installs it, but only while nobody is in voice, so calls aren't cut off. (If someone stays in voice for 2 hours straight, often a forgotten open tab, it updates anyway; everyone reconnects within seconds.) To turn this off, add the line `AUTO_UPDATE=0` to `/opt/party-line/deploy/.env`.

**Backups happen by themselves every night at 4:17** (server time). The newest 7 are kept in `/opt/party-line/deploy/backups/`. They live on the same server, so if the server dies they die with it. Three ways to keep a copy somewhere else (pick any):

1. **Download one from the app.** Developer panel → Server → **Download a backup**. It saves everything (accounts, messages, photos, files) as one `.tgz` file. Keep it private: it holds everyone's messages.
2. **Copy them off the server automatically, every night (free).** Backblaze B2 gives 10 GB free:
   1. Sign up at backblaze.com → **B2 Cloud Storage**. Create a bucket (Private), e.g. `poseidon-party-backups`.
   2. **Application Keys → Add a New Application Key**, allow access to that bucket only. Copy the **keyID** and **applicationKey** (it's shown once).
   3. On the server, `nano /opt/party-line/deploy/.env` and add:
      ```
      BACKUP_REMOTE=poseidon-party-backups
      BACKUP_ACCOUNT=the keyID
      BACKUP_KEY=the applicationKey
      ```
   4. Test it: `/opt/party-line/deploy/backup.sh`. It should end with "Copied off the server". The developer panel shows whether last night's copy worked. Copies older than 30 days are deleted from the bucket (change with `BACKUP_REMOTE_DAYS=60`).

   Any S3-compatible storage works too (Cloudflare R2, Hetzner Object Storage, Wasabi): set `BACKUP_TYPE=s3`, `BACKUP_PROVIDER` (e.g. `Cloudflare`), `BACKUP_ENDPOINT` (the URL they give you), and `BACKUP_ACCOUNT` / `BACKUP_KEY` to the access key and secret.
3. **Your provider's backup option** (about €1 a month on Hetzner: server → Backups → Enable).

To put a backup back, copy the `.tgz` to the server and run `/opt/party-line/deploy/backup.sh restore FILE.tgz`.

Updates keep everything. People in voice are dropped for a few seconds and reconnect on their own.

## How much can it handle?

- **Text chat, friends and private messages** go through your server. The smallest server handles hundreds of people.
- **Voice and screen sharing** go directly between people, the same as the old site, so they cost your server almost nothing. One voice channel works well with up to about 10 people. For bigger channels, turn on the media server (see "Bigger voice channels" below).
- **The voice relay (TURN)** steps in only for people on strict networks (some school, office or hotel Wi-Fi). Their voice then passes through your server, which uses some of its monthly traffic. Hetzner includes 20 TB, which is plenty.
- **Photos and videos** are stored on the server's disk. The smallest plan has 40 GB.

## Bigger voice channels (optional)

By default, voice and screen shares go directly between people. That costs your server nothing and works well up to about 10 people in one channel. If your group often has more, turn on the **media server**: everyone then sends their voice once to your server, and it passes it on to everyone else.

```
/opt/party-line/deploy/voice-server.sh on
```

Turn it off again with `voice-server.sh off`. People already in voice switch over the next time they join a channel.

With it on, voice uses your server's traffic. That's roughly 1 GB per person per 10 hours of talking, or more with cameras and screen shares, which is still small next to Hetzner's 20 TB. If your provider has its own firewall in the dashboard, also open TCP 7881 and UDP 7882 there.

## What friends can do

- **Chat:** messages, replies, reactions, @mentions, editing, search (Ctrl+K), **pinned messages** (the Pinned button lists them), **link previews** (YouTube links play right in the chat), photos, videos and **any file** up to 25 MB, and **voice messages** (the mic button in the message box).
- **Voice:** voice channels with screen sharing, camera, noise filter, push to talk, the **soundboard**, and Listen together (see Party Bot below).
- **Private chats:** one-to-one chats, **group chats** for 3 to 10 people (the + next to Private chats), and **calls** in either (the Call button). Starting a call rings the others.
- **You:** click your picture at the bottom left to set **Online, Idle, Do not disturb or Invisible** and a custom status. Settings has **About me** and a banner color. The desktop app shows **"Playing ..."** when you're in a known game (switch it off in the tray menu).
- **Events:** the Events button in a server plans things like game night. Friends answer Going or Maybe, and Party Bot reminds everyone going 15 minutes before.
- **Notifications:** the bell at the top of a chat chooses All messages, Only @mentions or Nothing (the server menu sets the default). In the website, Settings → **Even when Party Line is closed** sends private messages, @mentions and calls to the phone or computer even with the tab closed (on iPhone, Add to Home Screen first).
- **Desktop app extras** (all in the tray icon's menu): **Ctrl+Shift+M** mutes and **Ctrl+Shift+D** deafens from any app, even mid-game (pick other keys in the menu). An **overlay** in the top-left corner shows who's in your voice channel and who's talking while you're in a game (works in windowed and borderless games, not exclusive full screen). **Start with the computer** can start quietly in the tray.
- **Organising a server:** channel topics, **categories** (server menu), drag and drop to reorder channels, and **roles** with colors and permissions (server menu, Roles).

## Party Bot: music and fun commands

Type these in any text channel or private chat. Type **/** to see the list.

- **Listen together:** join a voice channel, then type `/play` and a YouTube link. Everyone in that voice channel hears it at the same moment, in a small YouTube player at the top right. `/pause`, `/resume`, `/skip`, `/stop` and `/queue` control it, and so do the player's buttons. The volume slider and the ✕ only affect you. The music stops when everyone leaves the channel.
- **Watch together:** while you're in a voice channel, press **Watch together** under any video shared in the chat. It plays for everyone in that voice channel at the same moment, in the same player and queue as `/play` (with a full-screen button).
- **Fun:** `/roll` (or `/roll 20`, `/roll 2d6`), `/coinflip`, `/poll Question | Choice | Choice` (everyone votes with reactions) and `/remind 10m take the pizza out`.
- `/help` lists everything.

Each device plays the video in YouTube's own player, so it follows YouTube's rules. A few videos can't be played outside YouTube, and the bot skips those.

### /ask: Party Bot answers questions (optional, costs a little)

Type `/ask` and any question, like `/ask what time is it in Tokyo?` or `/ask what did Bora mean?`. Party Bot answers in the chat using Claude (Anthropic's AI) and reads the last few messages so it knows what you're talking about. It's off until you add a key:

1. Sign up at console.anthropic.com, add a little credit (Billing; $5 lasts a long time for a friend group), then **API Keys → Create Key** and copy it.
2. On the server: `nano /opt/party-line/deploy/.env` and add the line `ANTHROPIC_API_KEY=sk-ant-...`
3. Run `cd /opt/party-line/deploy && docker compose up -d`.

It uses Claude Opus 5.5 at low effort, which answers well. To make it much cheaper, add `ASK_MODEL=claude-haiku-5-5` (about 40 times cheaper per question, a bit less clever). Limits keep the bill small: 10 questions per person per hour and 200 a day for everyone together (change with `ASK_DAILY_LIMIT=100`). Set a monthly spending limit in the Anthropic console too, for peace of mind.

## Developer panel (for you)

Signed in as the admin (Poseidon), click the **Home** button (top left) → **Developer**, under Friends. The Friends page also has a **Developer** button at the right of its tabs. You can also press **Ctrl+Shift+D** (Cmd+Shift+D on a Mac), or open the server menu → **Developer**. You'll see:
- **Server:** the server's version (and the app you're using), how long it's been up, memory and storage, who's online, who's in which voice channel, whether last night's backup worked, and **Download a backup**.
- **My voice:** live numbers for each voice connection: direct or relayed, ping, lost packets, and how much sound is coming in and going out. "0 kbps" in red means sound stopped arriving from that friend.
- **Log:** voice problems and errors from **everyone's** app, so when a friend says "my voice broke" you can see what happened on their side.
- **Check a friend:** pulls a friend's live voice numbers to your screen. They get a short note that you checked.

## If something's wrong

- **The address doesn't open:** check that DuckDNS shows your server's IP, then wait a few minutes. HTTPS certificates are set up automatically the first time someone visits.
- **"Couldn't connect voice with…":** check that the firewall ports are open. `setup.sh` opens them, but some providers also have their own firewall in the dashboard. Open TCP 80 and 443, UDP 443, TCP and UDP 3478, and UDP 49160–49200.
- **Someone forgot their password:** they press **Forgot your password?** on the sign-in screen, pick a new password, and ask. You get a notification (🔑) with **Approve** and **Deny**: approve only if you're sure it's them, and they're signed in right away. (You can also click their name → **Reset password** to make a temporary password yourself.)
