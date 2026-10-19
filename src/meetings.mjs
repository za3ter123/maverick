// Pure helpers for saved meetings:
// {id, title, startedAt, endedAt, transcript:[{who,text,t,sub?:{lang,text},screen?:t}], summary, flags:[t],
//  answers:[{label,question,text,at,ttfw?}], screens:[{t,hash,text}], egress (bytes sent off this PC)}.
import { tokens } from './library.mjs';
import { applyFixes, elapsed, FLAG_WINDOW_MS, flagLine, scriptOf } from './prompts.mjs';

export function searchMeetings(list, query) {
  const q = query.trim().toLowerCase();
  const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
  if (!q) return sorted;
  return sorted.filter((m) =>
    [m.title, m.summary, ...m.transcript.map((l) => l.text)].some((s) => String(s ?? '').toLowerCase().includes(q)));
}

// "- [ ] owner: task" lines from the Action items section of the notes.
export function extractActionItems(summary) {
  const sec = String(summary ?? '').split(/^#{1,4}\s+/m).find((s) => /^action items/i.test(s)) || '';
  return sec.split('\n').map((l) => l.match(/^\s*[-*+]\s+(?:\[[ x]\]\s+)?(.+)$/i)?.[1].trim()).filter(Boolean);
}

export function actionItemsMarkdown(m) {
  const items = extractActionItems(m.summary);
  return [`# Action items: ${m.title}`, '', ...(items.length ? items.map((i) => `- [ ] ${i}`) : ['None noted.']), ''].join('\n');
}

// Keep the stored history under maxChars by dropping the transcripts of the oldest meetings (notes are kept).
export function fitHistory(list, maxChars) {
  const out = list.map((m) => ({ ...m }));
  let trimmed = 0;
  const oldest = () => out.filter((m) => m.transcript.length).sort((a, b) => a.startedAt - b.startedAt)[0];
  while (JSON.stringify(out).length > maxChars && out.filter((m) => m.transcript.length).length > 1) {
    const m = oldest();
    m.transcript = [];
    m.trimmed = true;
    trimmed++;
  }
  return { list: out, trimmed };
}

// A changed word is never exported as if it was said: guesses for [unclear] and corrections are marked.
export function markedText(l) {
  if (!l.fixes?.length) return l.text;
  return applyFixes(l.raw ?? l.text, l.fixes).map((p) => (p.from === undefined ? p.text
    : p.from === '[unclear]' ? `${p.text} (guess, unclear in the audio)` : `${p.text} (corrected, heard "${p.from}")`)).join('');
}

export function meetingToMarkdown(m) {
  const at = (t) => elapsed(t - m.startedAt);
  const mins = Math.max(1, Math.round(((m.endedAt ?? m.startedAt) - m.startedAt) / 60000));
  const nearest = (t) => m.transcript[flagLine(m.transcript, t)];
  const hasFlagSection = /^#{1,4}\s+flagged moments/im.test(m.summary || '');
  const flags = hasFlagSection ? [] : (m.flags || []).map((t) => `- **${at(t)}** ${nearest(t)?.text ?? ''}`.trimEnd());
  const asked = (m.answers || []).map((a) => `### ${a.label}${a.question ? `: ${a.question}` : ''} (${at(a.at)}${a.ttfw ? `, first word in ${(a.ttfw / 1000).toFixed(1)} s` : ''})\n\n${a.text.trim()}`);
  const screens = (m.screens || []).filter((x) => x.text).map((x) => `- **${at(x.t)} Screen:** ${x.text.trim().replace(/\s*\n+\s*/g, ' / ')}`);
  const sent = m.egress === undefined ? '' : ` Sent off this PC: ${m.egress} bytes.`;
  return [
    `# ${m.title}`,
    '',
    `${new Date(m.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, ${mins} min, ${m.transcript.length} lines.${sent}`,
    '',
    m.summary?.trim() || '*No summary.*', // italic in History and in the file
    ...(flags.length ? ['', '## Flagged moments', '', ...flags] : []),
    ...(asked.length ? ['', '## Asked during the meeting', '', ...asked] : []),
    ...(screens.length ? ['', '## Shared screen', '', ...screens] : []),
    '',
    '## Transcript',
    '',
    ...(m.transcript.length ? m.transcript.map((l) => `- **${at(l.t)} ${l.who}:** ${markedText(l)}${l.screen ? ` (pointing at the screen shown at ${at(l.screen)})` : ''}${l.sub?.text ? `\n  - *${l.sub.lang}:* ${l.sub.text}` : ''}`)
      : [m.trimmed ? '_Removed to make room in history._' : '_Empty._']),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- grounded notes
// Every decision and action item in the notes must be backed by a transcript line it cites, like the Sources citation
// check (library.mjs, verifyCitations). An item is kept when it cites [mm:ss] of a line of this meeting (within 2 s)
// and at least half of its words are in the cited lines (same word, or the same first four letters: "moved" and
// "move"). An item in another script than its lines (English notes of an Arabic meeting) needs only the citation.
// A decision also needs a decision or agreement verb in a cited line ("we decided", "agreed", "let's go with", "قررنا",
// "اتفقنا"): a stated fact ("Sarah owns the supplier contract") or a need ("نحتاج عرضاً جديداً") listed as a decision was
// seen (acceptance 2, defect D). A Summary sentence that says the team agreed or decided is taken out when no line of the
// meeting has such a verb. Dropped items are counted; a section left empty says "None noted.".
// Returns { text, dropped: [item text] }.
// shortcut: word lists, not a parse; a decision said without one of these words is dropped, a rarer miss than an invented one.
export const DECIDED = /\b(?:decided?|decision|agreed?|agreement|approved?|signed off|settled on|it'?s settled|let(?:'s|’s| us)|we(?:'ll| will)? go with|going with|we chose|vote[ds]?)\b|قرر|قرّر|تقرر|تقرّر|اتفق|اتّفق|متفق|وافق|موافق|اعتمد|حسمنا|اخترنا|نمشي على|نروح على/i;
const CLAIMS_AGREEMENT = /\b(?:agreed|decided|approved|signed off|settled on|consensus)\b|اتفق|اتّفق|قرر|قرّر|وافق|اعتمد|اعتماد|توافق/i;
const NOTE_CITE = /\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,;]\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]/g;
const toSecs = (s) => s.split(':').reduce((a, n) => a * 60 + Number(n), 0);
const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
export const NOTE_SUPPORT = 0.5;
export function groundNotes(md, lines = [], startedAt = lines[0]?.t ?? 0) {
  const dropped = [];
  const anyDecided = lines.some((l) => DECIDED.test(l.text));
  const backed = (item, decision) => {
    const times = [...item.matchAll(NOTE_CITE)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).map(toSecs);
    const cited = lines.filter((l) => times.some((t) => Math.abs((l.t - startedAt) / 1000 - t) <= 2));
    if (!cited.length) return false;
    const said = cited.map((l) => l.text).join(' ');
    if (decision && !DECIDED.test(said)) return false;
    const claim = item.replace(NOTE_CITE, ' ').replace(/^\s*[-*+]\s+(?:\[[ x]\]\s+)?/i, '');
    if (scriptOf(claim) && scriptOf(said) && scriptOf(claim) !== scriptOf(said) && scriptOf(claim) !== 'mixed' && scriptOf(said) !== 'mixed') return true;
    const want = [...new Set(tokens(claim))];
    const have = tokens(said);
    return !want.length || want.filter((w) => have.some((h) => sameWord(w, h))).length / want.length >= NOTE_SUPPORT;
  };
  const out = [];
  let section = '';
  let kept = 0;
  let summary = false;
  const closeSection = () => { if (section && !kept) out.push('None noted.'); };
  for (const line of String(md ?? '').split('\n')) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      closeSection();
      section = /^(?:decisions|action items|القرارات|المهام|بنود العمل)(?![\w؀-ۿ])/i.test(h[1].trim()) ? h[1] : ''; // \b never ends an Arabic word
      summary = /^(?:summary|الملخص|ملخص)/i.test(h[1].trim());
      kept = 0;
      out.push(line);
      continue;
    }
    if (section && /^\s*[-*+]\s+/.test(line)) {
      if (/^\s*[-*+]\s+(?:\[[ x]\]\s+)?none noted\.?\s*$/i.test(line)) continue;
      if (backed(line, /^(?:decisions|القرارات)/i.test(section.trim()))) { kept++; out.push(line); } else dropped.push(line.replace(/^\s*[-*+]\s+(?:\[[ x]\]\s+)?/i, '').trim());
      continue;
    }
    if (section && /^\s*none noted\.?\s*$/i.test(line)) continue;
    if (section && line.trim()) kept++; // prose under the heading stays
    if (summary && !anyDecided && CLAIMS_AGREEMENT.test(line)) { // no line agreed to anything: the summary must not say so
      const rest = line.split(/(?<=[.!?؟])\s+/).filter((x) => !CLAIMS_AGREEMENT.test(x)).join(' ');
      if (rest.trim()) out.push(rest);
      continue;
    }
    out.push(line);
  }
  closeSection();
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), dropped };
}

