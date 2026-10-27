/* GIF search, from Giphy. Off until GIPHY_KEY is set in deploy/.env (a free key from developers.giphy.com).
   Searches go through the server, so the key stays private and Giphy never sees friends' addresses (previews
   pass through the link-preview image proxy). The GIF someone picks is saved on our server like an upload and
   sent as a normal GIF message, so old messages keep working even if Giphy removes it. */
import fs from 'node:fs';
import path from 'node:path';
import * as M from './model.js';
import { one, run } from './db.js';
import { config } from './config.js';
import { get, imagePath } from './preview.js';

const key = () => process.env.GIPHY_KEY || '';
const base = () => process.env.GIPHY_BASE || 'https://api.giphy.com';   // tests point this at a stand-in
export const gifsEnabled = () => !!key();
const uploadDir = path.join(config.dataDir, 'uploads');
const MAX_GIF = 8 * 1048576;
const fail = (msg) => { throw new M.UserError(msg); };
// Only Giphy's own picture servers are ever fetched.
const mediaOk = (url) => /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com)\//.test(url) || (config.previewPrivate && /^http:\/\/127\.0\.0\.1:\d+\//.test(url));

const results = new Map();   // search text -> { at, gifs }
const known = new Map();     // Giphy id -> { url, title } of GIFs shown in results

async function giphy(pathname, params) {
  const u = new URL(pathname, base());
  u.searchParams.set('api_key', key());
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u, { signal: AbortSignal.timeout(6000) }); } catch { fail('GIF search isn’t reachable right now. Try again in a bit.'); }
  if (r.status === 401 || r.status === 403) fail('The GIF key isn’t working. Ask the server owner to check GIPHY_KEY.');
  if (r.status === 429) fail('Too many GIF searches this hour (Giphy’s free limit). Try again a bit later.');
  if (!r.ok) { console.error('giphy', r.status); fail('GIF search isn’t working right now. Try again in a bit.'); }
  return r.json();
}
function remember(g) {
  const im = g.images || {};
  const small = im.fixed_width_small || im.fixed_width || {}, full = im.downsized || im.fixed_width || {};
  if (!small.url || !full.url || !mediaOk(small.url) || !mediaOk(full.url)) return null;
  if (known.size > 3000) known.clear();
  const title = String(g.title || '').replace(/\s+GIF(\s+by\s+.*)?$/i, '').trim().slice(0, 80) || 'GIF';
  known.set(String(g.id), { url: full.url, title });
  return { id: String(g.id), title, preview: imagePath(small.url), w: Number(small.width) || 100, h: Number(small.height) || 100 };
}

/* Trending GIFs for an empty search. */
export async function searchGifs(q) {
  if (!gifsEnabled()) return { enabled: false, gifs: [] };
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const k = q.toLowerCase(), hit = results.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return { enabled: true, gifs: hit.gifs };
  const data = await giphy(q ? '/v1/gifs/search' : '/v1/gifs/trending', Object.assign({ limit: '24', rating: 'pg-13' }, q ? { q } : {}));
  const gifs = (data.data || []).map(remember).filter(Boolean);
  if (results.size > 300) results.clear();
  results.set(k, { at: Date.now(), gifs });
  return { enabled: true, gifs };
}

/* Saves the GIF on our server (once per GIF) and returns the upload id to send as <g:id>. */
export async function saveGif(userId, id) {
  if (!gifsEnabled()) fail('GIF search isn’t switched on.');
  id = String(id || '');
  if (!/^[\w-]{1,40}$/.test(id)) fail('That GIF is gone.');
  const have = one('SELECT upload_id FROM gif_cache WHERE giphy_id = ?', id);
  if (have && M.getUpload(have.upload_id) && fs.existsSync(path.join(uploadDir, have.upload_id))) return have.upload_id;
  let g = known.get(id);
  if (!g) { const d = await giphy(`/v1/gifs/${encodeURIComponent(id)}`); if (!d.data || !remember(d.data)) fail('That GIF is gone.'); g = known.get(id); }
  let r;
  try { r = await get(g.url, MAX_GIF, 'image/*'); } catch { fail('That GIF couldn’t be downloaded. Try another one.'); }
  const type = String(r.type).split(';')[0].trim().toLowerCase();
  if (r.truncated || !/^image\/(gif|webp)$/.test(type)) fail('That GIF is too big. Try another one.');
  fs.mkdirSync(uploadDir, { recursive: true });
  const up = M.addUpload(userId, `${g.title}.${type === 'image/webp' ? 'webp' : 'gif'}`, type, r.body.length);
  fs.writeFileSync(path.join(uploadDir, up), r.body);
  run('INSERT OR REPLACE INTO gif_cache (giphy_id, upload_id) VALUES (?, ?)', id, up);
  return up;
}
