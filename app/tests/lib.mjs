/* Shared test helpers: start a throwaway Party Line server and open fake people in Chromium. */
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

let nextPort = 3900 + Math.floor(Math.random() * 500);

/* A fresh server with an empty database. stop() shuts it down; restart() keeps the data. */
export async function startServer(env = {}) {
  const port = nextPort++;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-test-'));
  const fullEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir, GROUP_PASSWORD: 'test', ADMIN_NAMES: 'Poseidon', ...env };
  let proc = null, log = '';
  const launch = async () => {
    proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: SERVER_DIR, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { log += d; });
    proc.stderr.on('data', (d) => { log += d; });
    const url = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${url}/api/info`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server didn't start:\n${log}`);
  };
  const stop = () => new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.kill();
  });
  await launch();
  process.on('exit', () => { try { proc.kill(); } catch {} });
  return {
    url: `http://localhost:${port}`,
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
  await page.click('#authBtn');
  await page.waitForSelector('#room:not([hidden])', { timeout: 10000 });
  return page;
}

export async function joinVoice(page, channel = 'Lobby') {
  await page.click('#railList .rail-btn');
  await page.click(`#voiceList .chan:has-text("${channel}")`);
  await page.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 });
}

export function assert(ok, msg) { if (!ok) throw new Error(msg); }