// ---------------------------------------------------------------- flagged moments
// The notes' "Flagged moments" section is written here from the transcript, not by the model, which once printed a
// malformed time and a placeholder (":15:36 (nothing was transcribed...)", acceptance defects 7 and 14). One bullet per
// flag at its mm:ss: the lines said within 15 s of it (the closest three), or for a pause, the nearest line before and
// after it with their times, or a plain sentence when nothing was transcribed at all.
const flagBullet = (t, lines, startedAt) => {
  const at = (x) => elapsed(x - startedAt);
  const say = (l) => `[${at(l.t)}] ${l.who}: ${markedText(l)}`;
  const near = lines.filter((l) => Math.abs(l.t - t) <= FLAG_WINDOW_MS).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t)).slice(0, 3).sort((a, b) => a.t - b.t);
  if (near.length) return `- **${at(t)}** ${near.map(say).join(' / ')}`;
  const around = [lines.filter((l) => l.t < t).at(-1), lines.find((l) => l.t > t)].filter(Boolean);
  return around.length ? `- **${at(t)}** Nothing was said within 15 s. Nearest: ${around.map(say).join(' / ')}` : `- **${at(t)}** Nothing was transcribed in this meeting.`;
};
export function withFlagSection(md, m) {
  const kept = String(md ?? '').split(/(?=^#{1,4}\s)/m).filter((s) => !/^#{1,4}\s+flagged moments/i.test(s)).join('').trimEnd();
  if (!m.flags?.length) return kept;
  return `${kept}\n\n## Flagged moments\n${m.flags.map((t) => flagBullet(t, m.transcript, m.startedAt)).join('\n')}`;
}

// One-time rename of the old "cue.*" localStorage keys to "maverick.*". A key that already exists
// under the new name wins. The old key is removed, so this runs once. Returns the moved key names.
export function migrateStorage(storage, from = 'cue.', to = 'maverick.') {
  const moved = [];
  for (let i = storage.length - 1; i >= 0; i--) {
    const k = storage.key(i);
    if (!k?.startsWith(from)) continue;
    const nk = to + k.slice(from.length);
    if (storage.getItem(nk) === null) { storage.setItem(nk, storage.getItem(k)); moved.push(nk); }
    storage.removeItem(k);
  }
  return moved;
}
