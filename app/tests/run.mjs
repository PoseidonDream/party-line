/* Runs every *.test.mjs file in this folder (or the ones named on the command line) and reports.
   Each test file exports test(name, fn) cases through `export default [ ... ]`. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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
    console.log(`  ✗ ${e.message.split('\n')[0]}`);
    if (process.env.VERBOSE) console.log(e.stack);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)}s)`);
process.exit(failed ? 1 : 0);
