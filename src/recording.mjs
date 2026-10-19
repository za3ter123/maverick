// Session recording helpers for the desktop app (desktop/main.cjs writes the file, serve.mjs plays it back).
// Node only: paths and Buffers. test/selfcheck.mjs covers each one.
import { isAbsolute, join } from 'node:path';

// Settings, Record meetings: 'off' (the default), 'audio' (Audio only) or 'screen' (Audio + screen).
export const RECORD_MODES = ['off', 'audio', 'screen'];
export const recordMode = (v) => (RECORD_MODES.includes(v) ? v : 'off');

// The folder: the one picked in Settings, or "Maverick recordings" under the user's Videos.
export const DEFAULT_DIR_NAME = 'Maverick recordings';
export const recordDir = (saved, videos) => (typeof saved === 'string' && saved && isAbsolute(saved) ? saved : join(videos, DEFAULT_DIR_NAME));
// What Settings may save: '' (back to the default) or an absolute path. Anything else is refused (null).
export function recordDirSetting(v) {
  if (v === '') return '';
  return typeof v === 'string' && v.length <= 1000 && !v.includes('\0') && isAbsolute(v) ? v : null;
}

// maverick-2026-10-17-143005.webm, local time; n > 1 adds -n when that name is taken.
const pad = (n) => String(n).padStart(2, '0');
export function recordingName(d, n = 1) {
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `maverick-${stamp}${n > 1 ? `-${n}` : ''}.webm`;
}
// serve.mjs plays back only files named like this.
export const RECORDING_FILE = /^maverick-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d{1,3})?\.webm$/;

// An HTTP Range header against a file of `size` bytes: the bytes to send, or null when it cannot be met (416).
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, partial: false };
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? null : { start, end, partial: true };
}

// ---------------------------------------------------------------- WebM duration
// Chromium's MediaRecorder writes a live WebM: no duration, so players show no length and seek poorly. The file is
// written as it arrives (a crash keeps it), so the duration cannot go in at the start. Instead the first chunk gets an
// 11-byte Void element at the end of its Info element, and at a clean stop the Void is overwritten in place by a
// Duration element of the same size. A crashed file keeps the Void, which every reader skips.

// EBML: an ID keeps its length marker, a size drops it; both are 1 to 8 bytes, the length given by the first byte.
const vlen = (b) => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0; };
function element(buf, at) {
  const idLen = vlen(buf[at]);
  if (!idLen || at + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[at + i];
  const s = at + idLen;
  const sizeLen = vlen(buf[s]);
  if (!sizeLen || s + sizeLen > buf.length) return null;
  let size = buf[s] & (0xff >> sizeLen);
  let unknown = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) { size = size * 256 + buf[s + i]; if (buf[s + i] !== 0xff) unknown = false; }
  return { id, sizeAt: s, sizeLen, size: unknown ? -1 : size, data: s + sizeLen };
}
// Rewrites a size in place with the same width; false when it does not fit.
function setSize(buf, at, len, v) {
  if (v >= 2 ** (7 * len) - 1) return false;
  for (let i = len - 1; i >= 0; i--) { buf[at + i] = v % 256; v = Math.floor(v / 256); }
  buf[at] |= 0x80 >> (len - 1);
  return true;
}
const uint = (buf, at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[at + i]; return v; };
const VOID = [0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // ID, size 9, nine bytes

// The first chunk of a recording with the Void added: { buf, at (the Void's offset in the file), scale (ns per tick) },
// MORE when the chunk ends before its Info element does (MediaRecorder hands over a 1-byte first chunk when no video
// frame came in the first second: main.cjs keeps it and tries again with the next chunk appended), or null when the
// chunk is not a WebM start this understands (then the file is written as it came).
export const MORE = 'more';
export function reserveDuration(head) {
  const cut = (at) => (at + 12 > head.length ? MORE : null); // an element head is at most 12 bytes: one cut short means more is coming
  const ebml = element(head, 0);
  if (!ebml) return cut(0);
  if (ebml.id !== 0x1a45dfa3 || ebml.size < 0) return null;
  const seg = element(head, ebml.data + ebml.size);
  if (!seg) return cut(ebml.data + ebml.size);
  if (seg.id !== 0x18538067) return null;
  for (let at = seg.data; ;) {
    if (at >= head.length) return MORE;
    const c = element(head, at);
    if (!c) return cut(at);
    if (c.size < 0) return null;
    if (c.id === 0x1549a966) { // Info
      const end = c.data + c.size;
      if (end > head.length) return MORE;
      let scale = 1e6;
      for (let q = c.data; q < end;) {
        const d = element(head, q);
        if (!d || d.size < 0) return null;
        if (d.id === 0x4489) return null; // it has a duration already
        if (d.id === 0x2ad7b1) scale = uint(head, d.data, d.size); // TimecodeScale
        q = d.data + d.size;
      }
      const buf = Buffer.concat([head.subarray(0, end), Buffer.from(VOID), head.subarray(end)]);
      if (!setSize(buf, c.sizeAt, c.sizeLen, c.size + VOID.length)) return null;
      if (seg.size >= 0 && !setSize(buf, seg.sizeAt, seg.sizeLen, seg.size + VOID.length)) return null;
      return { buf, at: end, scale: scale || 1e6 };
    }
    at = c.data + c.size;
  }
}

// The Duration element (float64, in ticks of `scale` ns) that takes the Void's 11 bytes.
export function durationElement(ms, scale = 1e6) {
  const b = Buffer.alloc(VOID.length);
  b[0] = 0x44; b[1] = 0x89; b[2] = 0x88;
  b.writeDoubleBE((ms * 1e6) / scale, 3);
  return b;
}
