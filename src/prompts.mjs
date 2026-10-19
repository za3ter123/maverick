// Pure prompt builders and transcript helpers. Every function returns plain data.
import { bm25, tokens } from './library.mjs';

// Models echo instruction words into the transcript ("verbatim", then "exactly" when tried), so the prompt has
// no such adverb. A freer rewording ("Write down exactly the words spoken...") made gemma4 stream nothing for 30 s.
export const TRANSCRIBE_PROMPT =
  'Transcribe this audio. Output only the spoken words, with no labels, ' +
  'timestamps, quotes, translations or commentary. If there is no intelligible speech, output nothing.';

// The meeting prompt: the plain one, the language hint, keep each word's language, speaker turns, [overlap],
// [unclear], then spelling hints last. Measured with test/wer.mjs; gemma4 is touchy here. Stressing "Arabic script"
// made it add Arabic translations of English speech or write English speech in Arabic, and short prompts
// ("Transcribe this audio.") made it chat instead of transcribe. The plain prompt is the retry after a refusal.
export const DEFAULT_LANGUAGES = 'Arabic (often Gulf dialect), English, or both mixed in one sentence';
export function transcribePrompt({ languages = '', vocab = [] } = {}) {
  return [
    TRANSCRIBE_PROMPT,
    `The speakers usually speak ${languages.trim() || DEFAULT_LANGUAGES}.`,
    'Write each word in the language it was spoken in; never add a translation.',
    'Put each speaker turn on its own line. If two people talk at the same time, begin each of their lines with [overlap].',
    'Write [unclear] for a word you cannot make out, instead of guessing.',
    vocab.length ? `Names and terms that may come up, spelled like this: ${vocab.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

export const SYSTEM_PROMPT =
  'You are Maverick, a meeting copilot. The user can see you on their own screen during a live meeting. ' +
  'Transcript lines start with the time since the meeting began, like [12:40], and are labeled "You" (the user) ' +
  'or with a meeting speaker such as "Meeting" or "Speaker 2" (estimated from the voice, so it can be wrong). ' +
  'Lines can be in Arabic, English or both. [unclear] marks words the transcriber could not make out: never guess them. ' +
  '[overlap] marks people talking at the same time. When a point comes from a specific line, cite its time in square brackets ' +
  'at the end of that sentence, after its full stop, like this. [12:40] ' +
  'Be brief and concrete. Use short markdown: bullets, bold for key terms. ' +
  // Reads like a person, not a chatbot: no lead-in, no label-led bullets, and a reply to say is plain speech.
  'Start with the answer itself, never with a lead-in line such as "Here is a draft". Never start a bullet with a bold label. ' +
  'When I ask for a reply or words to say, write plain first-person sentences I can say aloud, with no headings, labels or bullets. ' +
  'Never invent facts that are not in the ' +
  'transcript or on the screen; say so when you are unsure.';

export const RECENT_MS = 2 * 60 * 1000;
export const MAX_TRANSCRIPT_CHARS = 24000;
export const PART_CHARS = 20000;

export const ACTIONS = {
  answer: 'Answer',
  explain: 'Explain screen',
  solve: 'Solve',
  followup: 'Follow-ups',
  recap: 'Recap',
  ask: 'Ask',
  summary: 'Meeting notes',
};

// Elapsed time as mm:ss, or h:mm:ss past the first hour. The UI and the prompts use the same format.
export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// One transcript line for a prompt. A line that pointed at the shared screen says which screen read it means.
const lineOut = (l, startedAt) => `[${elapsed(l.t - startedAt)}] ${l.who}: ${l.text}${l.screen ? ` (pointing at the screen shown at [${elapsed(l.screen - startedAt)}])` : ''}`;
export function formatTranscript(lines, since = 0, startedAt = lines[0]?.t ?? 0) {
  const text = lines.filter((l) => l.t >= since).map((l) => lineOut(l, startedAt)).join('\n');
  if (!text) return '(No transcript yet.)';
  return text.length > MAX_TRANSCRIPT_CHARS ? '...' + text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

// When formatTranscript has to cut, the time of the oldest line it still shows in full; otherwise null.
export function coveredSince(lines, startedAt = lines[0]?.t ?? 0) {
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lineOut(lines[i], startedAt).length + 1;
    if (size > MAX_TRANSCRIPT_CHARS) return lines[i + 1]?.t ?? null;
  }
  return null;
}

// Consecutive groups of lines, each under maxChars of text, for summarizing long meetings in parts.
export function splitTranscript(lines, maxChars = PART_CHARS) {
  const parts = [];
  let part = [];
  let size = 0;
  for (const l of lines) {
    const n = l.who.length + l.text.length + 12;
    if (part.length && size + n > maxChars) { parts.push(part); part = []; size = 0; }
    part.push(l);
    size += n;
  }
  if (part.length) parts.push(part);
  return parts;
}

const TASKS = {
  answer: 'Start with the exact words I should say next: one to three sentences, no preamble, no label, no quotes. ' +
    'Then a blank line and at most three short bullets of supporting facts, each a plain sentence with no bold label in front. ' +
    // a model without the fact wrote "I'll get you that door code right after we finish this point" (ghost pass 3)
    'Never stall or promise to come back to it later; give the answer itself. If nothing said in this meeting or shown on the screen answers it, say that plainly in one sentence.',
  explain: 'Explain what is on the shared screen in plain words, then list anything on it that matters for this conversation.',
  // The order the owner asked for: the answer, then short working; for code the full code, then its complexity.
  solve: 'Find the problem on the shared screen: code to write, a bug, a math or logic question, a form to fill, or an error message. ' +
    'Solve it. Never restate or describe the problem. Start with the answer itself in one or two lines, then the working in a few short steps. ' +
    'For code, the first line is the approach in a few words, like "Hash map, one pass, O(n)."; then the full code in one fenced code block, ' +
    'then its time and space complexity in big-O on one line, like "Time O(n), space O(n)." ' +
    'If there is no problem on the screen, say so in one line.',
  followup: 'Suggest three to five sharp follow-up questions I could ask next. One line each.',
  recap: 'Recap the meeting so far in at most eight short bullets.',
  summary: 'Write meeting notes in markdown with exactly these sections:\n## Summary\n## Decisions\n## Action items\n' +
    'Action items use "- [ ] owner: task (due date if mentioned)". Write "None noted." for an empty section. ' +
    'List only decisions and tasks someone actually stated, in their words; never infer one. End each decision and action item with the time of the line that states it, like [12:40]. ' +
    'A decision needs a line where someone decides or agrees, in words like "we decided", "agreed", "let\'s go with", "قررنا" or "اتفقنا". ' +
    'A stated fact ("Sarah owns the supplier contract", "the lease ends March 3rd") or a need ("we need a new offer", "نحتاج عرضاً جديداً") is not a decision. ' +
    'Never write that the team agreed or decided something unless a line says so.',
};

// Each flag carries the lines heard within 15 s of it, so the notes can say what was said then. When nothing was
// transcribed that close, it carries the nearest line before and after it instead, with their times, so the notes still
// say what was being said around it (a quiet window is not "no speech").
export const FLAG_WINDOW_MS = 15_000;
const flagText = (flags, startedAt, lines) => (flags.length
  ? `\n\nThe user flagged these moments as important:\n${flags.map((t) => {
    const near = lines.filter((l) => Math.abs(l.t - t) <= FLAG_WINDOW_MS);
    if (near.length) return `- [${elapsed(t - startedAt)}] ${near.map((l) => `${l.who}: ${l.text}`).join(' / ')}`;
    const around = [lines.filter((l) => l.t < t).at(-1), lines.find((l) => l.t > t)].filter(Boolean).map((l) => `[${elapsed(l.t - startedAt)}] ${l.who}: ${l.text}`);
    return `- [${elapsed(t - startedAt)}] ${around.length ? `(a pause; the nearest lines) ${around.join(' / ')}` : '(nothing was transcribed in this meeting)'}`;
  }).join('\n')}\n` +
    'Do not write a "Flagged moments" section: Maverick adds it from the transcript. Where a flagged moment matters, say why in the Summary.'
  : '');

// The line a flag at time t belongs to: the one being spoken then (the latest line that started at most 15 s before
// it), or else the nearest line. Its index in lines, or -1.
export function flagLine(lines, t) {
  let best = -1;
  lines.forEach((l, i) => { if (best < 0 || Math.abs(l.t - t) < Math.abs(lines[best].t - t)) best = i; });
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].t <= t) return t - lines[i].t <= FLAG_WINDOW_MS ? i : best;
  return best;
}

// A typed question about the whole meeting ("Who will send the budget?" nine minutes in): the lines before `before`
// that share the most words with the question (BM25 over Arabic-aware tokens, library.mjs), at most `max` of them and
// about EARLIER_LINE_CHARS, in time order. [] when none match.
export const EARLIER_LINE_CHARS = 4000;
export function relevantLines(lines, question, before, max = 12) {
  const pool = lines.filter((l) => l.t < before);
  const q = tokens(question);
  if (!pool.length || !q.length) return [];
  const score = bm25(q, pool.map((l) => tokens(l.text)));
  let n = 0;
  return pool.map((l, i) => [l, score[i]]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).slice(0, max)
    .filter(([l]) => (n += l.text.length + l.who.length + 12) <= EARLIER_LINE_CHARS).map(([l]) => l).sort((a, b) => a.t - b.t);
}

// Returns chat messages: [{role:'system'}, {role:'user'}].
// partNotes replaces the transcript for the final pass over a long meeting. screens: the screen reads as text
// (copilot.mjs, screenReadsText). earlier: the earlier meetings' notes, used by Answer, Ask and Follow-ups. style: the
// user's style rules from Settings, for every answer but the notes. question with Answer: the question the other side
// just asked (caught in the ask field), so the answer is to that one.
export const EARLIER_ACTIONS = new Set(['answer', 'ask', 'followup']);
// prior: the text of the meeting's latest answer, so a Recap after Arabic answers stays in Arabic (replyLanguage).
export function buildPrompt(action, { transcript = [], question = '', now = Date.now(), hasImage = false, startedAt, flags = [], partNotes = '', answerLang = 'auto', screens = '', earlier = '', style = '', prior = '' } = {}) {
  if (!(action in ACTIONS)) throw new Error(`Unknown action: ${action}`);
  const start = startedAt ?? transcript[0]?.t ?? now;
  // Ask (a typed question) may be about anything said in the meeting: the whole transcript when it fits, otherwise the
  // latest part plus the earlier lines that match the question. Answer to a caught question has the same reach: it may
  // ask about something said minutes before ("Who owns the supplier contract?"), so it is not cut to the last 2 minutes.
  const asked = action === 'ask' || (action === 'answer' && !!question.trim());
  const full = action === 'recap' || action === 'summary' || action === 'followup' || asked;
  // The recent window ends at the last line heard, so a paused or reloaded meeting still has context.
  const recentFrom = Math.min(now, transcript.at(-1)?.t ?? now) - RECENT_MS;
  const parts = [];
  if (earlier && EARLIER_ACTIONS.has(action)) parts.push(earlier);
  const shownFrom = partNotes || !asked ? null : coveredSince(transcript, start);
  const found = shownFrom === null ? [] : relevantLines(transcript, question, shownFrom);
  if (found.length) parts.push(`Earlier lines of this meeting that may answer the question:\n${found.map((l) => lineOut(l, start)).join('\n')}`);
  const shown = formatTranscript(transcript, full ? 0 : recentFrom, start);
  // No lines: a plain sentence, not a placeholder in the transcript's place, which a model cited as "[لا يوجد نص سابق]".
  parts.push(partNotes
    ? `Notes from each part of the meeting, in order:\n${partNotes}`
    : shown === '(No transcript yet.)' ? 'There are no transcript lines for this, so there is nothing to cite: write no time and no note in square brackets.'
      : `${!full ? 'Transcript, last 2 minutes' : found.length ? 'Transcript, the latest part' : 'Transcript so far'}:\n${shown}`);
  if (screens) parts.push(screens);
  if (hasImage) parts.push('The attached image is the current frame of the shared meeting screen.');
  parts.push(action === 'ask' ? `My question: ${question.trim()}`
    : TASKS[action] + (action === 'summary' ? flagText(flags, start, transcript) : '')
      + (action === 'answer' && question.trim() ? `\nThe question to answer, just asked in the meeting: ${question.trim()}\nAnswer it from anything said in this meeting, however long ago; use the shared screen only when the question is about it.` : '')
      + (action === 'summary' && screens ? '\nUse what the shared screen showed too: put the figures and facts on it that the meeting talked about into the notes, with their time.' : ''));
  if (style.trim() && action !== 'summary') parts.push(`My style rules, follow them in this answer: ${style.trim()}`);
  const lang = replyLanguage({ action, question, transcript, answerLang, prior });
  if (lang) parts.push(lang);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Memory (memory.mjs, parseEntities): the people and subjects a meeting or a homework is about, for its [[links]].
export function buildEntityPrompt(text) {
  return [
    { role: 'system', content: 'You list who and what a note is about. Reply with one JSON object only, no other text: ' +
      '{"people": [...], "subjects": [...]}. people: the names of real people who speak or are named (never "Speaker 1", "You" or a role). ' +
      'subjects: at most 5 school subjects, courses, projects or topics, one to three words each, in Title Case. Use only what the text says; empty lists when there is none.' },
    { role: 'user', content: String(text ?? '').slice(0, 8000) },
  ];
}

export function buildPartPrompt(lines, i, n, startedAt) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Transcript, part ${i + 1} of ${n}:\n${formatTranscript(lines, 0, startedAt)}\n\n` +
      'Write short notes on this part: what was discussed, decisions, and action items with owners. Keep the [mm:ss] times.' },
  ];
}

