// Pure helpers for the live copilot: questions from the other side, the smart assist route, slide-change hashing,
// pointing phrases and screen reads, earlier meetings, and the remote-session flag. Plain data in and out; no DOM.

import { normalize } from './library.mjs';
import { elapsed } from './prompts.mjs';

// ---------------------------------------------------------------- questions

const Q_EN = /^(?:what(?! an? )|why|how|when|where|who|whom|whose|which|can|could|would|will|should|shall|do|does|did|is|are|was|were|have|has|had|may|might|tell me|explain|any (?:idea|thoughts|update))\b/i;
// Gulf and standard Arabic question openers; "من" only before a pronoun ("من هو"), since alone it is also "from"
const Q_AR = /^(?:[وف]?(?:هل|ما|ماذا|لماذا|ليش|ليه|كيف|شلون|متى|متي|وين|اين|أين|مين|كم|شنو|ايش|إيش|وش|شو|ممكن|تقدر|تقدرون|عندك|عندكم)(?=\s|$)|من (?:هو|هي|هم|اللي|الي)(?=\s|$|[؟?]))/;
// A line from the meeting that asks something: a question mark (Latin or Arabic), or a question opener, at three words
// or more ("right?" and "you know?" are not questions to answer).
export function isLikelyQuestion(text) {
  const t = String(text ?? '').replace(/\[(?:overlap|unclear)\]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (t.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length < 3) return false;
  if (/[?؟]\s*["'”)]*$/.test(t) || /[?؟]/.test(t.slice(-40))) return true;
  const first = t.replace(/^[^\p{L}]+/u, '').replace(/^(?:so|and|but|okay|ok|well|then|also|guys|yeah|sorry|يعني|طيب|زين|اوكي|بس)[,\s]+/i, '');
  return Q_EN.test(first) || Q_AR.test(first);
}

// ---------------------------------------------------------------- smart assist

// What is on the screen, from its read: 'code', 'math' or ''. Several code signs, or one clear exercise word or an
// equation with a variable; a slide of figures ("Revenue 2.4M, up 12%") is neither.
const CODE = [/\b(?:def|function|return|class|public|private|static|void|const|let|var|import|elif|lambda|printf|println)\b/, /#include|console\.log|print\(|System\.out|=>|::|\+\+|!==?|===?/, /\b(?:for|while|if|switch)\s*\(/, /[{};]\s*$/m, /\b(?:Traceback|Exception|SyntaxError|TypeError|NullPointer|undefined is not)\b/, /\bSELECT\b[\s\S]{1,80}\bFROM\b/i,
  /^\s*(?:def|class|for|while|if|elif|else|try|except|with)\b[^\n]*:\s*$/m, /\b[a-z_]\w*\([^()\n]*\)/];
const MATH = /\b(?:solve|calculate|compute|evaluate|simplify|prove|derive|differentiate|integrate|find (?:x|y|the value|the area|the probability)|what is the value|time complexity|write (?:a|an) (?:function|program|query|algorithm)|implement (?:a|an|the)?\s*\w+)\b|احسب|أوجد|اوجد|حل المعادلة|[√∫∑]|\b[a-z]\s*(?:\^|²|³)\s*\d?|\b[a-z]\s*=\s*\?|=\s*\?|\b\d*[a-z]\s*[+\-−]\s*\d+\s*=\s*-?\d/i;
export function screenKind(text) {
  const s = String(text ?? '');
  if (CODE.filter((r) => r.test(s)).length >= 2) return 'code';
  return MATH.test(s) ? 'math' : '';
}

// The one-key route: a question from the other side heard in the last minute and not answered yet goes to Answer; else a
// code or math problem on the shared screen goes to Solve; else a shared screen goes to Explain; else Answer.
// Returns { action, why, line? }.
export const ASSIST_WINDOW_MS = 60_000;
export function routeAssist({ transcript = [], now = Date.now(), answeredAt = 0, screen = '', sharing = false } = {}) {
  const line = [...transcript].reverse().find((l) => l.who !== 'You' && l.t > answeredAt && now - l.t <= ASSIST_WINDOW_MS && isLikelyQuestion(l.text));
  if (line) return { action: 'answer', why: 'a question was just asked', line };
  if (sharing && screenKind(screen)) return { action: 'solve', why: screenKind(screen) === 'code' ? 'code is on the screen' : 'a problem is on the screen' };
  if (sharing) return { action: 'explain', why: 'a slide or document is on the screen' };
  return { action: 'answer', why: 'no question and no shared screen' };
}

// ---------------------------------------------------------------- slide changes

// A difference hash of a frame: the picture as 9 x 8 blocks of mean brightness (from RGBA pixels), one bit per pair of
// neighbours in a row: 1 when they differ by more than `dead` (0 to 255). The dead zone keeps flat areas, most of a
// slide, at 0 instead of flipping with compression noise.
export function blockGray(rgba, w, h, cols = 9, rows = 8) {
  const sum = new Float64Array(cols * rows);
  const n = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const k = r * cols + Math.min(cols - 1, Math.floor((x * cols) / w));
      sum[k] += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      n[k]++;
    }
  }
  return [...sum].map((s, k) => (n[k] ? s / n[k] : 0));
}
// The slide hash: those 64 edge bits (here an edge either way, |left - right| > dead), then 64 light bits, one per block
// of the first 8 columns: 1 when the block is lighter than mid-grey. Edges alone cannot tell a mostly flat slide from a
// blank or single-colour screen (seen live: a full red flash differed from a white slide by 9 edge bits); the light bits
// can. 128 bits as 32 hex digits.
export function dHash(rgba, w, h, dead = 2) {
  const g = blockGray(rgba, w, h);
  let edges = '';
  let light = '';
  for (let r = 0; r < 8; r++) {
    let e = 0;
    let l = 0;
    for (let c = 0; c < 8; c++) {
      e = (e << 1) | (Math.abs(g[r * 9 + c] - g[r * 9 + c + 1]) > dead ? 1 : 0);
      l = (l << 1) | (g[r * 9 + c] > 128 ? 1 : 0);
    }
    edges += e.toString(16).padStart(2, '0');
    light += l.toString(16).padStart(2, '0');
  }
  return edges + light;
}
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) for (let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16); x; x &= x - 1) d++;
  return d;
}

