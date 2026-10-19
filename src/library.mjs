// Pure helpers for Sources and the library: Arabic-aware text normalization, chunks by page, keyword (BM25) plus
// vector ranking, the "My material only" prompt, the citation checker, the "not in your material" reply, auto
// vocabulary from the files, and a minimal .docx reader (a .docx is a zip). Plain data in and out; no DOM, no storage.

import { cosine } from './audio.mjs';
import { escapeHtml, latexMath } from './markdown.mjs';
import { scriptOf } from './prompts.mjs';

export const SOURCES = ['meeting', 'web', 'material'];
// Recap and the meeting notes always work from the meeting; these follow the Sources switch.
export const SOURCE_ACTIONS = new Set(['answer', 'ask', 'solve', 'followup']);

// ---------------------------------------------------------------- normalization and tokens

// Lower case; Arabic without tashkeel and tatweel, one alef, one yaa, taa marbuta as haa, Arabic-Indic digits as 0-9.
export function normalize(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'by', 'with',
  'at', 'it', 'its', 'this', 'that', 'what', 'which', 'who', 'when', 'where', 'how', 'why', 'do', 'does', 'did', 'i', 'you', 'we',
  'our', 'my', 'your', 'from', 'as', 'can', 'will', 'about', 'there', 'their', 'they', 'has', 'have', 'had', 'not', 'no',
  'في', 'من', 'علي', 'الي', 'عن', 'ما', 'ماذا', 'هل', 'هو', 'هي', 'و', 'ان', 'كان', 'مع', 'هذا', 'هذه', 'لا', 'كم', 'متي', 'اين', 'كيف']);
// A leading Arabic article (al-, wal-, bil-, lil-...) is dropped from words of three letters or more, so الميزانية matches ميزانية.
const ARTICLE = /^(?:وال|بال|كال|فال|لل|ال)(?=[ء-ي]{3,})/;
export function tokens(s) {
  return normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t) => t.replace(ARTICLE, ''))
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
}

// ---------------------------------------------------------------- chunks

// One page's text in chunks of about min to max characters, each cut at the end of a paragraph, a sentence or a word,
// and each starting about `overlap` characters before the end of the one before. { page, start, end, text }.
export function chunkPage(text, page, { min = 800, max = 1200, overlap = 150 } = {}) {
  const s = String(text ?? '');
  const out = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + max);
    if (end < s.length) {
      const win = s.slice(start + min, end);
      const at = [win.lastIndexOf('\n\n'), Math.max(...['. ', '? ', '! ', '؟ ', '.\n', '\n'].map((m) => win.lastIndexOf(m))), win.lastIndexOf(' ')].find((i) => i >= 0);
      if (at !== undefined) end = start + min + at + 1;
    }
    const t = s.slice(start, end).trim();
    if (t) out.push({ page, start, end, text: t });
    if (end >= s.length) break;
    const back = s.indexOf(' ', end - overlap);
    start = back > start && back < end ? back + 1 : end;
  }
  return out;
}

// pdfjs text items to one page of text: each item's string (NFKC, so Arabic presentation forms become letters), a line
// break after items that end a line. at[i] and len[i] are where item i sits in the text, so the viewer can find the
// items of a cited passage. Many PDFs list Arabic glyphs left to right as drawn; a line with Arabic is read right to
// left by position, with its Latin and number runs kept left to right.
const RTL_TEXT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_TEXT = /[A-Za-z0-9À-ɏ]/;
export function joinItems(items) {
  let text = '';
  const at = new Array(items.length).fill(0);
  const len = new Array(items.length).fill(0);
  let line = [];
  const flush = (eol) => {
    if (line.some((i) => RTL_TEXT.test(items[i].str))) {
      line.sort((a, b) => (items[b].transform?.[4] ?? 0) - (items[a].transform?.[4] ?? 0));
      for (let j = 0; j < line.length;) {
        if (!LTR_TEXT.test(items[line[j]].str)) { j++; continue; }
        let k = j;
        for (let m = j + 1; m < line.length && !RTL_TEXT.test(items[line[m]].str); m++) if (LTR_TEXT.test(items[line[m]].str)) k = m;
        line.splice(j, k - j + 1, ...line.slice(j, k + 1).reverse());
        j = k + 1;
      }
    }
    for (const i of line) {
      const s = items[i].str.normalize('NFKC');
      at[i] = text.length;
      len[i] = s.length;
      text += s;
    }
    if (eol) text += '\n';
    line = [];
  };
  items.forEach((it, i) => {
    at[i] = text.length;
    if (typeof it?.str !== 'string') return;
    line.push(i);
    if (it.hasEOL) flush(true);
  });
  flush(false);
  return { text, at, len };
}

