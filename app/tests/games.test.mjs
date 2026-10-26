/* Games to play: each chat keeps its own list of game ideas. Add, vote, tick off, remove, let Party Bot pick,
   and /game from the message box. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    for (const p of [a, b]) await p.click('#textList .chan:has-text("game-night")');

    await a.click('#gamesBtn');
    await a.fill('#gameName', 'Lethal Company'); await a.fill('#gameUrl', 'store.steampowered.com/app/1966720'); await a.fill('#gameNote', '4 players');
    await a.click('#gamesForm button[type=submit]');
    await a.waitForSelector('#gamesList .game:has-text("Lethal Company")');
    await b.waitForSelector('#gamesCount:text-is("1")');
    ok('a game added in a chat shows for everyone there (with a count on 🎮)', true);
    await a.fill('#gameName', 'lethal company'); await a.click('#gamesForm button[type=submit]');
    await a.waitForSelector('.toast:has-text("already on the list")');
    ok('the same game can’t be added twice', true);

    await b.fill('#chatInput', '/game Peak https://store.steampowered.com/app/3527290'); await b.keyboard.press('Enter');
    await b.waitForSelector('#botNote:not([hidden]):has-text("Added **Peak**"), #botNote:not([hidden]):has-text("Added Peak")');
    await a.waitForSelector('#gamesList .game:has-text("Peak") a.game-name[href^="https://store.steampowered.com"]');
    ok('/game Name adds one from the message box', true);

    await b.click('#gamesBtn');
    await b.click('#gamesList .game:has-text("Lethal Company") .game-vote');
    await a.waitForSelector('#gamesList .game:has-text("Lethal Company") .game-vote b:text-is("2")');
    const order = await a.locator('#gamesList .game .game-name').allTextContents();
    ok('votes count for everyone, and the most wanted games go first', order[0] === 'Lethal Company');

    await a.click('#gamesList .game:has-text("Peak") .game-played');
    await b.waitForSelector('#gamesList .game.played:has-text("Peak")');
    await b.waitForSelector('#gamesCount:text-is("1")');
    ok('“Played?” ticks a game off and moves it down', true);

    await a.click('#gamesPick');
    await b.waitForSelector('#messages .msg:has-text("pick a game") :text("Lethal Company")');
    ok('🎲 Pick one: Party Bot picks a game nobody has played yet', true);
    await b.screenshot({ path: `${RESULTS}/games.png` });

    ok('you can only remove games you added', await b.locator('#gamesList .game:has-text("Lethal Company") .game-del').count() === 0);
    await b.click('#gamesList .game:has-text("Peak") .game-del');
    await a.waitForSelector('#gamesList .game:has-text("Peak")', { state: 'detached' });
    await a.click('#textList .chan:has-text("general")');
    ok('each chat has its own list', await a.isHidden('#gamesCount'));

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
