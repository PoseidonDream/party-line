# Party Line

**A private, Discord-style place for a small group of friends to talk, play and hang out, right in the browser.**

**Open Party Line: https://poseidonparty.duckdns.org**

Download the app: **[Windows, Mac, Linux and Android](https://github.com/PoseidonDream/party-line/releases/latest)** · iPhone: open the link in Safari → Share → Add to Home Screen.

The link above is the new server version: real accounts, chats saved on the server, and desktop and Android apps (code on the [`app` branch](https://github.com/PoseidonDream/party-line/tree/app/app)). The rest of this page describes the original peer-to-peer site, which still works at https://poseidondream.github.io/party-line/.

Party Line gives a friend group its own servers with voice and text channels, screen sharing, photo and video sharing, friends and private messages. Nothing to install and no accounts: open the link, enter the group's password, pick a name, and you're in. Voice, video and messages go straight between your browsers (peer-to-peer). There's no company server in the middle, and nothing to pay for or run.

## What it's good for

- **Gaming nights:** a voice channel while you play, plus screen sharing so others can watch.
- **Hanging out:** an always-there voice room your friends can drop into.
- **Watching together or showing something:** share a window or tab with its sound.
- **Study groups and small projects:** text channels for links and notes, and voice when you need to talk.
- **Private one-to-one chats** with friends, outside any server.

It's built for **one friend group that shares a password**, not for public communities with strangers.

## How many people?

There's no fixed limit in the app. What decides it is each person's computer and internet, because everyone connects directly to everyone else. Every voice and every screen share is sent separately to each listener or viewer.

| What | Works well | Upper end | What sets the limit |
|---|---|---|---|
| People talking in one voice channel | 2–10 | about 15–20 on good computers and internet | Your voice is sent separately to each person in the channel. Phones run out of power first. |
| People watching one screen share | 2–5 | depends on the sharer's upload speed | The sharer sends a separate video to each viewer, about 1.5–2.5 Mbps each at 720p. |
| People online in one server at once | up to about 50 | roughly 500 in theory | Every pair of people keeps one light connection for chat; Chrome allows about 500 per page. Voice connections only exist between people in the same voice channel. |
| Servers | no limit | — | Each server is separate. When a voice channel passes 10 people, the app suggests opening another one. |
| Friends for private chats | dozens | about 150 open chat links per device | One link per online friend device. |

Going past these numbers smoothly would need a media server, where everyone sends their voice once and the server passes it on. That's how Discord handles big rooms. Party Line doesn't use one, so it stays free and needs nothing to run.

## Features

**Servers and channels**
- Servers with text and voice channels, Discord style. Anyone can add channels.
- A server bar on the left with your servers. Join or create one with **+**, and share an invite link.
- The text chat history is saved on your devices. When you come back, friends who are online fill you in on what you missed.
- Share photos and videos in chat (up to 15 MB per photo and 50 MB per video). They're shown live and aren't saved.

**Voice**
- Join a voice channel when you want. Opening a server doesn't put you in voice.
- Mute, deafen and push-to-talk, with keyboard shortcuts: M, D, N and Space.
- A background noise filter.
- A volume slider for each person, up to 150%, which only changes what you hear.
- A mic check that tells you when your mic isn't working and how to fix it.
- If you stay muted or deafened in voice for 30 minutes you're disconnected, with a warning 5 minutes before. Sharing your screen pauses the timer.
- When a voice channel gets crowded (more than 10 people), it suggests splitting up and opens a new channel such as "Lobby 2" with one click.

**Screen sharing**
- Share a screen, window or tab, with its sound where the browser allows it.
- Pick motion quality (720p, 30 fps) or detail quality (1080p, 15 fps).
- Screen sharing needs a desktop browser. On a phone you can still watch.

**Friends and private messages**
- Add friends by name, and accept or ignore requests under Online / All / Pending / Add friend.
- Private one-to-one chats that are separate from servers. You can stay in a server's voice channel while you chat.
- A message to a friend who's offline waits on your device and is sent when you're both online.
- Online dots, unread counts and pop-ups.

**Profiles**
- Each name is a profile with its own picture, servers, friends and chats.
- Use the same name on your laptop, PC and phone and they share everything.
- The group owner gets admin tools, and a feedback box lets anyone send the owner suggestions and bug reports.

## Using it

1. Open the live site and enter the group's password. Ask the person who invited you for it.
2. Pick a name, and add a picture if you like.
3. Press **+** on the left to join a server by name, or open an invite link a friend sent you.
4. Click a voice channel to talk. Use headphones to avoid echo.

Works best in **Chrome, Edge or Firefox**. Phones can chat, talk and watch.

## Privacy and how it works

- **Password:** the site asks for the group's password. The password itself isn't in the code; only a one-way check of it is. The password also scrambles every server's address, so someone without it can't find your servers.
- **Peer-to-peer:** voice, video and messages travel directly between browsers using WebRTC (through [PeerJS](https://peerjs.com/)). A free public PeerJS server only helps browsers find each other.
- **Where things are stored:** messages, friends and pictures are saved on your own devices, in the browser's storage. There's no central database.
- **Names are accounts:** anyone who has the password can type any name and use that profile, including its private chats. The owner's admin name is the exception, because it needs the owner's secret code. Only share the password with people you trust.

## Known limits

- Very strict networks, like some school, office or hotel Wi-Fi, can block direct connections between browsers.
- Private messages only travel while both people are online, or while another of the friend's devices is online.
- The free PeerJS server is shared with other apps and has no uptime guarantee.

## Tech

One file, `index.html`: plain HTML, CSS and JavaScript with no build step, hosted on GitHub Pages. WebRTC goes through PeerJS 1.5.4. The noise filter runs in an AudioWorklet. Everything is saved in localStorage.

To run your own copy, fork the repository and turn on GitHub Pages. You also need your own password check and owner key: replace the `GATE` and `FB_OWNER` values in `index.html`.