// ---------------------------------------------------------------- ranking

// BM25 scores of each document (an array of tokens) for the query tokens. minDocs: the IDF counts at least that many
// documents, so a word in the only chunk of a one-file library still weighs as rare (see MIN_LIBRARY_CHUNKS).
export function bm25(query, docs, k1 = 1.2, b = 0.75, minDocs = 0) {
  const n = Math.max(docs.length, minDocs);
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / Math.max(1, avg)));
    }
    return s;
  });
}

// The top k chunks for a question: keyword score (BM25, scaled so the best is 1) and the cosine of the embeddings,
// 40 to 60. Each result keeps its own scores: kw, bm (raw BM25) and cos.
// A library of one short file is one chunk, where every word is in every chunk and BM25's IDF falls to 0.29: its
// answers once scored 0.4 to 0.6 and Homework said Not in your material. The BM thresholds were measured on libraries
// of 4 chunks or more (test/homework-proof.mjs's 4 pages), so a smaller one is scored as if it had 4.
export const MIN_LIBRARY_CHUNKS = 4;
export function rankChunks(query, qvec, chunks, k = 6) {
  const bm = bm25(tokens(query), chunks.map((c) => c.tokens ?? tokens(c.text)), 1.2, 0.75, MIN_LIBRARY_CHUNKS);
  const top = Math.max(0, ...bm);
  return chunks.map((c, i) => {
    const kw = top ? bm[i] / top : 0;
    const cos = qvec && c.vec?.length === qvec.length ? cosine(qvec, c.vec) : 0; // vectors from another embedding model: keywords only
    return { ...c, kw, bm: bm[i], cos, score: 0.4 * kw + 0.6 * cos };
  }).sort((a, b) => b.score - a.score).slice(0, k);
}

// Whether the best chunks can answer at all. Measured with embeddinggemma on test/sources-proof.mjs's files: the four
// questions they answer scored 0.61 to 0.76 on their best chunk, an unrelated one (the World Cup) 0.10. A question on
// the files' topic that they cannot answer (a salary) scored 0.59, so the model's NOT FOUND line has to catch those.
// A strong keyword match (raw BM25 of 3 or more, several rare words in common) with a cosine of 0.35 also counts.
export const COS_FOUND = 0.45;
export const COS_KEYWORD = 0.35;
export const BM_FOUND = 3;
export const enough = (ranked) => ranked.some((c) => c.cos >= COS_FOUND || (c.bm >= BM_FOUND && c.cos >= COS_KEYWORD));

// ---------------------------------------------------------------- "My material only": the prompt, citations, not found

export const NOT_FOUND = 'NOT FOUND';
export const label = (c) => `[${c.name} p.${c.page}]`;

