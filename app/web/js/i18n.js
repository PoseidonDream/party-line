/* Languages. Party Line is written in English. In another language, every bit of text the app shows is swapped for
   its translation as it appears on screen (from /i18n/<code>.json, saved on the device for a quick start). What people
   write is never touched: messages, names, and what servers, channels, polls and events are called. Lines with {0},
   {1} hold a name or a number that can sit anywhere in the translation. */
import { settings, saveSettings } from './util.js';

export const LANGS = [['en', 'English'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['ru', 'Русский'], ['tr', 'Türkçe']];
const CODES = new Set(LANGS.map(([c]) => c));
// People's own words, and things that aren't words.
const SKIP = [
  '[translate="no"]', 'script', 'style', 'code', 'pre', 'kbd', 'select option[data-own]',
  '.msg-body', '.msg-name', '.msg-reply b', '.msg-reply span', '.search-body', '.later-body', '.chan-name', '.chan-status', '.member-name',
  '.tile-name', '.dm-name', '.poll-q', '.poll-text', '.game-name', '.game-chip', '.role-chip', '.embed', '.ev-title', '.ev-desc',
  '.att-name', '.file-text', '.fb-body', '.reset-note', '.custom-cat .cat-toggle', '.home-server-text b', '.dash-text b', '.top-who b',
  '#popName', '#popBio', '#popCustom', '#popActivity', '#meName', '#meStatus', '#serverName', '#vcStatusText:not(.empty)', '#jumpList .jump-label',
].join(', ');
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

let exact = new Map(), templates = new Map(), patterns = [], domPatterns = [], observer = null, active = false;
const misses = new Set();
const textOrig = new WeakMap();   // text node -> { en, out }
const attrOrig = new WeakMap();   // element -> { attr: { en, out } }

export function deviceLang() {
  for (const l of navigator.languages || [navigator.language || 'en']) { const c = String(l).slice(0, 2).toLowerCase(); if (CODES.has(c)) return c; }
  return 'en';
}
export const currentLang = () => (CODES.has(settings.lang) ? settings.lang : deviceLang());

function load(table) {
  exact = new Map(); templates = new Map(); patterns = []; domPatterns = []; misses.clear();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [en, out] of Object.entries(table || {})) {
    if (!out) continue;
    if (!/\{\d\}/.test(en)) { exact.set(en, out); continue; }
    templates.set(en, out);
    const re = new RegExp(`^${en.split(/\{\d\}/).map(esc).join('(.*?)')}$`, 's');
    const p = [re, out, en.match(/\{\d\}/g).map((x) => Number(x[1]))];
    patterns.push(p);
    // On screen, only lines with enough words of their own (a line like "{0} in {1}" would catch far too much).
    if (en.replace(/\{\d\}/g, '').replace(/[^\p{L}]/gu, '').length >= 5) domPatterns.push(p);
  }
}
function lookup(s, list) {
  const key = s.trim();
  if (!key || !/\p{L}/u.test(key)) return null;
  let out = exact.get(key);
  if (out === undefined) {
    if (misses.has(key)) return null;
    for (const [re, tpl, order] of list) {
      const m = re.exec(key);
      if (m) { const vals = {}; order.forEach((n, i) => { vals[n] = m[i + 1]; }); out = tpl.replace(/\{(\d)\}/g, (x, n) => vals[n] ?? ''); break; }
    }
    if (out === undefined) { if (misses.size > 5000) misses.clear(); misses.add(key); return null; }
  }
  return s.match(/^\s*/)[0] + out + s.match(/\s*$/)[0];
}
/* For text the app builds from pieces, or outside the page (notifications): t('{0} is typing…', name). A piece that is
   itself app text is passed through t() too: t('Noise filter: {0}', t('Strong')). Names are never translated. */
export function t(s, ...vals) {
  const filled = s.replace(/\{(\d)\}/g, (x, n) => vals[n] ?? '');
  if (!active) return filled;
  const hit = exact.get(s) ?? templates.get(s);
  if (hit !== undefined) return hit.replace(/\{(\d)\}/g, (x, n) => vals[n] ?? '');
  return lookup(filled, patterns) || filled;
}

const skipped = (el) => !!(el && el.closest && el.closest(SKIP));
function doText(node) {
  const el = node.parentElement;
  if (!el || skipped(el) || el.tagName === 'TEXTAREA') return;   // a text box's hint is translated, never its text
  const rec = textOrig.get(node);
  if (rec && node.data === rec.out) return;   // our own translation
  const en = node.data, out = lookup(en, domPatterns);
  if (out == null || out === en) { if (rec) textOrig.delete(node); return; }
  textOrig.set(node, { en, out });
  node.data = out;
}
function doAttrs(el) {
  if (!el.hasAttribute || skipped(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const recs = attrOrig.get(el) || {};
    if (recs[a] && recs[a].out === v) continue;
    const out = lookup(v, domPatterns);
    if (out == null || out === v) continue;
    recs[a] = { en: v, out }; attrOrig.set(el, recs);
    el.setAttribute(a, out);
  }
}
function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}
function restore(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = w.currentNode; n; n = w.nextNode()) {
    if (n.nodeType === 3) { const r = textOrig.get(n); if (r && n.data === r.out) n.data = r.en; textOrig.delete(n); continue; }
    const recs = attrOrig.get(n);
    if (recs) { for (const [a, r] of Object.entries(recs)) if (n.getAttribute(a) === r.out) n.setAttribute(a, r.en); attrOrig.delete(n); }
  }
}
function watch(on) {
  if (observer) { observer.disconnect(); observer = null; }
  if (!on) return;
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') for (const n of m.addedNodes) walk(n);
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

const cacheKey = (code) => `pl:i18n:${code}`;
function cached(code) { try { return JSON.parse(localStorage.getItem(cacheKey(code)) || 'null'); } catch { return null; } }
function apply(code, table) {
  watch(false);
  restore(document.documentElement);
  active = code !== 'en' && !!table;
  document.documentElement.lang = code;
  if (!active) return;
  load(table);
  walk(document.documentElement);
  watch(true);
}
/* Switch to a language: right away from the copy saved on this device, then the server's newest translation. */
export async function setLang(code, save = true) {
  if (!CODES.has(code)) code = 'en';
  if (save) { settings.lang = code; saveSettings(); }
  if (code === 'en') { apply('en', null); return; }
  const have = cached(code);
  if (have) apply(code, have);
  try {
    const fresh = await (await fetch(`/i18n/${code}.json`, { cache: 'no-cache' })).json();
    if (currentLang() !== code) return;   // switched again meanwhile
    try { localStorage.setItem(cacheKey(code), JSON.stringify(fresh)); } catch {}
    if (JSON.stringify(fresh) !== JSON.stringify(have)) apply(code, fresh);
  } catch {}
}
export function startI18n() { const code = currentLang(); if (code !== 'en') return setLang(code, false); document.documentElement.lang = 'en'; return Promise.resolve(); }
