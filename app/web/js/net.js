/* Talking to the Party Line server: a JSON API over HTTPS and one live WebSocket that reconnects by itself. */
export const store = {
  get(k, d) { try { const v = localStorage.getItem('pl:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pl:' + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem('pl:' + k); } catch {} },
};

// The web app lives on the server itself. A packaged mobile app sets window.PL_SERVER to the server's address.
const BASE = String(window.PL_SERVER || '').replace(/\/+$/, '');
export const absUrl = (u) => (u && u.startsWith('/') ? BASE + u : u);
let token = store.get('token', '');
export const hasToken = () => !!token;
export function setToken(t) { token = t || ''; if (t) store.set('token', t); else store.del('token'); }

export async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (token) headers.authorization = `Bearer ${token}`;
  let body = opts.body;
  if (body && !(body instanceof Blob) && typeof body === 'object') { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
  let res;
  try { res = await fetch(BASE + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body }); }
  catch { throw new Error("Can't reach the Party Line server. Check your internet connection."); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || `The server said no (${res.status}).`); e.status = res.status; throw e; }
  return data;
}

/* Upload with progress (fetch can't report upload progress). */
export function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', BASE + path);
    x.setRequestHeader('authorization', `Bearer ${token}`);
    x.setRequestHeader('content-type', file.type || 'application/octet-stream');
    x.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'file'));
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error(d.error || 'Upload failed.'));
    };
    x.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    x.send(file);
  });
}

/* ---------- live connection ---------- */
const listeners = new Map();
const pending = new Map();
let ws = null, rid = 0, retry = 0, retryTimer = 0, wantOpen = false, queue = [];
export const live = {
  get open() { return !!ws && ws.readyState === 1; },
  on(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
  emit(t, d) { for (const fn of listeners.get(t) || []) { try { fn(d); } catch (e) { console.error(t, e); live.lastError = `${t}: ${e && e.message}`; } } },
  /* For the "still connecting" help: how the last try ended, and the last error while handling a message. */
  lastClose: null, lastError: '',
  connect() { wantOpen = true; open(); },
  close() { wantOpen = false; clearTimeout(retryTimer); if (ws) { try { ws.close(); } catch {} } ws = null; },
  /* Fire and forget. Sent as soon as the connection is up. */
  send(t, data) {
    const msg = JSON.stringify(Object.assign({ t }, data));
    if (live.open) ws.send(msg); else queue.push(msg);
  },
  /* Ask and wait for the server's answer. Rejects with the server's error text. */
  req(t, data, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!live.open) { reject(new Error('Not connected to the server right now.')); return; }
      const id = ++rid;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The server took too long to answer.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(Object.assign({ t, rid: id }, data)));
    });
  },
};

function open() {
  if (!wantOpen || (ws && ws.readyState <= 1)) return;
  const base = BASE || location.origin;
  const url = base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    sock.opened = true;
    retry = 0;
    const q = queue; queue = [];
    for (const m of q) sock.send(m);
    live.emit('open');
  };
  sock.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'ack') {
      const p = pending.get(d.rid);
      if (!p) return;
      pending.delete(d.rid); clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d);
      return;
    }
    live.emit(d.t, d);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    live.lastClose = { code: e.code, opened: !!sock.opened };
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Lost connection to the server.')); pending.delete(id); }
    if (e.code === 4001) { wantOpen = false; live.emit('auth-failed'); return; }
    live.emit('down');
    if (!wantOpen) return;
    retry++;
    retryTimer = setTimeout(open, Math.min(15000, 500 * 2 ** Math.min(retry, 5)) + Math.random() * 400);
  };
  sock.onerror = () => {};
}
window.addEventListener('online', () => { if (wantOpen && !ws) { clearTimeout(retryTimer); open(); } });