// The prompt gets only the chunks, each under its label, and the rules: answer from them, cite every claim with a
// label, no outside knowledge, and a fixed one-line reply when they do not hold the answer. The reply language is
// named outright: "the language of the question" once got a French answer to an English one.
const REPLY_IN = { arabic: 'Reply in Arabic.', latin: 'Reply in English.', mixed: 'Reply in the same mix of Arabic and English as the question.' };
export function buildGroundedPrompt({ task, question, chunks, answerLang = 'auto', style = '' }) {
  const excerpts = chunks.map((c) => `${label(c)}\n${String(c.text).trim()}`).join('\n\n---\n\n');
  return [
    { role: 'system', content: 'You are Maverick, a meeting copilot. Answer only from the excerpts of the user\'s own files given below. ' +
      'Each excerpt starts with its label, like [plan.pdf p.3]. After every claim, cite the excerpt it comes from by writing its label exactly as given. ' +
      'Never use outside knowledge, never guess, and never write a label that is not in the list. Be brief and direct; no lead-in. ' +
      // seen in the accuracy benchmark (test/accuracy-proof.mjs): a wrong premise got only NOT FOUND, a two-part question
      // with one part in the files got nothing, and arithmetic stated first was wrong although the working was right
      'If the question asks for several things and the excerpts give only some, answer those with their labels, then add one line: "Missing: " and what the excerpts do not give. ' +
      'If the answer needs a calculation, reply in exactly this order, with nothing before it: a line "Numbers:" naming each value you use with its label ' +
      '(or "from the question"; never any other value); a line "Working:" with the formula from the excerpts filled in and worked out on one line, like 1/2 × 10 × 4^2 = 80; ' +
      'a line "Answer:" with the result and its unit. Do not state any result before the Working line. When it asks how many times larger, divide. ' +
      'A question can take something for granted that the excerpts state differently (another date, number, name, winner or fact). Then do not answer the question as asked: ' +
      'say what the excerpts say about it, with its label, and do not repeat the wrong claim anywhere, not even in a Missing line. For example, asked "Why did the shop close in May?" when an excerpt says ' +
      '"The shop closed in June", reply: "The excerpts say the shop closed in June [shop.pdf p.1]." ' +
      `Only when the excerpts say nothing at all about what the question asks, reply with one line only: "${NOT_FOUND}: " followed by what is missing, in a few words.` +
      ` ${answerLang && answerLang !== 'auto' ? `Always reply in ${answerLang}.` : REPLY_IN[scriptOf(question)] ?? 'Reply in the language of the question.'}` },
    { role: 'user', content: `Excerpts:\n\n${excerpts}\n\n${task}${String(style).trim() ? `\n\nMy style rules, follow them in this answer: ${String(style).trim()}` : ''}\n\n${question}` },
  ];
}

// The tasks in this mode. Recap and the notes are not here: they are about the meeting.
export const GROUNDED_TASKS = {
  answer: 'Someone in the meeting just asked something. From the excerpts, write the words I should say: one to three sentences, each with its citation.',
  ask: 'Answer my question from the excerpts.',
  followup: 'From the excerpts, suggest three sharp follow-up questions about what is being discussed, one line each, each with the citation it builds on.',
  solve: 'Solve the problem below using only the excerpts: the answer first, then the short working, with citations.',
};

// The model's "NOT FOUND: what is missing" line, or a reply that says the excerpts lack the answer, as { missing };
// otherwise null.
export function parseNotFound(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^\W*not[ _]found[\s*_`:\-–—]*(.*)/i);
  if (m) return { missing: m[1].split('\n')[0].replace(/[*_`]/g, '').trim().slice(0, 160) };
  if (t.length < 400 && /\b(?:excerpts?|material|files?|documents?) (?:do(?:es)? not|don['’]t|doesn['’]t) (?:contain|include|mention|say|cover)|not (?:in|mentioned in|covered by) (?:the|your) (?:excerpts|material|files|documents)/i.test(t)) {
    return { missing: '' };
  }
  return null;
}