// ---------------------------------------------------------------- languages

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN = /[A-Za-z\u00C0-\u024F]/g;
// Which script the letters are in: 'arabic', 'latin', 'mixed' (the smaller one has at least a quarter), or ''.
export function scriptOf(text) {
  const s = String(text ?? '');
  const a = (s.match(ARABIC) || []).length;
  const l = (s.match(LATIN) || []).length;
  if (!a && !l) return '';
  if (Math.min(a, l) / (a + l) >= 0.25) return 'mixed';
  return a > l ? 'arabic' : 'latin';
}

// The reply language. Auto: the language of the question; else, once this meeting's answers are in Arabic (the user asks
// in Arabic about an English meeting), Arabic again, notes aside; else the language of the latest lines of the meeting.
// An English meeting adds nothing, so English prompts stay as they were. Every Arabic reply gets ONE_SCRIPT.
const ONE_SCRIPT = ' Write every word in one script: never mix Arabic and Latin letters inside a word.';
export function replyLanguage({ action, question = '', transcript = [], answerLang = 'auto', prior = '' }) {
  if (answerLang && answerLang !== 'auto') return `Always reply in ${answerLang}.`;
  if (action === 'ask' && question.trim()) {
    const s = scriptOf(question);
    return s === 'arabic' ? `Reply in Arabic, the language of my question. Keep English terms as they were said.${ONE_SCRIPT}`
      : s === 'mixed' ? `Reply in the same mix of Arabic and English as my question.${ONE_SCRIPT}` : 'Reply in the language of my question.';
  }
  if (action !== 'summary' && scriptOf(String(prior).replace(/\[[^\]\n]*\]/g, '')) === 'arabic') {
    return `My earlier answers in this meeting were in Arabic: reply in Arabic, and keep English terms as they were said.${ONE_SCRIPT}`;
  }
  const s = scriptOf(transcript.slice(-12).map((l) => l.text).join(' '));
  return s === 'arabic' ? `The meeting is in Arabic: reply in Arabic, and keep English terms as they were said.${ONE_SCRIPT}`
    : s === 'mixed' ? `The meeting mixes Arabic and English: reply in the language the latest speakers use, and keep terms as they were said.${ONE_SCRIPT}`
      : '';
}

