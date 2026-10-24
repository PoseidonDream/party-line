/* "Playing …": every 30 s, look at the running programs for well-known games and tell the page which one is
   on. Only the game's name is shared, never the list of programs. Turn it off in the tray menu. */
const { execFile } = require('node:child_process');

// Program name (lowercase, without .exe) -> what friends see.
const GAMES = {
  'valorant-win64-shipping': 'VALORANT', cs2: 'Counter-Strike 2', csgo: 'Counter-Strike: Global Offensive',
  'league of legends': 'League of Legends', 'fortniteclient-win64-shipping': 'Fortnite', r5apex: 'Apex Legends', r5apex_dx12: 'Apex Legends',
  overwatch: 'Overwatch 2', 'minecraft.windows': 'Minecraft', minecraftlauncher: 'Minecraft', gta5: 'Grand Theft Auto V', gta5_enhanced: 'Grand Theft Auto V',
  playgtav: 'Grand Theft Auto V', robloxplayerbeta: 'Roblox', rocketleague: 'Rocket League', dota2: 'Dota 2', eldenring: 'ELDEN RING',
  rainbowsix: 'Rainbow Six Siege', rainbowsix_vulkan: 'Rainbow Six Siege', 'tslgame': 'PUBG: BATTLEGROUNDS', destiny2: 'Destiny 2',
  witcher3: 'The Witcher 3', cyberpunk2077: 'Cyberpunk 2077', fc25: 'EA SPORTS FC 25', fc26: 'EA SPORTS FC 26', 'among us': 'Among Us',
  terraria: 'Terraria', 'stardew valley': 'Stardew Valley', hollow_knight: 'Hollow Knight', helldivers2: 'HELLDIVERS 2',
  'deadbydaylight-win64-shipping': 'Dead by Daylight', 'warframe.x64': 'Warframe', 'palworld-win64-shipping': 'Palworld',
  escapefromtarkov: 'Escape from Tarkov', rustclient: 'Rust', arma3_x64: 'Arma 3', bg3: "Baldur's Gate 3", bg3_dx11: "Baldur's Gate 3",
  ts4_x64: 'The Sims 4', valheim: 'Valheim', 'lethal company': 'Lethal Company', phasmophobia: 'Phasmophobia', geometrydash: 'Geometry Dash',
  'osu!': 'osu!', genshinimpact: 'Genshin Impact', starrail: 'Honkai: Star Rail', zenlesszonezero: 'Zenless Zone Zero',
  'marvel-win64-shipping': 'Marvel Rivals', 'thefinals': 'THE FINALS', 'deltaforce-win64-shipping': 'Delta Force',
  'cod': 'Call of Duty', 'cod24-cod': 'Call of Duty', 'blackops6': 'Call of Duty: Black Ops 6', 'forzahorizon5': 'Forza Horizon 5',
  'seaofthieves': 'Sea of Thieves', 'factorio': 'Factorio', 'satisfactory': 'Satisfactory', 'subnautica': 'Subnautica',
  'hearthstone': 'Hearthstone', 'wow': 'World of Warcraft', 'diablo iv': 'Diablo IV', 'pathofexile': 'Path of Exile', 'pathofexile2': 'Path of Exile 2',
  'battlefield6': 'Battlefield 6', 'bf2042': 'Battlefield 2042', 'schedule i': 'Schedule I',
};

function running() {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    if (process.platform === 'win32') execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 4 << 20 }, (e, out) => done(e, String(out || '').split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '')).join('\n')));
    else execFile('ps', ['-A', '-o', 'comm='], { maxBuffer: 4 << 20 }, done);
  });
}
async function currentGame() {
  for (const p of await running()) {
    const name = p.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (Object.hasOwn(GAMES, name)) return GAMES[name];
  }
  return null;
}

/* Calls onChange(name or null) whenever the game changes. Returns a function that stops it. */
function watchGames(onChange, enabled) {
  let last = null, timer = null;
  const tick = async () => {
    const g = enabled() ? await currentGame().catch(() => null) : null;
    if (g !== last) { last = g; onChange(g); }
  };
  tick();
  timer = setInterval(tick, 30_000);
  return { stop: () => clearInterval(timer), now: () => last, refresh: tick };
}
module.exports = { watchGames, GAMES };