// Every citation in a reply must be the label of a chunk the prompt gave. Good ones are rewritten exactly as their
// label; any other is removed and counted. A bracket holding several ("[a.pdf p.1; a.pdf p.2]") is split first.
// Returns { text, cited: [chunks], removed }.
const CITE = /\[([^[\]\n]{1,200}?)[,\s]+p(?:age|g)?\.?\s*(\d{1,4})\]/gi;
const PAGE_REF = /p(?:age|g)?\.?\s*\d{1,4}\s*$/i;
const fileKey = (n) => normalize(n).replace(/\.(?:pdf|png|jpe?g|webp|docx|txt|md)$/, '').replace(/\s+/g, ' ').trim();
// "[a.pdf p.1; b.pdf p.2]", "[a.pdf p.1, a.pdf p.2]" and "[a.pdf p.1, p.2]" to one bracket each. A comma splits only
// when every piece ends in a page, so a file name with a comma in it is left whole.
function splitCites(inner) {
  const parts = inner.split(/\s*;\s*/).flatMap((p) => { const c = p.split(/\s*,\s*/); return c.length > 1 && c.every((x) => PAGE_REF.test(x)) ? c : [p]; });
  if (parts.length < 2) return null;
  let name = '';
  return parts.map((p) => {
    const m = p.match(/^(.*?)[,\s]*p(?:age|g)?\.?\s*(\d{1,4})\s*$/i);
    if (m?.[1].trim()) name = m[1].trim();
    return m && !m[1].trim() && name ? `[${name} p.${m[2]}]` : `[${p}]`;
  }).join('');
}
export function verifyCitations(text, chunks) {
  const cited = [];
  let removed = 0;
  const out = String(text ?? '')
    .replace(/\[([^[\]\n]+[;,][^[\]\n]+)\]/g, (m, inner) => splitCites(inner) ?? m)
    .replace(CITE, (m, name, page) => {
      const c = chunks.find((x) => fileKey(x.name) === fileKey(name) && Number(x.page) === Number(page));
      if (!c) { removed++; return ''; }
      if (!cited.includes(c)) cited.push(c);
      return label(c);
    })
    .replace(/[ \t]+([.,;:!?؟])/g, '$1');
  return { text: out, cited, removed };
}

// ---------------------------------------------------------------- the checks on a "My material only" reply

// A raw "NOT FOUND: x" line inside an answer that also has a cited part becomes "Missing: x.", so the marker never shows.
const NF_LINE = /^[ \t>*_-]*not[ _]found\b[\s*_`:\-–—]*(.*)$/gim;
export const missingLines = (text) => String(text ?? '')
  .replace(NF_LINE, (m, what) => { const w = what.replace(/[*_`]/g, '').trim().replace(/[.。]+$/, ''); return w ? `Missing: ${w}.` : ''; })
  .replace(/\n{3,}/g, '\n\n').trim();
// What the not-found card names when the model did not say: the question itself.
export const notCovered = (q) => {
  const s = String(q ?? '').trim();
  return s ? `Nothing in your files covers “${s.slice(0, 90)}${s.length > 90 ? '…' : ''}”` : 'Your files do not answer this';
};

// The whole reply as the card shows it: { notFound: { missing } } when no citation in it is one of the chunks given
// (nothing in the files backs it), otherwise { text, removed, sums } with the citations checked, NOT FOUND lines turned
// into "Missing:" lines and simple arithmetic recomputed (checkArithmetic).
export function checkGrounded(text, chunks, query = '') {
  const v = verifyCitations(text, chunks);
  if (!v.cited.length) return { notFound: { missing: parseNotFound(text)?.missing || notCovered(query) } };
  const a = checkArithmetic(missingLines(v.text));
  return { text: a.text, removed: v.removed, sums: a.fixes };
}

