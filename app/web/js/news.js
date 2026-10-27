/* "New in Party Line": after an update, a short list of what's new, so friends actually find the new things.
   Add a new entry at the top with the next id; everyone sees it once (the server remembers, so not again on
   their other devices). New accounts skip notes from before they joined. */
export const NEWS = [
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
