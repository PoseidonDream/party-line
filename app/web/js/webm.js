/* Browsers record WebM (voice messages, clips) without writing down how long it is, so players can't show the length
   or skip around. withDuration() writes it into the file's header (the Info section) before it's uploaded.
   Anything unexpected, and the recording is sent as it was. */

function vint(b, pos, keepMarker) {
  const first = b[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > b.length) throw new Error('bad vint');
  let value = keepMarker ? first : first & (mask - 1), ones = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xff) ones = false; }
  return { value, len, unknown: !keepMarker && ones };
}
function element(b, p) {
  const id = vint(b, p, true), size = vint(b, p + id.len, false);
  return { id: id.value, sizePos: p + id.len, sizeLen: size.len, start: p + id.len + size.len, size: size.value, unknown: size.unknown };
}
/* The shortest size field that holds n. */
function sizeField(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i > 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] = v | (0x80 >> (len - 1));
      return out;
    }
  }
  throw new Error('too big');
}
const EBML = 0x1A45DFA3, SEGMENT = 0x18538067, INFO = 0x1549A966, SCALE = 0x2AD7B1, DURATION = 0x4489, CLUSTER = 0x1F43B675;

export async function withDuration(blob, ms) {
  if (!blob || !(ms > 0) || !/webm/.test(blob.type)) return blob;
  try {
    const b = new Uint8Array(await blob.arrayBuffer());
    const head = element(b, 0);
    if (head.id !== EBML) return blob;
    const seg = element(b, head.start + head.size);
    if (seg.id !== SEGMENT || !seg.unknown) return blob;   // a recording in progress always has an open-ended segment
    let p = seg.start, info = null;
    while (p < b.length) {
      const e = element(b, p);
      if (e.id === INFO) { info = e; break; }
      if (e.id === CLUSTER || e.unknown) break;
      p = e.start + e.size;
    }
    if (!info || info.unknown) return blob;
    let scale = 1e6, dur = null;
    for (let q = info.start; q < info.start + info.size;) {
      const e = element(b, q);
      if (e.id === SCALE) { scale = 0; for (let i = 0; i < e.size; i++) scale = scale * 256 + b[e.start + i]; }
      if (e.id === DURATION) dur = e;
      q = e.start + e.size;
    }
    const value = ms * 1e6 / (scale || 1e6);
    if (dur && (dur.size === 8 || dur.size === 4)) {   // already there (usually 0): fill it in
      const out = b.slice();
      const view = new DataView(out.buffer, dur.start, dur.size);
      if (dur.size === 8) view.setFloat64(0, value); else view.setFloat32(0, value);
      return new Blob([out], { type: blob.type });
    }
    const field = new Uint8Array(11);
    field.set([0x44, 0x89, 0x88]);
    new DataView(field.buffer).setFloat64(3, value);
    return new Blob([b.subarray(0, info.sizePos), sizeField(info.size + field.length), b.subarray(info.start, info.start + info.size), field, b.subarray(info.start + info.size)], { type: blob.type });
  } catch { return blob; }
}
