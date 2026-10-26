/* /ask: Party Bot answers with Claude. A local stand-in for the Claude API checks what Party Line sends
   (the model, the chat as context, the question) and answers. */
import http from 'node:http';
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const got = [];
  let reply = (body) => ({ status: 200, json: {
    id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'Boil it for **9 minutes** for a firm yolk.' }], usage: { input_tokens: 10, output_tokens: 10 },
  } });
  const fake = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      got.push({ url: req.url, headers: req.headers, body });
      const r = reply(body);
      setTimeout(() => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }, 300);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  const srv = await startServer({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}`, ASK_DAILY_LIMIT: '50' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };
    await say(b, 'I want soft eggs tomorrow');
    await say(a, '/ask how long should I boil an egg?');
    await b.waitForSelector('#messages .msg:has-text("Poseidon asked: how long should I boil an egg?")');
    ok('the question shows up for everyone right away', true);
    await b.waitForSelector('#messages .msg:has-text("9 minutes")');
    ok('Party Bot’s answer arrives as a reply to it', await b.isVisible('#messages .msg:has-text("9 minutes") b:text-is("9 minutes")')
      && await b.isVisible('#messages .msg:has-text("9 minutes") .reply-ref, #messages .msg:has-text("9 minutes") [class*="reply"]'));
    const sent = got[0] && got[0].body;
    ok('it asks Claude with the API key and the default model', got[0].url.startsWith('/v1/messages') && (got[0].headers['x-api-key'] === 'sk-test' || got[0].headers.authorization === 'Bearer sk-test') && sent.model === 'claude-opus-5-5');
    const text = sent.messages[0].content;
    ok('with the recent chat as context, and who is asking', text.includes('Bora: I want soft eggs tomorrow') && text.includes('Poseidon asks: how long should I boil an egg?'));
    ok('and lets a declined question fall back to another model', sent.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(got[0].headers['anthropic-beta'] || ''));

    await say(a, '/ask');
    await a.waitForSelector('#botNote:not([hidden]):has-text("Ask something")');
    ok('an empty /ask explains itself privately', got.length === 1);

    reply = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    await say(a, '/ask what is 2+2?');
    await b.waitForSelector('#messages .msg:has-text("API key isn’t working")');
    ok('if the key is wrong, Party Bot says so in the chat', true);
    await b.screenshot({ path: `${RESULTS}/ask.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); fake.close(); }
}