// A word with Arabic and Latin letters glued together ("50,000 دinar", seen from a deep model) is a slip: its letters in
// the other script are spelled into the reply's script (Arabic reply: "دinar" to "دينار"). Gulf usage that glues an
// Arabic article or particle to an English term ("الـbudget", "بالAPI") or an Arabic suffix after it ("APIات") is kept.
// shortcut: a letter-by-letter spelling, right for transliterated words; a model rewrite of the word is the upgrade.
const TO_AR = { sh: 'ش', kh: 'خ', th: 'ث', gh: 'غ', ch: 'تش', a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن', o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز' };
const TO_LA = { ا: 'a', أ: 'a', إ: 'i', آ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'dh', ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', و: 'w', ي: 'y', ى: 'a', ة: 'a', ء: '', ؤ: 'w', ئ: 'y', ـ: '' };
const AR_RUN = /[\u0600-\u06FF\u0750-\u077F]+/g;
const LA_RUN = /[A-Za-z]+/g;
const GLUED = /^(?:[وفبكل]?(?:ال|لل)ـ?|[وفبكل]ـ?)[A-Za-z]+$|^[A-Za-z]+ـ?(?:ات|ين|ون|ية|ه|ها)$/;
export function fixMixedScript(text) {
  const s = String(text ?? '');
  const arabicReply = scriptOf(s.replace(/\[[^\]\n]*\]|`[^`]*`/g, '')) !== 'latin';
  const spell = (run, map) => run.toLowerCase().replace(/sh|kh|th|gh|ch|[a-z]|./g, (c) => map[c] ?? c);
  return s.replace(/[\p{L}\p{M}]+/gu, (w) => {
    if (!(/[A-Za-z]/.test(w) && /[\u0600-\u06FF\u0750-\u077F]/.test(w)) || GLUED.test(w)) return w;
    return arabicReply ? w.replace(LA_RUN, (r) => spell(r, TO_AR)) : w.replace(AR_RUN, (r) => [...r].map((c) => TO_LA[c] ?? '').join(''));
  });
}

// ---------------------------------------------------------------- subtitles

// The language of a line's subtitle, or '' for none. mode: 'off', 'auto', 'English' or 'Arabic'. Auto: a line with
// more Arabic letters than Latin ones gets English, otherwise Arabic, so a mixed line gets the language it uses less.
// The Always modes skip a line already wholly in that language. [unclear] and [overlap] are not counted as English.
export const SUBTITLE_MODES = ['off', 'auto', 'English', 'Arabic'];
export function subtitleLanguage(text, mode = 'auto') {
  const s = String(text ?? '').replace(/\[(?:unclear|overlap)\]/g, '');
  const a = (s.match(ARABIC) || []).length;
  const l = (s.match(LATIN) || []).length;
  if (mode === 'off' || !SUBTITLE_MODES.includes(mode) || (!a && !l)) return '';
  if (mode === 'English') return a ? 'English' : '';
  if (mode === 'Arabic') return l ? 'Arabic' : '';
  return a > l ? 'English' : 'Arabic';
}

// One line to translate on the live model, as a subtitle. Names keep their sound, never their meaning (نبيل is a name,
// not "noble"), and numbers keep their value. The reply is the translation alone.
export function buildSubtitlePrompt(text, lang) {
  return [
    { role: 'system', content: `You write subtitles. Translate one line of a live meeting transcript into ${lang}. ` +
      'The speakers often use Gulf Arabic dialect and mix Arabic and English in one sentence; translate what they mean, in plain everyday words. ' +
      `Write every word in ${lang}, except names${lang === 'Arabic' ? ' (English words too, and every weekday and month: Thursday is الخميس, Monday is الاثنين, March is مارس, meeting is الاجتماع, deadline is الموعد النهائي)' : ''}. Keep names of people, places, companies and products as names: write them as they sound, never translate their meaning. ` +
      'Keep every number, time, date and amount with the same value. Keep [unclear] as it is. ' +
      'Reply with the translation only, on one line: no quotes, labels, notes or explanations.' },
    { role: 'user', content: String(text) },
  ];
}

// What of a reply is shown. A reasoning model can write its reasoning into the reply even with think: false: a <think>
// block, or plain notes to itself (qwen3.8:27b on an Arabic Think harder Recap: "The user wants a recap of the meeting so
// far. Constraints: ... Looks good.", in English, with no answer after it). Both are dropped; '' when nothing else is left.
// shortcut: the plain-notes case is caught by its opening words only; a reply that starts like that is all reasoning.
const REASONING_START = /^(?:the user (?:wants|is asking|asks|asked|needs|said)|okay,? (?:so|let me|the user)|let me (?:think|check|draft|re-?read|look at|analy[sz]e)|i need to (?:answer|write|draft|recap|reply|respond|summari[sz]e|produce|figure out))\b/i;
export function stripThinking(text) {
  let s = String(text ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  const close = s.search(/<\/think>/i); // the opening tag went to the thinking channel, the rest did not
  if (close >= 0) s = s.slice(close + 8);
  s = s.replace(/^\s+/, '');
  return REASONING_START.test(s) ? '' : s;
}

// A "no transcript" placeholder a model cited as a source ("... x = 4. [لا يوجد نص سابق]", on every step of an Arabic Ask
// with no meeting running) is taken out of the shown answer.
const PLACEHOLDER = /[ \t]*[[(](?:لا (?:يوجد|توجد) (?:نص|نصوص|سجل|محضر|تفريغ|أسطر|سطور)|no (?:transcript|previous text|prior text|earlier text))[^\])\n]{0,40}[\])]/gi;
export const dropPlaceholders = (text) => String(text ?? '').replace(PLACEHOLDER, '');

// The model's reply as a subtitle, or '' when it is not one: labels, quotes, code fences and notes are removed; the line
// itself, a reply far longer than the line (commentary), or one with under 40 % of its letters in the target script is
// dropped. An Arabic subtitle may keep a few English terms, as Gulf speakers do (seen from gemma4: "budget report").
export function cleanSubtitle(out, source, lang) {
  const lines = String(out ?? '').replace(/```\w*/g, '').split(/\n+/).map((l) => l.trim())
    .filter((l) => l && !/^\(?\s*(?:note|explanation|literally|translation note)\b/i.test(l));
  const t = lines.join(' ')
    .replace(/^here(?:'s| is) (?:the |a |your )?(?:translation|subtitle)[^:]*:\s*/i, '')
    .replace(/^\**\s*(?:english|arabic|translation|subtitle|الترجمة|ترجمة)\s*(?:\([^)]*\))?\s*[:：]\s*\**\s*/i, '')
    .replace(/\s*\((?:note|literally|lit\.)[^)]*\)\s*$/i, '')
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .replace(/\b(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day\b/gi, (d) => (lang === 'Arabic' ? WEEKDAYS_AR[d.toLowerCase()] : d)) // a weekday the model left in English
    .trim();
  if (!t || t === String(source).trim() || t.length > 4 * String(source).length + 40) return '';
  const a = (t.match(ARABIC) || []).length;
  const l = (t.match(LATIN) || []).length;
  return (lang === 'English' ? l : a) >= 0.4 * (a + l) ? t : '';
}
const WEEKDAYS_AR = { sunday: 'الأحد', monday: 'الاثنين', tuesday: 'الثلاثاء', wednesday: 'الأربعاء', thursday: 'الخميس', friday: 'الجمعة', saturday: 'السبت' };

// ---------------------------------------------------------------- speaker turns, [unclear], [overlap]

const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;

// Model output to speaker turns: one per line. [overlap] anywhere in a line marks it; labels a model adds anyway
// ("- ", "Speaker 2:") are removed; each turn goes through cleanTranscript, so refusals and loops still drop.
// A turn that repeats the one before is dropped. So is a turn in the other script that is about as long as the one
// before when the chunk would then hold more than 4.5 words a second (seconds > 0): that is a translation the model
// added, not something said. Real code-switching at speaking pace is kept.
// Timestamps a model writes anyway, like [00:00:00.000] or (00:03).
const STAMP = /[[(]\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?[\])]\s*/g;
// Subtitle-style ranges a model writes over silence ("00:00:00.000 -> 00:00:01.000: [unclear]", seen in test/stt-gate.mjs).
const RANGE = /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*-+>\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*:?\s*/;

export function parseTurns(raw, seconds = 0) {
  const turns = String(raw ?? '').split(/\n+/).map((line) => {
    let t = line.replace(STAMP, '').trim().replace(RANGE, '').replace(/^[-*\u2022]\s+/, '').replace(/^(?:speaker|person|voice)\s*\d+\s*:\s*/i, '');
    const overlap = /\[overlap\]/i.test(t);
    t = cleanTranscript(t.replace(/\s*\[overlap\]\s*/gi, ' ').trim());
    return /\p{L}/u.test(t) ? { text: t, overlap } : null; // a turn with no letters ("[00:", "...") is not speech
  }).filter(Boolean);
  // An overlap takes two people: a lone [overlap] line is not one (seen live on a single "Hi").
  if (turns.filter((t) => t.overlap).length < 2) for (const t of turns) t.overlap = false;
  const total = turns.reduce((n, t) => n + wordCount(t.text), 0);
  const tooFast = seconds > 0 && total / seconds > 4.5;
  const kept = turns.filter((t, i) => {
    const prev = turns[i - 1];
    if (!prev) return true;
    if (t.text.toLowerCase() === prev.text.toLowerCase()) return false;
    const [a, b] = [scriptOf(prev.text), scriptOf(t.text)];
    const ratio = wordCount(t.text) / Math.max(1, wordCount(prev.text));
    return !(tooFast && a && b && a !== 'mixed' && b !== 'mixed' && a !== b && ratio > 0.5 && ratio < 2);
  });
  // The model labelling languages or describing the audio ("[Arabic]" on its own line, "The provided audio is a recording
  // of...") is not transcribing; those lines go, and keepTurns reads this flag (acceptance defect 3).
  return Object.defineProperty(kept, 'suspect', { value: String(raw ?? '').split(/\n+/).some((l) => LANG_LABEL.test(l.trim()) || NARRATION.test(l)) });
}

// ---------------------------------------------------------------- invented lines

// The turns of one chunk that its audio backs (acceptance defect 3). gate: speechGate (audio.mjs) of the chunk, which
// already kept chunks with too little speech from the model. A turn is dropped when
//   - it is a classic speech-model artifact ("Thank you for watching", "Subtitles by ...") or starts with a language
//     label ("[Arabic] ...": the model writing a dialogue in two languages, not transcribing). Labels or a description of
//     the audio in the reply to under 700 ms of speech drop the whole chunk (parseTurns sets turns.suspect): gemma4 heard
//     a lone "Hi team." as "[Arabic] يا هلا والله [English] Hello", while "Any questions?" (900 ms) came first and right
//     before its labelled translations;
//   - it repeats one of the last 10 lines word for word, with 4 words or more (a model looping old text);
//   - the words so far outrun the speech: over 6 words per voiced second plus 2 (fast speech is about 4);
//   - the lines so far outnumber the chunk's speech runs: a line is a sentence or a turn, each after a pause, and
//     gemma4 answered one run of "Good morning." with "How are you? I'm fine, thank you..." (seen in test/stt-gate.mjs).
// recent: the meeting's last lines ({ text }). Each kept turn gets its share of the chunk's speech, by text length, as
// start and end in samples (the speaker labels read its voice there).
const ARTIFACT = /^(?:thanks? (?:you )?(?:so much )?for watching|please (?:like and )?subscribe|subtitles? (?:by|created by)|transcri(?:bed|ption) by|captions? by|amara\.org|www\.\S+|you|اشتركوا في القناة|ترجمة\s+\S+)[.!]?$/i;
const LANG_LABEL = /^[[(]?\s*(?:arabic|english|عربي|العربية|إنجليزي|الإنجليزية)\s*[\])]|^(?:arabic|english)\s*:/i;
const normLine = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
export function keepTurns(turns, samples, gate, recent = []) {
  if (!gate?.voiced) return turns;
  const bare = (t) => t.text.replace(/\[(?:overlap|unclear)\]\s*/gi, '').trim();
  if (gate.voicedMs < 700 && (turns.suspect || turns.some((t) => LANG_LABEL.test(bare(t))))) return [];
  const said = new Set(recent.slice(-10).map((l) => normLine(l.text)).filter((t) => t.split(' ').length >= 4));
  const allowed = (6 * gate.voicedMs) / 1000 + 2;
  let words = 0;
  const kept = turns.filter((t) => {
    const text = bare(t);
    if (ARTIFACT.test(text) || LANG_LABEL.test(text) || said.has(normLine(text))) return false;
    words += wordCount(t.text);
    return words <= allowed;
  }).slice(0, Math.max(1, gate.segments || turns.length));
  const speech = gate.voiced.flatMap((v, i) => (v ? [i] : []));
  const frameLen = samples.length / Math.max(1, gate.voiced.length);
  const total = kept.reduce((n, t) => n + t.text.length, 0) || 1;
  let c = 0;
  return kept.map((t, i) => {
    const a = Math.floor((speech.length * c) / total);
    c += t.text.length;
    const b = Math.max(a + 1, Math.ceil((speech.length * c) / total));
    const start = i === 0 || !speech.length ? 0 : Math.round(speech[a] * frameLen);
    const end = i === kept.length - 1 || !speech.length ? samples.length : Math.round((speech[Math.min(b, speech.length) - 1] + 1) * frameLen);
    return { ...t, start, end };
  });
}

// ---------------------------------------------------------------- misheard words

// The live model checks one new line against the vocabulary and the lines before it, and may name up to three
// word fixes. It never rewrites the line: the app applies only fixes whose words are in the line.
export function buildFixPrompt(text, recent = [], vocab = []) {
  return [
    { role: 'system', content: 'You check one line of a live speech-to-text meeting transcript for misheard words. ' +
      'Fix a word only when you are confident it was misheard: a name or term from the vocabulary written with a similar sound, ' +
      'or a word that makes no sense where it is and sounds like one that does. Never rephrase, translate, complete, or change ' +
      'anything that could be right. Leave [unclear] alone. Reply with JSON only, like ' +
      '{"fixes":[{"from":"words as written in the line","to":"corrected words"}]}, and {"fixes":[]} when nothing is clearly wrong.' },
    { role: 'user', content: `${vocab.length ? `Vocabulary: ${vocab.join(', ')}\n\n` : ''}` +
      `Lines before it:\n${recent.map((l) => `${l.who}: ${l.text}`).join('\n') || '(none)'}\n\nLine to check:\n${text}` },
  ];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu');

// Keeps fixes that replace whole words that are in the line: at most three, each up to three words, never [tags].
export function parseFixes(out, text) {
  let j;
  try { j = JSON.parse(String(out ?? '').match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { return []; }
  const fixes = [];
  for (const f of Array.isArray(j?.fixes) ? j.fixes.slice(0, 3) : []) {
    const from = String(f?.from ?? '').trim();
    const to = String(f?.to ?? '').trim();
    if (!from || !to || from.toLowerCase() === to.toLowerCase() || /[[\]]/.test(from + to)) continue;
    if (from.split(/\s+/).length > 3 || to.split(/\s+/).length > 4 || to.length > 60) continue;
    if (wordRe(from).test(text)) fixes.push({ from, to });
  }
  return fixes;
}

// The line as pieces: plain text, and changed words that remember what was there ({ text, from, by }).
// A fix with "at" replaces the text at that index of the raw line (used for [unclear] spots, which repeat);
// otherwise the first whole-word match not already changed. Fixes that no longer match are skipped.
export function applyFixes(text, fixes = []) {
  const s = String(text);
  const spans = [];
  const free = (a, b) => spans.every(([x, y]) => b <= x || a >= y);
  for (const f of fixes) {
    let hit = null;
    if (Number.isInteger(f.at)) { if (s.startsWith(f.from, f.at)) hit = [f.at, f.at + f.from.length]; }
    else {
      for (const m of s.matchAll(new RegExp(wordRe(f.from).source, 'giu'))) {
        if (free(m.index, m.index + m[0].length)) { hit = [m.index, m.index + m[0].length]; break; }
      }
    }
    if (hit && free(...hit)) spans.push([...hit, f]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const parts = [];
  let i = 0;
  for (const [a, b, f] of spans) {
    if (a > i) parts.push({ text: s.slice(i, a) });
    parts.push({ text: f.to, from: s.slice(a, b), by: f.by || 'fix' });
    i = b;
  }
  if (i < s.length) parts.push({ text: s.slice(i) });
  return parts;
}

// ---------------------------------------------------------------- [unclear]: listen again, then the deep model

const UNCLEAR = '[unclear]';
export const unclearAt = (raw) => [...String(raw).matchAll(/\[unclear\]/g)].map((m) => m.index);
// [unclear] spots in the raw line that no fix has filled yet.
export const openUnclear = (raw, fixes = []) => unclearAt(raw).filter((i) => !fixes.some((f) => f.at === i));

// Second request on the same chunk audio, with the conversation so far. It may only fill [unclear] spots.
export function relistenPrompt(first, recent = [], vocab = []) {
  return 'Listen again; use the conversation so far to resolve unclear words. Keep a word [unclear] if still not confident. ' +
    'Change nothing else: repeat the first transcript word for word, only replacing [unclear] where the audio and the conversation make the word clear. ' +
    'Output only that one line.' +
    (vocab.length ? ` Names and terms that may come up: ${vocab.join(', ')}.` : '') +
    `\n\nConversation so far:\n${recent.map((l) => `${l.who}: ${l.text}`).join('\n') || '(none)'}\n\nFirst transcript:\n${first}`;
}

// Fills for the [unclear] spots of the first line, read from the second pass. The second pass must keep every
// other word (spacing, case and punctuation aside); if it changed anything else it is ignored. A fill of more than
// four words, or [unclear] again, is not used. Returns fixes { from: '[unclear]', to, at, by }.
export function fillUnclear(first, second, by = 'relisten') {
  const idx = unclearAt(first);
  if (!idx.length) return [];
  const norm = (s) => s.replace(/[^\p{L}\p{N}[\]]+/gu, ' ').trim();
  const segs = String(first).split(UNCLEAR).map(norm);
  const pattern = segs.map((s) => s.split(/\s+/).filter(Boolean).map(escapeRe).join(' ')).join('\\s*(.*?)\\s*');
  const m = norm(String(second).split(/\n/)[0] ?? '').match(new RegExp(`^${pattern}$`, 'iu'));
  if (!m) return [];
  return idx.map((at, k) => ({ at, fill: (m[k + 1] ?? '').trim() }))
    .filter(({ fill }) => fill && fill !== UNCLEAR && !fill.includes('[') && wordCount(fill) <= 4)
    .map(({ at, fill }) => ({ from: UNCLEAR, to: fill, at, by }));
}

// End of meeting: the deep model gets the whole transcript and fills the [unclear] spots still open.
export function buildUnclearPrompt(lines, startedAt) {
  const start = startedAt ?? lines[0]?.t ?? 0;
  const numbered = lines.map((l, i) => `L${i} [${elapsed(l.t - start)}] ${l.who}: ${l.text}`).join('\n');
  const open = lines.map((l, i) => (/\[unclear\]/.test(l.text) ? `L${i}` : '')).filter(Boolean);
  return [
    { role: 'system', content: 'You fill in [unclear] words in a meeting transcript using the whole meeting as context. ' +
      'For each listed line, give one entry per [unclear] in that line, in order: the most likely word or words, ' +
      'or [unclear] when the meeting does not make it clear. Never change anything else. ' +
      'Reply with JSON only, like {"lines":[{"n":3,"fills":["Thursday","[unclear]"]}]}.' },
    { role: 'user', content: `Transcript:\n${numbered.length > MAX_TRANSCRIPT_CHARS ? numbered.slice(-MAX_TRANSCRIPT_CHARS) : numbered}\n\nLines with [unclear]: ${open.join(', ')}` },
  ];
}

// { lineIndex: fixes } from the deep model's reply, for spots still open in each line's raw text.
export function parseFills(out, lines) {
  let j;
  try { j = JSON.parse(String(out ?? '').match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { return {}; }
  const res = {};
  for (const e of Array.isArray(j?.lines) ? j.lines : []) {
    const l = lines[e?.n];
    if (!l || !Array.isArray(e.fills)) continue;
    const raw = l.raw ?? l.text;
    const fixes = openUnclear(raw, l.fixes).map((at, k) => ({ at, fill: String(e.fills[k] ?? '').trim() }))
      .filter(({ fill }) => fill && fill !== UNCLEAR && !fill.includes('[') && wordCount(fill) <= 4)
      .map(({ at, fill }) => ({ from: UNCLEAR, to: fill, at, by: 'deep' }));
    if (fixes.length) res[e.n] = fixes;
  }
  return res;
}

// Speech models answer silence with refusals or "[no speech]", and sometimes wrap words in quotes.
const REFUSAL = /\b(as an ai|text-based ai|language model|i (?:cannot|can't|am unable to|do not have the ability to) (?:fulfill|transcribe|process|listen|hear|access|provide a transcript)|no audio (?:file |clip )?(?:was |is )?(?:provided|attached|included)|(?:provide|upload|attach) (?:the|an|a|your) (?:audio|video|media|sound)(?: or (?:audio|video|media))?(?: (?:file|clip|recording)|(?=[.!]?\s*$)))\b/i;

// The model describing the task or the audio instead of transcribing it (all seen in live runs).
const NARRATION = /\*\*|\b(?:the (?:user|speaker) (?:wants|is asking|asked)|here is the transcri|audio content:|the (?:provided|given|attached) (?:audio|clip|recording)|(?:unintelligible|no discernible|no intelligible) (?:speech|words|audio))/i;

// A speech model fed noise can loop one phrase until its token cap ("the only thing I can tell you is that
// the only thing..."). Real speech seldom says the same four words four times in one chunk.
export function isLooping(text) {
  const w = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Map();
  for (let i = 0; i + 4 <= w.length; i++) {
    const k = w.slice(i, i + 4).join(' ');
    if ((seen.get(k) || 0) + 1 >= 4) return true;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return false;
}

export function cleanTranscript(text) {
  let t = String(text ?? '').trim().replace(/^["'“]+|["'”]+$/g, '').trim();
  if (isLooping(t)) return '';
  if (/^[[(].*[\])]$/.test(t)) return '';
  if (/^(no (intelligible )?speech|silence|inaudible)\.?$/i.test(t)) return '';
  if (REFUSAL.test(t)) return '';
  if (NARRATION.test(t)) return '';
  return t.replace(/[\s,]*\bverbatim\b[.!?]?$/i, '').trim();
}

const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);

// A "You" line that mostly repeats a Meeting line from the last 15 s is the mic hearing the speakers.
export function isEcho(text, t, lines) {
  const a = new Set(words(text));
  if (a.size < 3) return false;
  return lines.slice(-6).some((l) => {
    if (l.who === 'You' || Math.abs(l.t - t) > 15000) return false; // any meeting speaker label
    const b = words(l.text);
    return b.filter((w) => a.has(w)).length / Math.max(1, Math.min(a.size, b.length)) > 0.6;
  });
}
