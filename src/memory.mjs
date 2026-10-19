// Memory (pure helpers): the vault is a folder of plain Markdown notes, Obsidian-compatible (desktop/main.cjs keeps it in
// <userData>/memory). One note per finished meeting and one per homework run, each with YAML frontmatter (type, date,
// tags) and [[Name]] links to pages for the people, subjects and decisions in it. Here: note names, the frontmatter, the
// links and backlinks, the graph and its force layout, the notes as markdown, the entity prompt's reply, and the notes as
// chunks for the library ranking (library.mjs). Plain data in and out; no DOM, no storage.

import { chunkPage, tokens } from './library.mjs';
import { escapeHtml } from './markdown.mjs';
import { extractActionItems, markedText } from './meetings.mjs';
import { elapsed } from './prompts.mjs';

// ---------------------------------------------------------------- names, frontmatter, links

// A note's name is its file name, so only what Windows takes in one: a time's ":" becomes "-", the rest of \ / : * ? " < > |
// goes, and so do the characters Obsidian reads as link syntax (# ^ [ ] |) and quotes. At most `max` characters, cut at a word.
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;
export function noteName(s, max = 80) {
  let t = String(s ?? '').replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,;]\s*\d{1,2}:\d{2}(?::\d{2})?)*\]/g, ' ') // [mm:ss] citations
    .replace(/(\d):(\d)/g, '$1-$2').replace(/[\\/:*?"<>|#^[\]'‘’“”&\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') || t.slice(0, max);
  t = t.replace(/^[.\s-]+|[.\s-]+$/g, '');
  return RESERVED.test(t) ? `${t} note` : t;
}
// Links match a note whatever their case, as in Obsidian; the HTML escapes and curly quotes of a rendered name are undone.
export const noteKey = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;|[‘’]/g, '\'').replace(/&quot;|[“”]/g, '"').trim().toLowerCase();

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export function parseFrontmatter(text) {
  const m = String(text ?? '').match(FRONT);
  if (!m) return { data: {}, body: String(text ?? '') };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    data[kv[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : v.replace(/^["']|["']$/g, '');
  }
  return { data, body: String(text).slice(m[0].length) };
}
export const tagOf = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
export function frontmatter({ type, date, tags = [] }) {
  return `---\ntype: ${type}\ndate: ${date}\ntags: [${[...new Set(tags.map(tagOf).filter(Boolean))].join(', ')}]\n---\n`;
}
// A local date, YYYY-MM-DD.
export const dateOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The notes a text links to: [[Name]], [[Name|shown text]] and [[Name#heading]] all link to Name. Each once, in order.
const WIKI = /\[\[([^[\]\n]+?)\]\]/g;
export function parseLinks(text) {
  const out = new Map();
  for (const m of String(text ?? '').matchAll(WIKI)) {
    const name = m[1].split('|')[0].split('#')[0].trim();
    if (name && !out.has(noteKey(name))) out.set(noteKey(name), name);
  }
  return [...out.values()];
}

// { name, key, text, type, date, tags, body, links, mtime }
export function parseNote(name, text, mtime = 0) {
  const { data, body } = parseFrontmatter(text);
  return { name, key: noteKey(name), text, body, type: data.type || 'note', date: data.date || '', tags: Array.isArray(data.tags) ? data.tags : [], links: parseLinks(body), mtime };
}

// What links to each note: note key -> the names of the notes that link to it, sorted, never the note itself.
export function backlinkIndex(notes) {
  const idx = new Map();
  for (const n of notes) {
    for (const l of n.links) {
      const k = noteKey(l);
      if (k === n.key) continue;
      if (!idx.has(k)) idx.set(k, []);
      if (!idx.get(k).includes(n.name)) idx.get(k).push(n.name);
    }
  }
  for (const v of idx.values()) v.sort((a, b) => a.localeCompare(b));
  return idx;
}

// ---------------------------------------------------------------- the graph

// Nodes are the notes; an edge is a link between two notes that exist, once per pair.
export function graphOf(notes) {
  const at = new Map(notes.map((n, i) => [n.key, i]));
  const seen = new Set();
  const edges = [];
  notes.forEach((n, i) => {
    for (const l of n.links) {
      const j = at.get(noteKey(l));
      if (j === undefined || j === i) continue;
      const id = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(id)) { seen.add(id); edges.push([i, j]); }
    }
  });
  const degree = notes.map(() => 0);
  for (const [a, b] of edges) { degree[a]++; degree[b]++; }
  return { nodes: notes.map((n, i) => ({ name: n.name, type: n.type, degree: degree[i] })), edges };
}

// A small force layout (Fruchterman and Reingold): every pair pushes apart, every edge pulls together, a pull to the
// centre keeps unlinked notes in view, and the step cools. It starts from a circle, so the same notes lay out the same.
// Returns [{ x, y }] inside w x h with `pad` to spare. shortcut: O(n^2) per step; fine for a few hundred notes, a
// quadtree (Barnes-Hut) is the upgrade for thousands.
export function forceLayout(n, edges, { w = 680, h = 520, pad = 40, iters = 300 } = {}) {
  if (!n) return [];
  const k = Math.sqrt(((w - 2 * pad) * (h - 2 * pad)) / n) * 0.75;
  const p = Array.from({ length: n }, (_, i) => ({ x: w / 2 + (Math.min(w, h) / 3) * Math.cos((2 * Math.PI * i) / n), y: h / 2 + (Math.min(w, h) / 3) * Math.sin((2 * Math.PI * i) / n) }));
  let temp = w / 8;
  for (let it = 0; it < iters; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        if (!dx && !dy) { dx = 0.01 * (i - j); dy = 0.01; }
        const dist = Math.hypot(dx, dy);
        const f = (k * k) / dist;
        d[i].x += (dx / dist) * f; d[i].y += (dy / dist) * f;
        d[j].x -= (dx / dist) * f; d[j].y -= (dy / dist) * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = p[a].x - p[b].x;
      const dy = p[a].y - p[b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = (dist * dist) / k;
      d[a].x -= (dx / dist) * f; d[a].y -= (dy / dist) * f;
      d[b].x += (dx / dist) * f; d[b].y += (dy / dist) * f;
    }
    for (let i = 0; i < n; i++) {
      d[i].x += (w / 2 - p[i].x) * 0.05 * k / 10;
      d[i].y += (h / 2 - p[i].y) * 0.05 * k / 10;
      const len = Math.hypot(d[i].x, d[i].y) || 1;
      p[i].x = Math.min(w - pad, Math.max(pad, p[i].x + (d[i].x / len) * Math.min(len, temp)));
      p[i].y = Math.min(h - pad, Math.max(pad, p[i].y + (d[i].y / len) * Math.min(len, temp)));
    }
    temp = Math.max(1, temp * 0.97);
  }
  return p;
}

// ---------------------------------------------------------------- the notes

// The entity prompt's reply (prompts.mjs, buildEntityPrompt): the first JSON object in it, with lists of short names only.
export function parseEntities(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  let o = {};
  try { o = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : {}; } catch { o = {}; }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => noteName(x, 60)).filter((x) => x.length > 1) : []);
  return { people: list(o.people).filter((x) => !NOT_A_PERSON.test(x)).slice(0, 8), subjects: list(o.subjects).slice(0, 5) };
}
const NOT_A_PERSON = /^(?:speaker \d+|you|me|unknown|someone|everyone|the (?:team|class|teacher|students?))$/i;

// The items under a "## Decisions" (or Action items) heading of the meeting notes, without their [mm:ss] citations.
export function sectionItems(md, heading) {
  const sec = String(md ?? '').split(/^#{1,4}\s+/m).find((s) => heading.test(s)) || '';
  return sec.split('\n').map((l) => l.match(/^\s*[-*+]\s+(?:\[[ x]\]\s+)?(.+)$/i)?.[1]).filter(Boolean)
    .map((l) => l.replace(/\[\d{1,2}:\d{2}[^\]]*\]/g, '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()).filter((l) => l && !/^none noted\.?$/i.test(l));
}

// Without the model: the people are the speakers who have a name, the decisions those in the notes (they are checked
// against the transcript there, meetings.mjs groundNotes). The model adds people named in what was said, and subjects.
export function meetingEntities(m, ai = { people: [], subjects: [] }) {
  const uniq = (xs) => [...new Map(xs.filter(Boolean).map((x) => [noteKey(x), x])).values()];
  const speakers = uniq((m.transcript || []).map((l) => noteName(l.who, 60)).filter((w) => w && !NOT_A_PERSON.test(w)));
  const same = (a, b) => noteKey(a).includes(noteKey(b)) || noteKey(b).includes(noteKey(a)); // "Huda Salem" is the speaker "Dr Huda Salem"
  return {
    people: [...speakers, ...uniq(ai.people).filter((p) => !speakers.some((s) => same(s, p)))].slice(0, 12),
    subjects: uniq(ai.subjects).slice(0, 5),
    decisions: uniq(sectionItems(m.summary, /^(?:decisions|القرارات)/i).map((d) => noteName(d, 60))).slice(0, 8),
  };
}

const links = (names) => names.map((n) => `[[${n}]]`).join(', ');
const EXCERPT_CHARS = 6000;
// One finished meeting: its notes (without the sections written again below), the decisions as links, the action items,
// and the transcript from the start up to EXCERPT_CHARS.
export function meetingNote(m, ents) {
  const date = dateOf(m.startedAt);
  const mins = Math.max(1, Math.round(((m.endedAt ?? m.startedAt) - m.startedAt) / 60000));
  const notes = String(m.summary ?? '').split(/(?=^#{1,4}\s)/m).filter((s) => !/^#{1,4}\s+(?:decisions|action items|flagged moments|القرارات|المهام)/i.test(s)).join('').trim()
    .replace(/^#{1,4}\s+(?:summary|الملخص|ملخص)\s*\n+/i, ''); // under this note's own Summary heading
  const lines = [];
  let size = 0;
  for (const l of m.transcript || []) {
    const s = `- **${elapsed(l.t - m.startedAt)} ${l.who}:** ${markedText(l)}`;
    if (size + s.length > EXCERPT_CHARS) break;
    lines.push(s);
    size += s.length;
  }
  const more = (m.transcript?.length || 0) - lines.length;
  const actions = extractActionItems(m.summary);
  return [
    frontmatter({ type: 'meeting', date, tags: ['meeting', ...ents.subjects] }) + `# ${m.title}`,
    '',
    `${date}, ${mins} min, ${m.transcript?.length || 0} lines.`,
    ...(ents.people.length ? ['', `People: ${links(ents.people)}`] : []),
    ...(ents.subjects.length ? ['', `Subjects: ${links(ents.subjects)}`] : []),
    '', '## Summary', '', notes || '*No summary.*',
    '', '## Decisions', '', ...(ents.decisions.length ? ents.decisions.map((d) => `- [[${d}]]`) : ['None noted.']),
    '', '## Action items', '', ...(actions.length ? actions.map((a) => `- [ ] ${a}`) : ['None noted.']),
    '', '## Transcript excerpt', '', ...(lines.length ? lines : ['_Empty._']), ...(more > 0 ? ['', `_${more} more lines in History._`] : []),
    '',
  ].join('\n');
}

// A memory citation [Name p.N] (the label of a note's chunk, library.mjs label) as a link to that note.
const LABEL = /\[([^[\]\n]{1,200}?) p\.(\d{1,4})\]/g;
export const labelsToLinks = (text, names) => {
  const keys = new Set(names.map(noteKey));
  return String(text ?? '').replace(LABEL, (m, name) => (keys.has(noteKey(name)) ? `[[${name}]]` : m));
};

// One homework run: each question with its draft as it stands (citations of past meetings become links), or what was
// missing. `uses`: the meeting notes it drew on.
export function homeworkNote(ws, ents, uses, at = Date.now()) {
  const date = dateOf(at);
  const out = [frontmatter({ type: 'homework', date, tags: ['homework', ...ents.subjects] }) + `# Homework: ${ws.name}`, '', `${date}, ${ws.items.length} question${ws.items.length === 1 ? '' : 's'}, answers in ${ws.lang}.`];
  if (ents.subjects.length) out.push('', `Subjects: ${links(ents.subjects)}`);
  if (uses.length) out.push('', `From the lectures: ${links(uses)}`);
  for (const it of ws.items) {
    out.push('', `## ${it.n}. ${String(it.q).replace(/\s*\n\s*/g, ' ')}`, '');
    out.push(it.a?.trim() ? labelsToLinks(it.a.trim(), uses) : it.notFound ? `Not in your material. ${it.notFound.missing || ''}`.trim() : '(No draft yet.)');
  }
  return `${out.join('\n')}\n`;
}

// An entity page when it is first made, and the line each note adds to it (appended, never rewritten).
export const entityPage = (name, type) => `${frontmatter({ type, date: '', tags: [type] }).replace('date: \n', '')}# ${name}\n\n## Mentioned in\n\n`;
export const entityLine = (source, date) => `- [[${source}]]${date ? ` (${date})` : ''}\n`;

// ---------------------------------------------------------------- reading the notes

// The notes as chunks for the library ranking (library.mjs, rankChunks): the body without frontmatter, page 1, so a
// citation is [Name p.1] and names the note.
export const noteChunks = (notes) => notes.flatMap((n) => chunkPage(n.body, 1).map((c, i) => ({ ...c, id: `mem:${n.name}:${i}`, name: n.name, tokens: tokens(c.text) })));

// Rendered note HTML (already escaped by renderMarkdown): [[Name]] and [[Name|text]] become buttons that open the note,
// or a dimmed name when there is no such note yet.
export function wikiHtml(html, find) {
  return String(html).replace(/\[\[([^[\]<>\n]+?)\]\]/g, (m, inner) => {
    const [target, shown] = inner.split('|');
    const name = target.split('#')[0].trim();
    const n = find(name);
    const text = (shown ?? target).trim();
    return n ? `<button type="button" class="wikilink" data-note="${escapeHtml(n.name)}">${text}</button>` : `<span class="wikilink missing" data-tip="No note named ${name} yet">${text}</span>`;
  });
}
// A memory citation in an answer (rendered HTML): a chip with the note's name that opens it.
export function memChips(html, find) {
  return String(html).replace(LABEL, (m, name) => {
    const n = find(name);
    return n ? `<button type="button" class="cite src mem" data-cmd="note" data-note="${escapeHtml(n.name)}" data-tip="Open the note ${escapeHtml(n.name)}">${escapeHtml(n.name)}</button>` : m;
  });
}
