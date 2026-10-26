/* "New in Party Line": after an update, a short list of what's new, so friends actually find the new things.
   Add a new entry at the top with the next id; everyone sees it once (the server remembers, so not again on
   their other devices). New accounts skip notes from before they joined. */
export const NEWS = [
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
  return NEWS.filter((n) => n.id > seen).flatMap((n) => n.items).slice(0, 8);
}
