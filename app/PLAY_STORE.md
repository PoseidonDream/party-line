# Putting Party Line on Google Play

The app already does what Google Play asks of an app where people talk to each other:

- It's built for Android 16 (API 36), in the format Play takes (an `.aab` "app bundle").
- People agree to the **community rules** and the **privacy policy** when they make an account.
- Anyone can **block** someone (click their name → Block) and **report** a message or a person (point at a message → 🚩, or click a name → Report). Reports go to the admins in Party Bot's private chat and in the Developer panel → Reports.
- Anyone can **delete their account**: in the app (Settings → Account → Delete my account) and on a web page (`/delete-account`).
- The app speaks 7 languages, so the store listing can too.
- The Play version never offers its own updates: Play updates it.

What's left is paperwork in the Play Console. This page walks through it.

## Which way: friends only, or the public store?

| | Internal testing | Public (production) |
|---|---|---|
| Who can install | Up to 100 people you add by their Google email | Anyone who finds it |
| Google's review | Hardly any; ready in minutes | Full review, a few days |
| Extra steps | None | A new personal account first has to run a **closed test with at least 12 testers for 14 days in a row** |

For a friend group, **internal testing is enough**: friends get Party Line from the Play Store, with automatic updates, and nobody has to allow "unknown apps". You can still go public later.

## 1. Before you start (once)