// One sampled frame into the tracker. A new screen counts only when two frames in a row agree with each other and
// differ from the current one by `threshold` bits or more, so a one-frame flicker (a notification, a cursor over a
// thumbnail, a transition frame) never counts. The change is dated at the first of those frames.
// state: { hash, cand, candT, n, samples, flickers, changes }; returns { state, change: { t, hash } | null }.
// shortcut: an 8 x 8 hash misses a change of a few words on the same layout; a finer hash or a text diff of the
// screen reads is the upgrade.
export const SLIDE = { threshold: 10, confirm: 2 };
export const SLIDE_START = { hash: '', cand: '', candT: 0, n: 0, samples: 0, flickers: 0, changes: 0 };
export function slideStep(state, hash, t, opt = SLIDE) {
  const s = { ...state, samples: state.samples + 1 };
  if (s.hash && hamming(hash, s.hash) < opt.threshold) {
    if (s.cand) s.flickers++;
    return { state: { ...s, cand: '', n: 0 }, change: null };
  }
  if (s.cand && hamming(hash, s.cand) < opt.threshold) s.n++;
  else {
    if (s.cand) s.flickers++;
    Object.assign(s, { cand: hash, candT: t, n: 1 });
  }
  if (s.n < opt.confirm) return { state: s, change: null };
  const change = { t: s.candT, hash };
  return { state: { ...s, hash, cand: '', n: 0, changes: s.changes + 1 }, change };
}

// ---------------------------------------------------------------- screen reads and pointing

// The local vision model reads each new screen once; the read is kept with its time in the meeting.
export const SCREEN_READ_PROMPT = 'This is one frame of a screen shared in a meeting. Write down what is on it, for someone who cannot see it: ' +
  'every heading, line of text, label and number, exactly as shown (keep units, currency and % signs); then, for each chart, graph, ' +
  'table or diagram, one plain sentence on what it shows (the trend, the largest and smallest values, what is compared). ' +
  'Plain text only, no commentary and no guesses. If the screen is blank or only a desktop, write: blank screen.';