// Arithmetic the model wrote out, like "1/2 × 10 × 4^2 = 80": numbers, + - × x * / ÷ · ^ ² ³ and brackets only (LaTeX
// \times, \cdot, \div, \frac{a}{b} and ^{n} are read too). Each such expression is evaluated here; when its stated
// result is off by more than rounding, the computed one replaces it and a fix is returned { expr, said, got }.
// shortcut: expressions with units inside ("10 m/s^2 × 16 s^2") are not checked; a unit-aware parser is the upgrade.
const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
// Terms hold no spaces, so the spaces around each operator are the only ones and the match cannot backtrack for long.
const TERM = String.raw`\(*${NUM}[²³]?\)*`;
const OP = String.raw`(?:[+\-−×*/÷·^]|(?<=\s)x(?=\s))`;
const EXPR = new RegExp(String.raw`(?<![\w^.,²³/(]|[×*+\-−÷·]\s*)(${TERM}(?:\s*${OP}\s*${TERM})+)\s*=\s*(-?${NUM})(?![\d.,]*\d)`, 'g');
export function evalArithmetic(expr) {
  const src = latexMath(expr).replace(/,(?=\d{3}\b)/g, '').replace(/²/g, '^2').replace(/³/g, '^3').replace(/[×x·*]/g, '*').replace(/[÷/]/g, '/').replace(/−/g, '-');
  const t = src.match(/\d+(?:\.\d+)?|[-+*/^()]/g);
  if (!t || t.join('') !== src.replace(/\s+/g, '')) return null;
  let i = 0;
  const atom = () => {
    if (t[i] === '-') { i++; return -atom(); }
    if (t[i] === '(') { i++; const v = sum(); if (t[i++] !== ')') throw new Error('bracket'); return v; }
    if (!/^\d/.test(t[i] ?? '')) throw new Error('number');
    return Number(t[i++]);
  };
  const pow = () => { const b = atom(); if (t[i] === '^') { i++; return b ** pow(); } return b; };
  const prod = () => { let v = pow(); while (t[i] === '*' || t[i] === '/') v = t[i++] === '*' ? v * pow() : v / pow(); return v; };
  function sum() { let v = prod(); while (t[i] === '+' || t[i] === '-') v = t[i++] === '+' ? v + prod() : v - prod(); return v; }
  try { const v = sum(); return i === t.length && Number.isFinite(v) ? v : null; } catch { return null; }
}
const fmt = (n) => String(Math.round(n * 1000) / 1000);
export function checkArithmetic(text) {
  const fixes = [];
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(a) * 0.005);
  let last = null; // the last expression's computed result
  const s = latexMath(text).replace(/\$([^$\n]+)\$/g, '$1');
  let out = s.replace(EXPR, (m, expr, said) => {
    const got = evalArithmetic(expr);
    if (got === null) return m;
    last = { expr: expr.trim(), got };
    if (near(got, Number(said.replace(/,/g, '')))) return m;
    fixes.push({ expr: expr.trim(), said, got: fmt(got) });
    return m.slice(0, m.length - said.length) + fmt(got);
  });
  // The "Answer:" line (the grounded prompt asks for Numbers, Working, Answer) must give what the working gives: one
  // number in it that disagrees with the last checked expression is replaced, and said.
  if (last) {
    out = out.replace(/^([ \t*_]*Answer:[ \t*_]*)([^\n]*)$/im, (m, head, rest) => {
      const nums = rest.match(new RegExp(NUM, 'g')) || [];
      if (nums.length !== 1 || near(last.got, Number(nums[0].replace(/,/g, '')))) return m;
      fixes.push({ expr: last.expr, said: nums[0], got: fmt(last.got) });
      return head + rest.replace(nums[0], fmt(last.got));
    });
  }
  if (!fixes.length) return { text, fixes };
  return { text: `${out}\n\n${fixes.map((f) => `Maverick checked the arithmetic: ${f.expr} = ${f.got}, not ${f.said}.`).join(' ')}`, fixes };
}

// Rendered answer HTML (already escaped by renderMarkdown): each [file p.N] label of a chunk the prompt gave becomes
// a button that opens the viewer at that page. Anything else in brackets stays text.
// With `files` (the library's files), a label of a file still in the library opens it too, at that page when it has
// one: answers kept in History have no chunks.
export function sourceChips(html, chunks, files = []) {
  return String(html).replace(/\[([^[\]<>\n]{1,200}?) p\.(\d{1,4})\]/g, (m, name, page) => {
    const c = chunks.find((x) => escapeHtml(x.name) === name && Number(x.page) === Number(page))
      ?? files.map((f) => ({ fileId: f.id, page: Number(page), name: f.name, pages: f.pages?.length ?? 0 })).find((f) => escapeHtml(f.name) === name && f.page >= 1 && f.page <= f.pages);
    return c ? `<button type="button" class="cite src" data-cmd="src" data-file="${escapeHtml(c.fileId)}" data-page="${c.page}" data-tip="Open ${name} at page ${page}">${name} p.${page}</button>` : m;
  });
}