1. **A Google Play developer account**: [play.google.com/console](https://play.google.com/console), $25 once. Google checks your ID, which can take a few days.
2. **A signing key** and the 4 GitHub secrets, as in [SIGNING.md](SIGNING.md) → "Sign it". Without them, GitHub only makes test builds that Play refuses. Keep the key file safe: every future update must be signed with it.
3. **The variable `PARTY_LINE_SERVER`** in GitHub (Settings → Secrets and variables → Actions → Variables), e.g. `https://poseidonparty.duckdns.org`.
4. **A contact email on your server**: in `deploy/.env` add `CONTACT_EMAIL=you@example.com`, then restart (`docker compose up -d`). It shows on the privacy policy, the rules and the delete-account page. Google asks for one too.

## 2. Make the build

GitHub → **Actions → Android app → Run workflow**. After about 5 minutes the finished run has a download called **party-line-google-play** with the `.aab` inside. (Each run gets a higher version number automatically, which Play needs for updates.)

## 3. Create the app in the Play Console

**Create app** → name `Party Line`, app (not game), free. Then go through **Dashboard → Set up your app**, one card at a time:

| Card | What to enter |
|---|---|
| Privacy policy | `https://poseidonparty.duckdns.org/privacy` |
| App access (now called "Sign-in details") | "Does your app have restricted parts?" **Yes**, "All or some functionality is restricted". Make an account for Google's reviewers first: open the website in a private window (Safari or Chrome: Shift+Cmd+N), Create account, name `PlayReview`, a password of at least 8 characters. Give them that name and password, and write: *"Sign in with the name and password above. Voice: open the Lobby voice channel. Report a message: tap it, then press the flag. Block or report a person: tap their name, then Block or Report."* |
| Ads | No ads |
| Content rating | Fill in the questionnaire honestly: a communication app, people can talk and share photos with each other, no gambling, no purchases. Can people block others or what they post? **Yes.** Report them? **Yes.** Is chat moderated? **No** (admins act on reports, nobody reads chats in advance). Can interactions be limited to invited friends only? **No** (new accounts join your main server). Digital purchases? **No.** |
| Target audience | 13 and older (leave out the under-13 groups). "Appeals to children": No. |
| News app | No |
| Data safety | See [below](#data-safety-answers) |
| Government app / Financial features / Health | No / None / None |
| Account deletion | `https://poseidonparty.duckdns.org/delete-account` |
| Foreground service permissions | See [below](#the-microphone-in-the-background) |

## 4. The store listing

**Grow → Store presence → Main store listing.** Everything is in [`mobile/store/`](mobile/store):

- **App icon** (512×512): `web/icon-512.png`
- **Feature graphic** (1024×500): `mobile/store/feature-graphic.png`
- **Phone screenshots**: `mobile/store/screenshots-en/` (and `screenshots-tr/` for the Turkish listing)
- **Texts**: [below](#store-texts). Add Turkish (or more) under "Manage translations".

To remake the pictures after the app changes: `cd app/tests && node ../mobile/store/make-pictures.mjs` (it uses a throwaway test server, so no real chats show).

## 5. Upload

- **Friends only**: Testing → **Internal testing** → Create new release → upload the `.aab` → Save → Review → **Start rollout**. Then **Testers** → make a list with your friends' Google emails → copy the **join link** and send it to them. They open it on their phone, accept, and install from Play.
- **Public**: first do the same under **Closed testing** with at least 12 people, and keep it running for 14 days. Then Dashboard → **Apply for production**.

The first time, Play asks to manage your signing key (**Play App Signing**): accept. The key from SIGNING.md becomes your "upload key".

For updates: run the workflow again and upload the new `.aab` the same way, or let GitHub do it (below).

## Automatic uploads (set up once)

**Most updates never need a new Play release.** The Android app shows your server's website, and the server updates itself, so new features and fixes reach phones right away. A new `.aab` is only needed when the Android part itself changes (`app/mobile`), which is rare.

For those, GitHub can send each new build to **internal testing** by itself, and friends' phones update from the Play Store. Google only allows this after the **first** upload was done by hand (step 5 above). Then:

1. **A Google Cloud project:** at [console.cloud.google.com](https://console.cloud.google.com), sign in with the same Google account → project menu (top left) → **New project**, name it `party-line-play` → **Create**.
2. **Turn on the Play API:** search the top bar for **Google Play Android Developer API** → **Enable**.
3. **A robot account for GitHub:** menu → **IAM & Admin → Service accounts → Create service account**, name it `github-upload` → **Create and continue** → skip the roles → **Done**. Click the new account → **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads. Keep it private: it can upload versions of your app.
4. **Let it upload to Party Line:** copy the robot account's email (ends in `iam.gserviceaccount.com`). In the [Play Console](https://play.google.com/console) → **Users and permissions → Invite new users** → paste the email → **App permissions → Add app → Party Line** → tick **Release apps to testing tracks** → **Apply → Invite user**.
5. **Give the key to GitHub,** in Terminal (change the file name to yours):
   ```
   gh secret set PLAY_SERVICE_ACCOUNT_JSON -R PoseidonDream/party-line < ~/Downloads/party-line-play-1234abcd.json
   ```
   Then delete the `.json` file from Downloads.

From then on, every new Android build goes to internal testing on its own. To make one by hand: GitHub → **Actions → Android app → Run workflow**.

## Data safety answers

Party Line keeps data on **your own server**; it sells nothing and shows no ads. In the Play Console:

- **Does your app collect or share user data?** Yes, it collects. It does not share (the GIF search and Party Bot's `/ask`, if you turned them on, only run through your server as service providers).
- **Is all data encrypted in transit?** Yes (HTTPS).
- **Can people ask for their data to be deleted?** Yes (in the app and at `/delete-account`).
- **Can people ask to delete some data without deleting their account?** No (it's optional and needs a page of its own; people can still delete their own messages in the app).

| Data type | Collected | Why | Optional? |
|---|---|---|---|
| Personal info → Name | Yes (the display name) | App functionality, account management | Required |
| Personal info → User IDs | Yes | App functionality, account management | Required |
| Personal info → Email address | Yes (only if someone adds one, to send codes) | Account management | Optional |
| Personal info → Other info | Yes (birth date, only if someone confirms their age, for 18+ channels) | App functionality | Optional |
| Messages → Other in-app messages | Yes | App functionality | Required to chat |
| Photos and videos → Photos, Videos | Yes (what people post) | App functionality | Optional |
| Audio → Voice or sound recordings | Yes (voice messages, soundboard sounds; live voice isn't recorded) | App functionality | Optional |
| Audio → Other audio files | Yes (shared audio files) | App functionality | Optional |
| Files and docs | Yes (shared files) | App functionality | Optional |
| App activity → App interactions | Yes (which features are used, counted per day, for the weekly report) | Analytics | Required |
| App activity → Other user-generated content | Yes (polls, events, profile "About me") | App functionality | Optional |
| App info and performance → Diagnostics | No | | |
| Device or other IDs | No (the "devices you're signed in on" list is only a label like "Chrome on Windows") | | |
| Location, contacts, calendar, health, financial, web history | No | | |

**Is data processed ephemerally?** No: messages and files are kept until someone deletes them.

## The microphone in the background

Party Line keeps voice running when the phone locks or you switch apps (like a phone call), with an "In voice" notification. Play calls this a **foreground service of type microphone** and asks for:

- **Description**: *"Voice chat with friends keeps running while the screen is off or another app is open, like a phone call. It starts only when the user joins a voice channel and stops when they leave; a notification shows the whole time."*
- **A short video** (YouTube, can be "unlisted"): record the phone's screen while you join a voice channel, show the "In voice" notification, lock the phone or open another app, keep talking, then leave voice and show the notification is gone. 30 seconds is enough.

## Store texts

### English

**App name** (max 30): `Party Line`

**Short description** (max 80):
`Voice, chat and screen sharing for your friend group, on your own server.`

**Full description**:

```
Party Line is a private place for you and your friends: voice channels, text channels, screen sharing, photos and videos, friends and private chats. It runs on your group's own server, so your chats stay yours. No ads.

VOICE
• Hop into a voice channel and talk, with strong background-noise filtering
• Keeps running when your phone is locked, like a call
• Watch a friend's screen share with one tap, draw on it, save clips
• Soundboard with meme sounds, and 15 just-for-fun voice effects

CHAT
• Text channels, private chats and group chats
• Photos, videos, files, voice messages, GIFs, stickers and your own emoji
• Replies, reactions, polls, pins, search, reminders and messages that send later
• Events with RSVP and a game vote for game night

YOUR GROUP
• Levels, streaks and achievements
• Roles and permissions for your servers
• Block and report, and admins who can act on reports
• 7 languages: English, Deutsch, Español, Français, Italiano, Русский, Türkçe

Open the app and make an account with any name and password, then ask your friends to add you.
```

### Türkçe

**Kısa açıklama** (en fazla 80):
`Arkadaş grubun için sesli sohbet, mesajlaşma ve ekran paylaşımı, kendi sunucunda.`

**Tam açıklama**:

```
Party Line, sen ve arkadaşların için özel bir yer: ses kanalları, yazı kanalları, ekran paylaşımı, fotoğraf ve videolar, arkadaşlar ve özel sohbetler. Grubunun kendi sunucusunda çalışır, sohbetlerin sende kalır. Reklam yok.

SES
• Bir ses kanalına gir ve konuş, güçlü arka plan gürültüsü filtresiyle
• Telefon kilitliyken de, bir arama gibi çalışmaya devam eder
• Arkadaşının ekran paylaşımını tek dokunuşla izle, üzerine çiz, klip kaydet
• Mim sesleriyle ses paneli ve eğlence için 15 ses efekti

SOHBET
• Yazı kanalları, özel sohbetler ve grup sohbetleri
• Fotoğraf, video, dosya, sesli mesaj, GIF, çıkartma ve kendi emojilerin
• Yanıtlar, tepkiler, anketler, sabitlemeler, arama, hatırlatıcılar ve sonra gönderilen mesajlar
• Katılım bildirimli etkinlikler ve oyun gecesi için oyun oylaması

GRUBUN
• Seviyeler, seriler ve başarımlar
• Sunucuların için roller ve izinler
• Engelleme ve bildirme, bildirimlerle ilgilenen yöneticiler
• 7 dil: English, Deutsch, Español, Français, Italiano, Русский, Türkçe

Uygulamayı aç, istediğin bir ad ve şifreyle hesap oluştur, sonra arkadaşlarından seni eklemelerini iste.
```

## If Google says no

- **"Minimum functionality" / "just a website"**: reply that the app keeps voice calls running in the background with a foreground service and notification, which a website can't do, and point to the video.
- **"User-generated content"**: point to the rules people agree to at sign-up (`/rules`), Report and Block in the app, and the admins' Reports tab.
- **"Couldn't sign in"**: check the reviewer account still works and that its name and password in App access are right.
