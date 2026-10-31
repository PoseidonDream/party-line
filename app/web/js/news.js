/* "New in Party Line": after an update, a short list of what's new, so friends actually find the new things.
   Add a new entry at the top with the next id; everyone sees it once (the server remembers, so not again on
   their other devices). New accounts skip notes from before they joined. */
export const NEWS = [
  { id: 12, items: [
    ['📧', 'Add your email (optional)', 'Settings → Account → Email. Confirm it with a code, and if you ever forget your password, “Forgot your password?” can email you a code instead of waiting for an admin.'],
    ['🔞', '18+ channels', 'Admins can mark a channel 18+ in its settings. To open one, confirm your age in Settings → Account → Age. Nobody sees your birth date.'],
    ['✉️', 'Invite only', 'New accounts no longer land in the server by themselves. Bring friends in with the server’s invite link (server menu → Copy invite link).'],
  ] },
  { id: 11, items: [
    ['🌍', 'Languages', 'Party Line now speaks English, Deutsch, Español, Français, Italiano, Русский and Türkçe. Change it any time in Settings → Look → Language (or on the sign-in screen). What people write stays as they wrote it.'],
    ['🛡️', 'Block and report', 'Click someone’s name to block them: you won’t see their messages and they can’t reach you. Point at a message and press the 🚩 to report it to the admins.'],
    ['🗑️', 'Delete your account', 'Settings → Account → Delete my account removes your account and everything that’s yours. There’s also a page for it: /delete-account.'],
  ] },
  { id: 10, items: [
    ['🐢', 'Slow-mo voice', 'A new voice effect: press ✨ in voice → Slow-mo. Friends hear you deep and slowed down, like a slowed-down video.'],
    ['📺', 'One click to watch', 'Click a voice channel that says LIVE and the stream opens. Already in the call? Click the bubble of whoever is live.'],
  ] },
  { id: 9, items: [
    ['📺', 'Easier to watch screens', 'Click a voice channel that says LIVE and the stream opens. Already in the call? Click the bubble of whoever is live.'],
    ['🔊', 'Add your own sounds', 'Everyone can add up to 10 sounds: Soundboard → Add a sound. Any audio or video file works: pick the 7 seconds you want and preview it.'],
  ] },
  { id: 8, items: [
    ['😂', 'Meme soundboard', 'The soundboard now has meme sounds: Vine boom, Metal pipe, MLG airhorn, Dun dun dunnn, Crickets, Bonk, Record scratch and more.'],
    ['✨', '9 new voice effects', 'Press ✨ in voice: Alien, Demon, Underwater, 8-bit, Wobbly, Ghost, Choir, Stadium and Glitchy.'],
  ] },
  { id: 7, items: [
    ['🏠', 'Home dashboard', 'The Home button shows who’s in voice, who’s playing what, open groups and what’s coming up.'],
    ['🔥', 'Streaks & achievements', 'Chat or join voice every day for a 🔥 streak, and collect 15 achievements. Home → Leaderboard → Achievements.'],
    ['🎨', 'Level rewards', 'Level 5 unlocks name colors, level 10 the Galaxy ring and Matrix banner, level 15 the Plasma ring, level 20 a shimmering name.'],
    ['⭐', 'Hall of fame', 'Three ⭐ on a message puts it in #hall-of-fame forever.'],
    ['🎮', 'Looking for group', 'Press + → Looking for group (or /lfg Valorant 2). Friends who list that game get pinged.'],
    ['✏️', 'Draw on screen shares', 'Watching someone’s screen? Press Draw to point at things. In the desktop app it shows on their real screen too.'],
    ['🎬', 'Clip it & pop out', 'Watching a screen? Press 🎬 once to switch on Clip it, then again to save the last 30 seconds to #clips-and-highlights. Pop out keeps it in a small window.'],
    ['⌨️', 'Soundboard keys', 'Soundboard → Keys gives sounds their own shortcuts. In the desktop app they work even in a game.'],
  ] },
  { id: 6, items: [
    ['📊', 'Better polls', 'Press + next to the message box → Poll. Pick several, keep it anonymous, set an end time, and watch the votes come in live.'],
    ['🏅', 'Levels', 'Chatting and hanging out in voice anywhere in Party Line earn XP. Click someone to see their level, or Home → Leaderboard (/rank, /top).'],
    ['💬', 'Chat in voice channels', 'Every voice channel has its own chat for links and invites during a call: the Chat button at the top.'],
    ['✨', 'Voice effects', 'In voice, press ✨: Robot, Deep, Chipmunk, Cave echo or Radio. Turn on “Hear myself” to try them.'],
    ['⏰', 'Remind me about this', 'The clock on any message: Party Bot reminds you about it later, privately.'],
    ['⏳', 'Disappearing messages', 'The ⏳ button in a private or group chat: new messages delete themselves after 24 hours or 7 days.'],
  ] },
  { id: 5, items: [
    ['🖼️', 'Media gallery', 'The picture button at the top of a chat shows every photo, video and file shared there.'],
    ['🎬', 'Watch parties', '/watch and a YouTube link plays it on the big screen for everyone in your voice channel.'],
    ['📅', 'Game night planner', 'In the 🎮 list, press “Plan game night”: friends RSVP and a game vote opens before it starts.'],
    ['✨', 'Profile flair', 'Settings → Profile: a ring around your picture, a banner effect and your favorite games.'],
    ['⚡', 'Jump anywhere', 'Press Ctrl+P and type a few letters to jump to any channel or friend.'],
    ['🔖', 'Saved messages', 'Press the bookmark on any message; find them all under Home → Saved messages.'],
    ['🕒', 'Send later', 'The clock next to the message box sends your message at the time you pick.'],
  ] },
  { id: 4, items: [
    ['⚙️', 'Tidier Settings', 'Settings is now split into Profile, Look, Voice, Alerts and Account.'],
    ['👆', 'Cleaner chat on phones', 'Tap a message to react, reply or pin it.'],
  ] },
  { id: 3, items: [
    ['🗳️', 'Vote tonight’s game', 'In the 🎮 list, press “Vote tonight’s game” (or type /vote). Everyone votes with reactions and Party Bot announces the winner.'],
    ['🎨', 'Accent colors', 'Settings → Appearance: amber, cyan, violet, green, pink or white glow.'],
    ['🔊', 'Voice channel status', 'In a voice channel, set a line like “ranked Valorant 🔥” that everyone sees under the channel.'],
    ['🔎', 'GIF search', 'The 🙂 button → GIFs: search any GIF (when the server has GIF search switched on).'],
  ] },
  { id: 2, items: [
    ['🖤', 'A new, black look', 'Darker and simpler. Prefer the old light look? Settings → Light.'],
    ['🎮', 'Games to play', 'Every chat has a 🎮 list of games to try. Vote 👍, tick off what you’ve played, and press 🎲 to let Party Bot pick one. Or type /game and a name.'],
    ['😀', 'Your own emoji and stickers', 'Server menu → Emoji & stickers. Then type :name: or use the 🙂 button, which also has your saved GIFs.'],
    ['💤', 'AFK channel', 'Quiet in voice for a long time? You’re moved to the server’s AFK channel instead of being disconnected (if the server has one).'],
    ['📺', 'Peek at screen shares', 'Point at a LIVE badge to see a preview of someone’s screen before you join.'],
    ['🔐', 'Devices & 2-step sign-in', 'Settings shows where you’re signed in, and you can turn on a code from an authenticator app.'],
  ] },
  { id: 1, items: [
    ['🎬', 'Watch together', 'In a voice channel, press Watch together under a video in the chat. It plays for everyone at the same moment.'],
    ['🔔', 'Notifications when Party Line is closed', 'Settings → Even when Party Line is closed (website and iPhone Home Screen app).'],
    ['🎂', 'Birthdays', 'Add yours in Settings. Friends see a 🎂 on the day, and Party Bot says happy birthday.'],
    ['✨', 'Bold, spoilers and more', '**bold**, *italic*, __underline__, ~~strike~~, `code`, > quotes and ||spoilers||.'],
    ['👀', 'Seen', 'Private chats show “Seen” when your friend has read your message.'],
    ['🔎', 'Smarter search', 'Try from:Bora, in:#general or has:file.'],
    ['🎮', 'Desktop app', 'Ctrl+Shift+M mutes and Ctrl+Shift+D deafens from any game, and an overlay shows who’s talking.'],
  ] },
];
export const latestNews = () => NEWS[0].id;

/* seen: the newest id this person has seen. Returns the items to show (newest first), or []. */
export function unseenNews(seen) {
  if (seen < 0) return [];
  return NEWS.filter((n) => n.id > seen).flatMap((n) => n.items).slice(0, 14);
}
