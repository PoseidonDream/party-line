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

The installers aren't signed with a paid certificate, so the first time:
- **Windows** shows "Windows protected your PC". Click **More info → Run anyway**.
- **Mac** says the app can't be checked. Right-click the app → **Open** → **Open**.

The app updates itself: when you publish a newer release, everyone gets it on their next restart. To make one, push a tag such as `desktop-v1.0.1`, or run the workflow again after raising `version` in `app/desktop/package.json`.

## Phones

The website works on phones right now: chat, voice and watching screen shares. To get an app icon, open the address in Chrome (Android) or Safari (iPhone), then choose **Add to Home Screen**. Sharing your screen from a phone isn't supported.

## Looking after it

Connect with `ssh root@YOUR-IP`, then:

| To… | Run |
|---|---|
| Update to the newest Party Line | `/opt/party-line/deploy/update.sh` |
| Make a backup of all chats, accounts and pictures | `/opt/party-line/deploy/backup.sh` |
| See what the server is doing | `cd /opt/party-line/deploy && docker compose logs -f --tail 100` |
| Restart it | `cd /opt/party-line/deploy && docker compose restart` |
| Change the group password | edit `/opt/party-line/deploy/.env`, then run `docker compose up -d` in that folder |

Updates keep everything. People in voice are dropped for a few seconds and reconnect on their own.

## How much can it handle?

- **Text chat, friends and private messages** go through your server. The smallest server handles hundreds of people.
- **Voice and screen sharing** go directly between people, the same as the old site, so they cost your server almost nothing. One voice channel works well with up to about 10 people.
- **The voice relay (TURN)** steps in only for people on strict networks (some school, office or hotel Wi-Fi). Their voice then passes through your server, which uses some of its monthly traffic. Hetzner includes 20 TB, which is plenty.
- **Photos and videos** are stored on the server's disk. The smallest plan has 40 GB.

## If something's wrong

- **The address doesn't open:** check that DuckDNS shows your server's IP, then wait a few minutes. HTTPS certificates are set up automatically the first time someone visits.
- **"Couldn't connect voice with…":** check that the firewall ports are open. `setup.sh` opens them, but some providers also have their own firewall in the dashboard. Open TCP 80 and 443, UDP 443, TCP and UDP 3478, and UDP 49160–49200.
- **Forgot a password:** an admin can't see passwords. The simplest fix is to make a new account with a different name.
