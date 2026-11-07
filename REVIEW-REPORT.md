# Party Line: full code review report

Started 7 November 2026. Nothing was changed in the code during this review (the Android app is in Google Play review,
and any change to it would upload a new version). Each finding says what's wrong, what could happen, and the fix.
When you're ready, say **"fix the review report"** and I'll fix them.

Severity: 🔴 important · 🟠 worth fixing · 🟡 small

## Progress
- [x] Server: index.js (web routes, uploads, downloads)
- [x] Server: model.js (accounts, messages, permissions)
- [x] Server: hub.js (live connection, voice, all actions)
- [x] Server: other files (bot, push, Firebase, previews, GIFs, usage, database)
- [x] Web app: safety (how messages, links, previews and videos are shown), sign-in, notifications, updates
- [x] Desktop app (Electron)
- [x] Android app (Java)
- [x] Server setup scripts (deploy/)

## Findings

### 🔴 1. Admin rights follow the account *name*, so someone else can take them
**Where:** `app/server/src/model.js` (`register`, `rename`, `syncAdmins`) and `config.js` (`ADMIN_NAMES`, default "Poseidon").
**What's wrong:** an account is an admin because its name is "Poseidon", not because it's *your* account.
- Making an account called "Poseidon" makes it an admin on the spot.
- At every server start (that's after every automatic update), every account named "Poseidon" becomes an admin and
  every account with another name loses admin.
**What could happen:** if you ever change your name in Settings (or delete your account), the name "Poseidon" is free.
Anyone can then sign up as "Poseidon" and is an admin immediately: they can read reports, reset passwords, kick
people, download a full backup of every message. And at the next update you lose admin yourself.
**Fix:** remember admins by account number, not by name: the name only counts the very first time (when the
account is made, if no admin exists yet), and renaming never adds or removes admin. Also stop renaming to an admin name.

### 🔴 2. Under-18s can see what's posted in 18+ channels, in three ways
**Where:** `app/server/src/hub.js` (`hallOfFame`, `canSee`), `bot.js` (message reminders), `model.js` (`bookmarksOf`).
**What's wrong:** 18+ channels are hidden from people who haven't confirmed they're adults, but three side doors skip
that check:
- **Hall of fame:** a message in an 18+ channel that gets 3 ⭐ is copied by Party Bot, pictures included, into
  #hall-of-fame, which everyone in the server can read, under-18s included.
- **"Remind me about this":** checks only that you're in the server. Party Bot then sends you a private quote of the
  message. Message numbers simply count up, so someone can ask for reminders on numbers they guess and read 18+ messages.
- **Bookmarks:** same thing. Bookmarking a message number and opening your saved messages shows the full message.
- **Screen-share previews:** while someone shares their screen in an 18+ *voice* channel, the little live snapshot
  ("peek before joining") is sent to everyone in the server, under-18s included.
- **Clip it:** a clip recorded from a screen share in an 18+ voice channel is posted in the server's clips channel,
  which isn't 18+.
- **Phone and browser notifications:** an @mention (or "all messages" setting) in an 18+ channel sends a notification
  with the message text to every member, under-18s included (the app itself hides it, the notification doesn't).
- (Smaller: poll results from an 18+ channel, and who's sitting in an 18+ voice channel, are sent to every member.)
**What could happen:** a 13-year-old in your server sees adult pictures, which is exactly what you promised Google
Play wouldn't happen.
**Fix:** one shared "can this person see this message" check that includes the 18+ rule, used everywhere (reactions,
votes, pins, bookmarks, reminders, group posts); the hall of fame skips 18+ channels; screen previews, clips, poll
updates and 18+ voice channel lists only go to people who may open that channel.

### 🟠 3. A moderator with "Remove members" can remove the server's owner (and admins)
**Where:** `hub.js` → `admin.kick` (also `admin.voiceKick` and `admin.mute`).
**What's wrong:** the only check is "not yourself". A member given the Remove members role can kick the owner of the
server, or you as admin, out of the server, and disconnect or mute them in voice.
**Fix:** nobody can remove, disconnect or mute the server's owner or a global admin, except the owner/admins themselves.

### 🟠 4. Anyone in a server can create channels (up to 60), without permission
**Where:** `hub.js` → `chan.create`.
**What's wrong:** deleting, renaming and moving channels needs the Manage channels permission, but creating one only
needs being a member. It also works inside group chats and 1-on-1 call rooms (which aren't meant to have channels).
**What could happen:** a troll (or a mistake) fills the channel list with 60 channels that only a moderator can delete.
**Fix:** creating a channel needs Manage channels (owners and admins always can), and only in normal servers.
(If you *want* everyone to make channels, say so and I'll keep it, but block it in group chats and calls.)

### 🟠 5. Blocking someone doesn't stop group chats or calls from them
**Where:** `model.js` → `createGroup`; `hub.js` → `group.add`, `voice.join`.
**What's wrong:** private messages and *starting* a call check blocking, but:
- making a group chat or adding people to one doesn't: someone you blocked can start a group with you in it, and Party
  Bot announces it, again and again;
- if you two ever called before, the 1-on-1 call room still exists, and they can join it directly: your phone rings and
  you get a "📞 … is calling" notification, even though you blocked them.
**Fix:** leave out people who blocked you (or you blocked) when making or adding to a group, and check blocking when
joining a 1-on-1 call room (no ringing either).

### 🟠 6. Resetting the password by email skips 2-step sign-in
**Where:** `model.js` → `finishEmailReset`.
**What's wrong:** with 2-step sign-in on, signing in needs the password *and* the 6-digit code. But "forgot password →
code by email" signs you straight in with a new password, without asking for the 6-digit code.
**What could happen:** someone who gets into a person's email account can take over their Party Line account, even though
they turned on 2-step sign-in to prevent exactly that.
**Fix:** when 2-step sign-in is on, the email reset also asks for the 6-digit code (or turns into an admin-approved reset).

### 🟡 7. Adding a recovery email doesn't ask for the password
**Where:** `hub.js` → `email.start` / `email.confirm`.
**What could happen:** someone who picks up your unlocked phone or computer can add *their* email to your account, then
later use "forgot password" to take it over, even after you change your password.
**Fix:** ask for the password before adding or changing the email, and email the old address when it changes.

### 🟡 8. "Forgot password by email" tells strangers which accounts have an email
**Where:** `index.js` → `/api/reset-email` and `model.js` → `startEmailReset`.
**What's wrong:** it's meant to answer the same either way. But asking twice within a minute answers "A code was just
sent, wait a minute" only for accounts that have an email, and "OK" for the others.
**Fix:** answer the same "OK" in that case too (and quietly skip sending).

### 🟡 9. Any member can pin and unpin any message
**Where:** `hub.js` → `msg.pin`.
**What's wrong:** pinning needs no permission, so anyone can unpin the rules or announcements a moderator pinned
(Party Bot even announces each pin). In most chat apps this needs the moderator permission.
**Fix:** in servers, pinning needs Manage messages (in private chats and group chats, anyone can still pin). Your choice.

### 🟡 10. Giving someone "Manage server" quietly gives them every other power too
**Where:** `hub.js` → `role.create`, `role.edit`, `role.assign`.
**What's wrong:** a member with Manage server can make a role with every permission (Remove members, Moderate voice…)
and give it to themselves. Not a bug as such, but worth knowing before you hand that permission out.
**Fix (optional):** people can only hand out permissions they already have.

### 🟡 11. Server mute is a request, not a lock
**Where:** `hub.js` → `admin.mute` (and the voice server pass in `index.js`).
**What's wrong:** "Mute for everyone" tells the person's app to mute. A modified app could ignore it. With the media
server on, its pass could be issued without the right to speak while muted.
**Fix (optional):** with the media server, take away the speaking right on the server side when someone is muted.

### 🟡 12. Link previews have no overall time limit
**Where:** `app/server/src/preview.js` → `get()`.
**What's wrong:** a page fetch gives up only after 6 seconds of *silence*. A site that sends one byte every few
seconds keeps the connection open forever, and a page bigger than the limit is cut off without ever finishing, so
its preview (or the picture behind it) just hangs.
**What could happen:** someone posting many links to such a site can pile up open connections on your server.
**Fix:** an overall 10-second deadline for each fetch, and finish cleanly when a page is too big.

### 🟡 13. A few things grow forever or get slow as the server gets older
**Where:** `preview.js` (`link_previews` table), `model.js` → `userDirectory`, `db.js`.
- Every link ever previewed stays in the database (it's never cleaned up).
- The developer panel's people list counts each person's messages one by one with no index, so with lots of messages
  opening the panel can freeze the server for a moment for everyone.
**Fix:** delete previews older than a week in the hourly cleanup; add an index on who wrote each message.

### 🟡 14. `/remind` still posts in a chat you were removed from
**Where:** `bot.js` → `fireReminders`.
**What's wrong:** a reminder set with `/remind 2d …` is posted in that channel later even if you left or were kicked
from the server in between (it also @mentions anyone named in the text).
**Fix:** check you're still in that chat when it's due; otherwise send it to you privately.

### 🟡 15. Small server crash-proofing
**Where:** `index.js` → `/api/push/unsubscribe`.
**What's wrong:** it reads `req.body.endpoint` without checking a body was sent; a request without one gets a
"something went wrong" error instead of a clean answer (harmless, but it fills the log).
**Fix:** `(req.body || {}).endpoint`, like the other routes.

### 🟠 16. Restoring a backup can wipe everything, and breaks browser notifications
**Where:** `deploy/backup.sh restore`; also what the backups contain (`backup.sh` and the in-app "Download a backup").
**What's wrong:**
- Restore deletes everything on the server *first* and only then unpacks the backup. If the backup file is damaged
  or cut off, you're left with nothing.
- Backups contain the database and the uploads, but not the server's notification key (`vapid.json`) or its link-preview
  key. After a restore (or moving to a new server) a new notification key is made, and every browser that had
  notifications on silently stops getting them, because their phone or browser keeps using the old key.
**Fix:** unpack and check the backup in a separate folder before swapping it in; include `vapid.json` and
`preview-key` in every backup.

### 🟠 17. Mac desktop app can't update itself, and never says so
**Where:** `app/desktop/src/main.js` → `setupUpdates`; `.github/workflows/desktop.yml` (no Apple signing).
**What's wrong:** macOS only lets an app update itself if it's signed by Apple (the $99/year developer account). Your Mac
app isn't, so the automatic update fails quietly: Mac users stay on the version they installed forever and never see
the "new version" card. (Windows and Linux update fine.) This is what you ran into on your MacBook.
**Fix:** on Mac, compare the app's version with the newest release and show a "New version: download" card that opens
the download page, until the app is Apple-signed.

### 🟠 18. Android phones with the downloaded APK stop hearing about updates after every desktop release
**Where:** `app/web/js/main.js` → `checkAppUpdate`.
**What's wrong:** the update check only looks at the *newest* GitHub release. Right now that's the desktop release
1.3.1, which has no Android file, so APK users never get the "new version" card (Play Store users aren't affected).
**Fix:** look through the last few releases, like the welcome page's download button already does.

### 🟠 19. An email password with spaces would break the nightly off-server backup
**Where:** `deploy/backup.sh` (it reads `deploy/.env` as a shell script); `deploy/.env.example` shows `SMTP_PASS=abcd efgh ijkl mnop`.
**What's wrong:** Gmail app passwords come with spaces. Docker reads such a line fine, but the backup script stops with
an error on it, after saving the local backup but before copying it off the server and before recording that it ran.
Party Bot would then warn that backups aren't running, and the off-server copies would stop.
**Fix:** read only the backup settings from `.env` (not run it as a script), and show the example without spaces.

### 🟡 20. The desktop app lets the Party Line page change which server the app trusts
**Where:** `app/desktop/src/preload.js` (`saveServer`) and `main.js` (`setup:save`).
**What's wrong:** "change server" is meant for the app's own setup page, but the bridge offers it to the Party Line page
too. Only matters if someone ever managed to run code inside your page (nothing found that allows that), but then they
could point the app at their own copy, which would get the microphone, screen sharing and backup permissions.
**Fix:** accept "change server" only from the app's own setup and offline pages.

### 🟡 21. Updates install from GitHub automatically
**Where:** `deploy/auto-update.sh`.
**What's wrong:** not a bug, but worth knowing: whatever is pushed to the `app` branch is running on your server within
10 minutes. So your GitHub account is effectively the key to the server.
**Fix (you):** keep 2-step sign-in on for GitHub, and don't give anyone else write access to the repository.

### 🟡 22. The "back up to this computer" copy may end up in the cloud, and can get heavy
**Where:** `app/desktop/src/backup.js` (Documents → Party Line backups).
**What's wrong:** on many Windows PCs the Documents folder is synced to OneDrive (and on Macs, often to iCloud), so the
backup, which holds everyone's private messages, gets uploaded to that cloud too. Also, it's a *full* backup at most
once an hour: when your server has gigabytes of photos and videos, that's a lot of downloading each time you open the app.
**Fix:** let you pick the folder (default outside synced folders), and do it at most once a day.

### 🟠 23. The number of a deleted message (or account) can be given to the next one
**Where:** `app/server/src/db.js` (the `users` and `messages` tables).
**What's wrong:** every message and account has a number. When the *newest* message (or account) is deleted, the
database gives that same number to the next new one. A few things still point at the old number:
- **"Remind me about this":** set a reminder on a message, the message gets deleted (or disappears), and the next
  message sent anywhere on the server, which could be someone else's private chat, gets its number. When the
  reminder fires, Party Bot quotes *that* message to you.
- **Accounts:** if the newest account is deleted, the next sign-up gets its number and inherits old leftovers: old
  @mentions of the deleted person now show the new person's name, old poll and game votes count as theirs, and the
  admin log shows the deleted person's actions under the new name.
**Fix:** never reuse numbers for messages and accounts, and delete reminders (and poll/game votes) together with the
message or account they belong to.

### 🟡 24. One person can flood everyone with screen-share previews
**Where:** `hub.js` → `voice.preview`.
**What's wrong:** each preview (up to 120 KB) is sent to everyone in the server, and there's no limit on how often,
apart from the general 60-requests-a-second cap. A modified app could push megabytes a second to every member.
**Fix:** accept at most one preview every few seconds per person.

### 🟡 25. A server's owner can leave it, leaving nobody in charge
**Where:** `hub.js` → `server.leave`.
**What's wrong:** the owner can simply leave their own server. It stays "owned" by someone who isn't in it any more, so
nobody inside can manage it (only you as global admin).
**Fix:** ask the owner to hand the server to someone else first (or pass it to the longest member automatically, like
account deletion already does).

## Checked and fine

So you know what was looked at and didn't need anything:
- **Code can't be slipped into the app:** messages, names, profiles, link previews and bot answers are always shown
  as plain text; links only open http/https pages; uploads are served so they can never run as a web page.
- **Passwords and sign-ins:** strong password storage, wrong-guess limits per account and per address, sign-ins
  stored only as fingerprints, 2-step codes can't be reused, signing out ends notifications too.
- **Link previews can't be used to reach your server's private network** (checked again after redirects), and the
  picture pass-through only fetches pictures the server itself chose.
- **Private chats stay private:** search, saved messages, media, pins and history all check that you're in the chat.
- **Desktop app:** only your server gets the microphone, camera and screen sharing; other sites open in your browser;
  the new backup feature only accepts your server's own one-time backup links.
- **Android app:** no advertising ID, backups of app data turned off, notification taps only open chat links.
- **Server setup:** secrets are private to the server, the app's port isn't open to the internet (only through
  Caddy), the voice relay refuses private addresses, and updates wait while people are in voice.

## What I'd fix first
1. **#2 18+ content reaching under-18s**: it matters for Google Play's child-safety rules you just agreed to.
2. **#1 Admin by name**: one rename away from someone else becoming admin.
3. **#23 Reused message numbers**: can show someone else's private message in a reminder.
4. **#3, #5, #6**: moderators removing the owner, blocking side doors, 2-step sign-in skipped by email reset.
5. **#16, #17, #18**: restore safety, and making sure Mac and APK users hear about updates.
6. The rest when convenient.

Most of these are small changes. The fixes to the server and the web app go live by themselves. #17 and #20 need a
new desktop version, and nothing here needs a new Android version.
