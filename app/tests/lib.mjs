/* Shared test helpers: start a throwaway Party Line server and open fake people in Chromium. */
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.join(here, '..', 'server');
export const RESULTS = path.join(here, 'results');
fs.mkdirSync(RESULTS, { recursive: true });


/* A fresh server with an empty database. stop() shuts it down; restart() keeps the data. */
export async function startServer(env = {}) {
  let port = 0;   // the first start lets the system pick a free port; restarts reuse it
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-test-'));
  const fullEnv = { ...process.env, DATA_DIR: dataDir, GROUP_PASSWORD: 'test', ADMIN_NAMES: 'Poseidon', REPORT_DAY: '7', ...env };   // no weekly report in the middle of a test (usage.test.mjs asks for one)
  let proc = null, log = '';
  const launch = async () => {
    log = '';
    proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: SERVER_DIR, env: { ...fullEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { log += d; });
    proc.stderr.on('data', (d) => { log += d; });
    const exited = new Promise((r) => proc.once('close', r));   // after its output has been read
    // Up to 30 s: the first start on a cold CI machine can be slow.
    for (let i = 0; i < 300 && proc.exitCode === null; i++) {
      const m = /server on http:\/\/localhost:(\d+)/.exec(log);
      if (m) {
        port = Number(m[1]);
        try { if ((await fetch(`http://127.0.0.1:${port}/api/info`)).ok) return; } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (proc.exitCode !== null) await exited;
    throw new Error(`server didn't start (port ${port}, exit ${proc.exitCode}):\n${log}`);
  };
  // PL_SERVER_ERRORS=1: print anything the server logged as an error (tests can pass while it hides a problem).
  const showErrors = () => {
    if (!process.env.PL_SERVER_ERRORS) return;
    const lines = log.split('\n').filter((l) => /Error|^\s+at .*src[\\/].*\.js:\d+/.test(l));
    if (lines.length) console.log(`  [server errors]\n    ${lines.slice(0, 15).join('\n    ')}`);
  };
  const stop = () => new Promise((resolve) => {
    showErrors();
    if (!proc || proc.exitCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.kill();
  });
  await launch();
  process.on('exit', () => { try { proc.kill(); } catch {} });
  return {
    get url() { return `http://localhost:${port}`; },
    dataDir,
    stop: async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); },
    kill: stop,
    restart: launch,
    log: () => log,
  };
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.PL_CHROMIUM || undefined,   // uses Playwright's own Chromium unless set
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
  });
}

/* Opens a page and collects JavaScript errors so tests can fail on them. */
export async function openPage(browser, base, opts = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }, opts));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base);
  return page;
}

export async function signUp(browser, base, name, opts) {
  const page = await openPage(browser, base, opts);
  await page.click('#tabRegister');
  await page.fill('#authName', name);
  await page.fill('#authPass', 'pass1234');
  if (await page.isVisible('#authGroup')) await page.fill('#authGroup', 'test');
  await page.check('#authAgree');
  await page.click('#authBtn');
  await page.waitForSelector('#room:not([hidden])', { timeout: 10000 });
  return page;
}

export async function joinVoice(page, channel = 'Lobby') {
  await page.click('#railList .rail-btn');
  await page.click(`#voiceList .chan:has-text("${channel}")`);
  await page.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 });
}

/* The server's database, for tests that fast-forward time or check what was saved. It waits its turn while the
   server is writing (instead of failing with "database is locked"). */
export function openDb(srv) {
  const db = new DatabaseSync(path.join(srv.dataDir, 'party-line.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function assert(ok, msg) { if (!ok) throw new Error(msg); }