// A transcript line that points at the screen. English phrases, and Arabic words with "و" or "ف" in front allowed.
// Not: where, there, hear, this morning, هناك (there), لهذا (therefore), شوفت (I saw).
const POINT_EN = /\b(?:as you (?:can |could )?(?:see|tell|notice)|you can see|(?:this|that|these|those|the) (?:chart|graph|number|figure|slide|table|diagram|line|bar|column|row|value|percentage|percent|total|curve|map|screen|box|spike|drop|peak|dip|image|picture|photo|plot|dashboard|axis)s?\b|look(?:ing)? at (?:this|that|these|the screen|the slide|here)|(?:over|right|up|down) here|\bhere\b)/i;
const POINT_AR = new Set(['هذا', 'هذه', 'هذي', 'هاذا', 'هاذي', 'هنا', 'شوف', 'شوفوا', 'شوفو', 'شوفي', 'تشوفون', 'تشوفوا', 'تشوف', 'ترون', 'تشاهدون', 'لاحظوا'].map(normalize));
export function isPointing(text) {
  const s = String(text ?? '');
  if (POINT_EN.test(s)) return true;
  return normalize(s).split(/[^\p{L}]+/u).some((w) => POINT_AR.has(w) || (/^[وف]/.test(w) && POINT_AR.has(w.slice(1))));
}

// The screen read active at time t: the latest one that appeared at or before it.
export function screenAt(screens = [], t) {
  let best = null;
  for (const s of screens) if (s.t <= t && (!best || s.t >= best.t)) best = s;
  return best;
}

// For the prompts: every screen read in time order, each with the lines that pointed at it. A pending read (the model
// has not written it yet) is left out. Over maxChars, the oldest reads go first.
export const SCREEN_CHARS = 6000;
export function screenReadsText(screens = [], lines = [], startedAt = 0, maxChars = SCREEN_CHARS) {
  const items = [...screens].filter((s) => s.text?.trim()).sort((a, b) => a.t - b.t).map((s) => `[${elapsed(s.t - startedAt)}] Screen: ${s.text.trim().replace(/\s*\n+\s*/g, ' / ')}`
    + lines.filter((l) => l.screen === s.t).map((l) => `\n  Pointed at by [${elapsed(l.t - startedAt)}] ${l.who}: ${l.text}`).join(''));
  const kept = [];
  let n = 0;
  for (const it of items.reverse()) { if (kept.length && n + it.length > maxChars) break; kept.unshift(it); n += it.length; }
  return kept.length ? `What the shared screen showed, read by Maverick each time it changed, oldest first. The time is when that screen appeared; cite it like a transcript line. Lines that point at the screen ("this number", "as you can see") mean what was on it then:\n${kept.join('\n')}` : '';
}

// ---------------------------------------------------------------- earlier meetings

// The last n meetings in History with notes (not this one), newest first: E1 is earlierMeetings(...)[0].
export const earlierMeetings = (list = [], currentId = '', n = 3) => list.filter((m) => m.id !== currentId && String(m.summary ?? '').trim()).sort((a, b) => b.startedAt - a.startedAt).slice(0, n);
// Their notes, each cut to maxChars. A time in them ([00:20]) is that meeting's, not this one's, so each is written with
// its meeting's tag ([E1 00:20]) and cited that way; markdown.mjs (linkCites) turns those into links to that meeting.
export function earlierMeetingsText(list = [], currentId = '', n = 3, maxChars = 1500) {
  const prev = earlierMeetings(list, currentId, n);
  if (!prev.length) return '';
  return 'Earlier meetings, from my History, newest first. Background only: they are not this meeting. A time in them belongs to that meeting: ' +
    'cite it with the meeting\'s tag exactly as written, like [E1 00:20], never as a bare [00:20], which means this meeting:\n'
    + prev.map((m, i) => {
      const s = m.summary.trim().replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, `[E${i + 1} $1]`);
      return `### Earlier meeting E${i + 1}: ${m.title} (${new Date(m.startedAt).toISOString().slice(0, 10)})\n${s.length > maxChars ? `${s.slice(0, maxChars)}...` : s}`;
    }).join('\n\n');
}

// ---------------------------------------------------------------- remote desktop

// A Remote Desktop session (SESSIONNAME "RDP-Tcp#3", or GetSystemMetrics(SM_REMOTESESSION) not 0): what the remote
// viewer sees is drawn by the RDP client, so hiding from screen capture on this PC does not reach it.
export const isRemoteSession = ({ sessionName = '', metric = 0 } = {}) => /^rdp-/i.test(String(sessionName)) || (Number(metric) || 0) !== 0;
