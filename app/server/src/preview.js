/* Link previews: when a message has links, the server fetches each page (not friends' browsers) and reads its
   title, description, picture and site name. Pictures are passed through the server too, so other sites never
   see friends' IP addresses. Only public internet addresses are fetched: anything inside the server's own
   network (localhost, 10.x, 192.168.x, cloud metadata and so on) is refused, also after redirects. */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, run } from './db.js';
import { config } from './config.js';

const MAX_HTML = 512 * 1024, MAX_IMAGE = 5 * 1024 * 1024, TIMEOUT = 6000;
const UA = 'Mozilla/5.0 (compatible; PartyLineBot/1.0; link previews)';

/* ---------- which addresses may be fetched ---------- */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPublicAddress(x.slice(7));
    return !(x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') ||
      x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff') || x.startsWith('64:ff9b') || x.startsWith('2001:db8'));
  }
  return false;
}
/* DNS lookup that refuses private addresses; the connection then goes to exactly the address checked. */
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((x) => config.previewPrivate || isPublicAddress(x.address));
    if (!ok.length) return cb(new Error('private address'));
    if (opts && opts.all) cb(null, ok); else cb(null, ok[0].address, ok[0].family);
  });
}
/* GET a URL, following up to 3 redirects, reading at most `max` bytes. Resolves { url, type, body }. */
export function get(url, max, accept, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port) && !config.previewPrivate)) return reject(new Error('not allowed'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !config.previewPrivate && !isPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('private address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: TIMEOUT, headers: { 'user-agent': UA, accept, 'accept-language': 'en,tr;q=0.8' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, u).href, max, accept, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); return; } chunks.push(c); });
      res.on('end', () => resolve({ url: u.href, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks), truncated: size > max }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ---------- reading a page ---------- */
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return Object.hasOwn(named, k) ? named[k] : m;
}).replace(/\s+/g, ' ').trim();
export function parsePage(html, pageUrl) {
  const head = html.slice(0, 300_000);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (n) => { const m = new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
    const key = (attr('property') || attr('name') || '').toLowerCase(), content = attr('content');
    if (key && content != null && !(key in meta)) meta[key] = decode(content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const abs = (x) => { try { const v = new URL(x, pageUrl); return /^https?:$/.test(v.protocol) ? v.href : null; } catch { return null; } };
  const title = meta['og:title'] || meta['twitter:title'] || (titleTag && decode(titleTag[1])) || '';
  if (!title) return null;
  return {
    url: pageUrl,
    site: (meta['og:site_name'] || new URL(pageUrl).hostname.replace(/^www\./, '')).slice(0, 80),
    title: title.slice(0, 200),
    description: (meta['og:description'] || meta['twitter:description'] || meta.description || '').slice(0, 300),
    image: abs(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || ''),
    big: (meta['twitter:card'] || '') === 'summary_large_image' || /video|article/.test(meta['og:type'] || ''),
  };
}
const youtubeId = (u) => { const m = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(u); return m && m[1]; };

/* A preview for one URL: from the cache (a day), or fetched now. null when the page has nothing to show. */
export async function previewFor(url) {
  const cached = one('SELECT data, fetched_at FROM link_previews WHERE url = ?', url);
  if (cached && Date.now() - cached.fetched_at < 86_400_000) return JSON.parse(cached.data);
  let p = null;
  try {
    const yt = youtubeId(url);
    if (yt) {
      const r = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + yt)}`, 64 * 1024, 'application/json');
      const j = JSON.parse(r.body.toString('utf8'));
      p = { url, site: 'YouTube', title: String(j.title || '').slice(0, 200), description: String(j.author_name || ''), image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, big: true, youtube: yt };
    } else {
      const r = await get(url, MAX_HTML, 'text/html,application/xhtml+xml');
      if (/text\/html|xhtml/i.test(r.type)) p = parsePage(r.body.toString('utf8'), r.url);
      else if (/^image\/(png|jpeg|gif|webp)/i.test(r.type)) p = null;   // a bare picture link: nothing to add
    }
  } catch { p = null; }
  run('INSERT OR REPLACE INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?)', url, JSON.stringify(p), Date.now());
  return p;
}

/* The links in a message worth previewing: up to 3, not ones inside <angle brackets> (Discord's "no preview"). */
export function linksIn(body) {
  const out = [];
  for (const m of String(body || '').matchAll(/(^|[^<])(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'])/gi)) {
    if (!out.includes(m[2])) out.push(m[2]);
    if (out.length >= 3) break;
  }
  return out;
}

/* Preview pictures go through /api/link-image with a signature, so the server only ever fetches pictures it
   chose for a preview (it isn't an open proxy). The key is kept in the data folder so links survive restarts. */
const keyFile = path.join(config.dataDir, 'preview-key');
let key;
try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch {}
if (!key) { key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, key, { mode: 0o600 }); }
const sign = (url) => crypto.createHmac('sha256', key).update(url).digest('base64url').slice(0, 32);
export const imagePath = (url) => url && `/api/link-image?u=${encodeURIComponent(url)}&s=${sign(url)}`;
export const signatureOk = (url, s) => typeof url === 'string' && typeof s === 'string' && s.length === 32 && crypto.timingSafeEqual(Buffer.from(sign(url)), Buffer.from(s));

/* Preview pictures, passed through the server. Only images, at most 5 MB. */
export async function proxyImage(url) {
  const r = await get(url, MAX_IMAGE, 'image/*');
  if (r.truncated || !/^image\/(png|jpeg|gif|webp|avif)/i.test(r.type)) throw new Error('not an image');
  return { type: r.type.split(';')[0], body: r.body };
}
