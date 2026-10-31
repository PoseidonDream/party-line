/* New accounts start in no server (the way the real server runs): friends bring them in with an invite link, so
   strangers and Google's test robots who find the address don't land in the group. Admins still join by themselves. */
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ AUTO_JOIN: '' });
  const browser = await launchBrowser();
  try {
    const admin = await signUp(browser, srv.url, 'Poseidon');
    ok('the admin lands in the main server', await admin.isVisible('#voiceList .chan:has-text("Lobby")'));

    const stranger = await signUp(browser, srv.url, 'ExplorerUser');
    const db = openDb(srv);
    const servers = db.prepare("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id JOIN servers s ON s.id = m.server_id WHERE u.name = 'ExplorerUser' AND s.kind = 'server'").get().n;
    const invite = db.prepare('SELECT invite FROM servers WHERE is_default = 1').get().invite;
    db.close();
    ok('a new account joins no server by itself', servers === 0);
    ok('…and starts on Friends, where they can add someone', await stranger.isHidden('#voiceList .chan:has-text("Lobby")'));

    const friend = await browser.newPage();
    await friend.goto(`${srv.url}/invite/${invite}`);
    await friend.click('#tabRegister'); await friend.fill('#authName', 'Deniz'); await friend.fill('#authPass', 'pass1234');
    await friend.check('#authAgree'); await friend.click('#authBtn');
    await friend.waitForSelector('#voiceList .chan:has-text("Lobby")', { timeout: 10000 });
    ok('someone who opens an invite link and makes an account is in the server', true);
    const errs = [...admin.errors, ...stranger.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