// Web answers: markdown links [title](https://...) and bare http(s) addresses become buttons that open the page in the
// default browser (main.cjs checks the scheme again). Only http and https; anything else stays text.
export function urlChips(html) {
  const chip = (url, text) => {
    let u;
    try { u = new URL(url.replace(/&amp;/g, '&')); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `<button type="button" class="cite url" data-cmd="url" data-url="${escapeHtml(u.href)}" data-tip="${escapeHtml(u.href)}">${text && !/https?:/i.test(text) ? text : escapeHtml(u.hostname.replace(/^www\./, ''))}</button>`;
  };
  return String(html)
    .replace(/\[([^[\]<>\n]{1,200})\]\(((?:https?):\/\/[^\s()<>]+)\)/g, (m, text, url) => chip(url, text) ?? m)
    .replace(/(^|[\s(>])(https?:\/\/[^\s<>()"]+[^\s<>()".,;:!?'])/g, (m, pre, url) => { const c = chip(url, ''); return c ? pre + c : m; });
}

// Solve with Web or My material only: the live model first writes the problem on the screen as text, which the
// library search and the web question use (Web gets no screenshot).
export const SCREEN_PROBLEM = 'Write out the problem shown on this screen as plain text: the question or task, with every number, name, code line ' +
  'and error message it needs. Output only that, with no answer and no comments.';

// Sources, Web: the meeting prompt plus the rule to search and cite pages as links.
export function withWeb(messages) {
  return messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: `${m.content}\n\nSearch the web for anything current or factual. ` +
    'Pages you find count as sources too, besides the transcript and the screen. Cite every fact from the web with the page it comes from as a markdown link, ' +
    'like [Reuters](https://www.reuters.com/...). Use only pages you found or opened.' } : m));
}

// The viewer: a page's text, escaped, with the cited passages ([start, end) ranges, overlapping or not) in <mark>.
export function markRanges(text, ranges = []) {
  const s = String(text ?? '');
  const merged = [];
  for (const r of [...ranges].map((x) => [Math.max(0, x.start), Math.min(s.length, x.end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    if (merged.length && r[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], r[1]); else merged.push(r);
  }
  let out = '';
  let i = 0;
  for (const [a, b] of merged) { out += escapeHtml(s.slice(i, a)) + `<mark>${escapeHtml(s.slice(a, b))}</mark>`; i = b; }
  return out + escapeHtml(s.slice(i));
}

// ---------------------------------------------------------------- auto vocabulary

// Names and acronyms in the files, for transcription: acronyms (2 to 6 capitals) and capitalized words that never
// appear in lower case, most frequent first, at most `cap`.
export function extractVocab(texts, cap = 30) {
  const all = texts.join('\n');
  const lower = new Set(all.match(/\b[a-z][a-z'-]+\b/g) || []);
  const count = new Map();
  for (const m of all.matchAll(/\b(?:[A-Z]{2,6}\d*|[A-Z][a-z]{2,}(?:[A-Z][a-z]+)*)\b/g)) {
    const w = m[0];
    if (/^[A-Z][a-z]/.test(w) && (lower.has(w.toLowerCase()) || STOP.has(w.toLowerCase()))) continue;
    count.set(w, (count.get(w) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cap).map(([w]) => w);
}

// ---------------------------------------------------------------- .docx

// One file out of a zip: the central directory says where it is, then it is stored or deflated (raw DEFLATE, which
// DecompressionStream reads). Returns its bytes, or null when the zip has no such file.
export async function unzipEntry(bytes, name) {
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a zip file, so it is not a .docx');
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The .docx is damaged (zip directory)');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    if (new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen)) === name) {
      const from = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = u8.subarray(from, from + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`The .docx uses zip method ${method}, which Maverick cannot read`);
      return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return null;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()]));

// word/document.xml to pages of text: one line per paragraph, tabs and line breaks kept, a new page at each explicit
// page break. A document without page breaks is one page.
export function docxPages(xml) {
  const pages = [[]];
  for (const para of String(xml).match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []) {
    let line = '';
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\s*\/>|<w:br\s[^>]*\/>/g)) {
      if (m[1] !== undefined) line += unxml(m[1]);
      else if (m[0].startsWith('<w:tab')) line += '\t';
      else if (/w:type="page"/.test(m[0])) { pages.at(-1).push(line); line = ''; pages.push([]); }
      else line += '\n';
    }
    pages.at(-1).push(line);
  }
  return pages.map((p) => p.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}
