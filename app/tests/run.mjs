/* Runs every *.test.mjs file in this folder (or the ones named on the command line) and reports.
   Each test file exports test(name, fn) cases through `export default [ ... ]`. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
/* PL_LIVEKIT=/path/to/livekit-server runs every test with voice going through the media server. */
let livekit = null;
if (process.env.PL_LIVEKIT) {
  livekit = spawn(process.env.PL_LIVEKIT, ['--dev', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  process.on('exit', () => livekit.kill());
  Object.assign(process.env, { LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_KEY: 'devkey', LIVEKIT_SECRET: 'secret' });
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:7880'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  console.log('Voice goes through the LiveKit media server for this run.');
}
const pick = process.argv.slice(2);
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs') && (!pick.length || pick.some((p) => f.includes(p)))).sort();
let passed = 0, failed = 0;
const started = Date.now();
for (const f of files) {
  console.log(`\n${f}`);
  const mod = await import(path.join(here, f));
  try {
    await mod.default((name, ok) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); } });
  } catch (e) {
    failed++;
    // One line, with the browser tool's reasons (like "… intercepts pointer events"), so CI's summary shows why.
    const lines = [...new Set(e.message.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => l && !/^=+/.test(l) && !/Call log/.test(l)))];
    const routine = /retrying|waiting \d+ms|locator resolved|attempting .* action|waiting for element to be|element is visible, enabled|scrolling into view|done scrolling|performing .* action|navigations have finished/;
    console.log(`  ✗ ${[...lines.slice(0, 2), ...lines.slice(2).filter((l) => !routine.test(l)).slice(0, 4)].join(' — ')}`);
    if (process.env.VERBOSE) console.log(e.stack);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)}s)`);
process.exit(failed ? 1 : 0);
