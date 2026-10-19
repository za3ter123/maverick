// Homework (pure helpers): a worksheet's text split into its questions, the language to answer in, whether a question
// is a calculation (it then gets the Solve prompt: Numbers, Working, Answer), the draft task, the .md export, and for a
// multiple-choice form: the question with lettered options, the model's "Choice:" line, and the worksheet question a
// form question matches. Plain data in and out; no DOM, no storage.

import { enough, tokens } from './library.mjs';

// A photo or scan of a worksheet, read by the live model. The Library's prompt ("in Arabic and English") once got an
// Arabic worksheet back with an English translation under it, which made its two questions four (test/homework-proof.mjs).
export const WORKSHEET_READ_PROMPT = 'Copy all the text in this image exactly as written, in the language it is written in. ' +
  'Never translate it and never add a translation. One line per printed line, each numbered question on its own line. Output only that, with no comments.';

// Whether the Library can answer a homework question (library.mjs, enough), or a page of formulas can: such a page
// covers many topics, so one question scores lower on it. Measured with embeddinggemma on test/homework-proof.mjs's
// notes (cosine / BM25 on the best page): calculations the formula page answers 0.27 / 1.5 (a train's average speed),
// 0.33 / 1.5 (a car's speed), 0.30 / 2.3 and up to 0.48 / 5.4; science questions the notes do not answer at most
// 0.25 / 1.1 (the gas humans breathe out), 0.26 / 0.8 (water's boiling point in kelvin), 0.25 / 0 (table salt's
// formula); unrelated ones (the World Cup, the Moon, the Olympics) 0.11 / 0.8 at most. A cosine of 0.25 with BM25 of
// 1.5 or more (a rarer word of the question on the page) also counts. The grounded prompt and the citation check
// after it still turn a page that does not hold the answer into Not sure.
export const COS_HOMEWORK = 0.25;
export const BM_HOMEWORK = 1.5;
export const enoughForHomework = (ranked) => enough(ranked) || ranked.some((c) => c.cos >= COS_HOMEWORK && c.bm >= BM_HOMEWORK);

// ---------------------------------------------------------------- splitting a worksheet into questions

const NUM = '[0-9٠-٩]{1,3}';
// "1." "1)" "(1)" "1 -" "Q2" "Q2." "Question 3:" "س١" "س 2-" "السؤال ٣:" at the start of a line. With a Q or س prefix no
// punctuation is needed; a bare number needs it, and "2.4" (a decimal) is not a marker.
const NUMBERED = new RegExp(String.raw`^\s*(?:[*#>•-]+\s*)?(?:\*\*)?(?:\(\s*(${NUM})\s*\)|(?:q(?:uestion)?|سؤال|السؤال|س)\s*(${NUM})\s*[.):\-–]?|(${NUM})\s*[.):\-–](?!\d))(?:\*\*)?\s*`, 'iu');
const ORDINALS = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
const ORDINAL = new RegExp(`^\\s*السؤال\\s+(${ORDINALS.join('|')}|الاول)\\s*[:.\\-–]?\\s*`, 'u');
// "a)" "(b)" "c." and Arabic "أ)" "ب-": separate questions only when the sheet has no numbered ones; under a number
// they are parts (or options) of that question and stay in it.
const LETTERED = /^\s*(?:\(\s*([a-h]|[أابجدهوز])\s*\)|([a-h]|[أابجدهوز])\s*[).\-–](?![\p{L}\p{N}]))\s*/iu;
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));

// [{ n, text }]: n is the question's own label ("1", "2", "a"), text everything up to the next question. Lines before
// the first question (a title, "Name: ____") are dropped. With no markers at all: each line ending in ? or ؟, or else
// the whole text as one question.
export function splitQuestions(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const numbered = lines.some((l) => NUMBERED.test(l) || ORDINAL.test(l));
  const out = [];
  for (const line of lines) {
    const num = line.match(NUMBERED);
    const ord = !num && line.match(ORDINAL);
    const let_ = !num && !ord && !numbered && line.match(LETTERED);
    const m = num || ord || let_;
    if (m) {
      const n = num ? digits(num[1] ?? num[2] ?? num[3]) : ord ? String(ORDINALS.indexOf(ord[1] === 'الاول' ? 'الأول' : ord[1]) + 1) : let_[1] ?? let_[2];
      out.push({ n, text: line.slice(m[0].length) });
    } else if (out.length) out.at(-1).text += `\n${line}`;
  }
  const qs = out.map((q) => ({ n: q.n, text: q.text.replace(/\n{3,}/g, '\n\n').trim() })).filter((q) => q.text);
  if (qs.length) return qs;
  const asked = lines.map((l) => l.trim()).filter((l) => /[?؟]$/.test(l));
  if (asked.length) return asked.map((t, i) => ({ n: String(i + 1), text: t }));
  const all = String(text ?? '').trim();
  return all ? [{ n: '1', text: all }] : [];
}

// The language to answer in: the one most of the worksheet's letters are in.
export function worksheetLang(text) {
  const s = String(text ?? '');
  return (s.match(/[؀-ۿ]/g) || []).length > (s.match(/[A-Za-z]/g) || []).length ? 'Arabic' : 'English';
}

// A calculation: an operator between numbers, =, √ or π, or a word that asks for one.
const MATH = /\d\s*[-+×x*/÷^]\s*\d|[=√π]|\b(?:calculate|compute|solve|work out|evaluate|simplify|find the value|show (?:your|the) (?:working|steps))\b|احسب|أوجد|اوجد|حل المسأل/iu;
export const isMath = (q) => MATH.test(String(q ?? ''));

// My material: the task under the excerpts (library.mjs, buildGroundedPrompt). A calculation gets GROUNDED_TASKS.solve.
export const HOMEWORK_TASK = 'This is a question from my homework. From the excerpts, draft an answer that I will rewrite in my own words: ' +
  'a few clear sentences, each claim with its citation.';
// Web: the question as the existing Ask prompt takes it (prompts.mjs, buildPrompt, with library.mjs, withWeb).
export const webQuestion = (q) => (isMath(q)
  ? `Solve this homework problem: the answer first, then the working step by step.\n\n${q}`
  : `Draft an answer to this homework question that I will rewrite in my own words: a few clear sentences.\n\n${q}`);

// ---------------------------------------------------------------- export

// The worksheet as markdown: each question with its draft (as edited), "Not in your material" with what is missing,
// or that it has no draft yet. Citations stay in the text: [file p.N] labels and web links.
export function homeworkMarkdown(ws) {
  const out = [`# ${ws.name}`, ''];
  for (const it of ws.items) {
    out.push(`## ${it.n}. ${String(it.q).replace(/\s*\n\s*/g, ' ')}`, '');
    out.push(it.a?.trim() ? it.a.trim() : it.notFound ? `Not in your material. ${it.notFound.missing || ''}`.trim() : '(No draft yet.)', '');
  }
  return `${out.join('\n').trim()}\n`;
}

// ---------------------------------------------------------------- multiple-choice forms

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const CHOICE_TASK = 'This is a multiple-choice question from my homework. Pick the option the excerpts support. ' +
  'If it needs a calculation, first write the Numbers, Working and Answer lines. Then end with exactly two lines: "Choice: " and the letter of ' +
  'the option (letters separated by commas when more than one is right), then "Reason: " and one sentence with its citation. ' +
  'If the excerpts do not settle it, end with "Choice: NOT SURE" and a Reason line saying what is missing.';
export const WEB_CHOICE_TASK = 'This is a multiple-choice question from my homework. If it needs a calculation, show the short working first. ' +
  'Then end with exactly two lines: "Choice: " and the letter of the option (letters separated by commas when more than one is right), then ' +
  '"Reason: " and one sentence with the page you used as a markdown link. If you are not sure, end with "Choice: NOT SURE" and a Reason line.';

// The form question with its options lettered A, B, C..., and the worksheet's draft for it when there is one.
export function choiceQuestion(q, draft = '') {
  return `${q.text}\n${q.options.map((o, j) => `${LETTERS[j]}) ${o.label}`).join('\n')}${q.multi ? '\n(More than one option can be right.)' : ''}` +
    (String(draft).trim() ? `\n\nMy worksheet's draft answer to this question: ${String(draft).trim()}` : '');
}

// The model's last "Choice:" line as option indexes ([] for NOT SURE, or no readable letter) and its "Reason:" line.
export function parseChoice(text, n) {
  const s = String(text ?? '');
  const m = [...s.matchAll(/^[ \t*_>-]*(?:choice|الخيار)[*_\s]*[:：][*_\s]*(.+)$/gim)].at(-1);
  const reason = (s.match(/^[ \t*_>-]*(?:reason|السبب)[*_\s]*[:：][*_\s]*(.+)$/im)?.[1] ?? '').replace(/[*_`]+/g, '').trim();
  if (!m || /not\s*sure|غير\s*متأكد/i.test(m[1])) return { picks: [], reason };
  const head = m[1].replace(/[*_`]/g, '').trim().toUpperCase().replace(/^OPTIONS?\s+/, '')
    .match(/^\(?[A-Z]\)?(?:\s*(?:,|AND|&)\s*\(?[A-Z]\)?)*(?![A-Z])/)?.[0].replace(/AND/g, '') ?? '';
  return { picks: [...new Set((head.match(/[A-Z]/g) || []).map((l) => LETTERS.indexOf(l)))].filter((i) => i >= 0 && i < n), reason };
}

// Text questions: what goes in the box, on an "Answer:" line, and a "Reason:" line with the citation. The box gets only
// the answer: a citation or a link inside it is no use to the teacher (plainAnswer).
const ANSWER_SIZE = { short: 'only the answer itself, as it goes in a one-line box: a word, a number with its unit, or one short sentence',
  // "two to four sentences" alone got one sentence back for a long-answer box (test/homework-proof.mjs)
  long: 'a short paragraph of at least two and at most four full sentences, all on that one line' };
export const textTask = (long) => `This is a question from my homework form that I answer by typing. From the excerpts, write ${ANSWER_SIZE[long ? 'long' : 'short']}. ` +
  'If it needs a calculation, first write the Numbers, Working and Answer lines. End with exactly two lines: "Answer: " and the text for the box, ' +
  'then "Reason: " and one sentence with its citation. If the excerpts do not give it, end with "Answer: NOT SURE" and a Reason line saying what is missing.';
export const webTextTask = (long) => `This is a question from my homework form that I answer by typing. Write ${ANSWER_SIZE[long ? 'long' : 'short']}. ` +
  'If it needs a calculation, show the short working first. End with exactly two lines: "Answer: " and the text for the box, then "Reason: " and one ' +
  'sentence with the page you used as a markdown link. If you are not sure, end with "Answer: NOT SURE" and a Reason line.';
// Upload questions: Maverick cannot make the photo or file; it says what to put in it.
export const UPLOAD_TASK = 'This homework question asks me to upload a photo or a file, which I make myself. From the excerpts, list in a few short ' +
  'bullets what I should write or draw by hand for it (the steps, or the labels of a diagram), each with its citation.';
export const WEB_UPLOAD_TASK = 'This homework question asks me to upload a photo or a file, which I make myself. List in a few short bullets what I ' +
  'should write or draw by hand for it (the steps, or the labels of a diagram), with the pages you used as markdown links.';

export const plainAnswer = (s) => String(s ?? '').replace(/\[([^[\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1').replace(/\[[^[\]\n]*p(?:age|g)?\.?\s*\d{1,4}\]/gi, '')
  .replace(/[*_`]+/g, '').replace(/\s+([.,;:!?؟])/g, '$1').replace(/\s{2,}/g, ' ').trim();

// The model's last "Answer:" line as the text for the box ('' for NOT SURE or none), with any lines it ran on to before
// the Reason line, and its "Reason:" line. The last one: a calculation's working has an Answer line of its own before.
const REASON = /^[ \t*_>-]*(?:reason|السبب)[*_\s]*[:：][*_\s]*(.+)$/im;
export function parseTyped(text) {
  const s = String(text ?? '');
  const m = [...s.matchAll(/^[ \t*_>-]*(?:answer|الإجابة|الجواب)[*_\s]*[:：][*_\s]*(.*)$/gim)].at(-1);
  const reason = (s.match(REASON)?.[1] ?? '').replace(/[*_`]+/g, '').trim();
  // the lines between the Answer line and a Reason line after it belong to the answer; with no Reason line after it, only
  // the Answer line does (anything else there is not for the box)
  const after = m ? s.slice(m.index + m[0].length) : '';
  const stop = after.search(REASON);
  const said = m ? `${m[1]} ${stop >= 0 ? after.slice(0, stop) : ''}` : '';
  const value = plainAnswer(said);
  // a citation the model put on the Answer line instead goes with the reason: the box gets none
  const cites = (said.match(/\[[^[\]\n]*p\.\s*\d{1,4}\]/g) || []).filter((c) => !reason.includes(c));
  return { value: /^not\s*sure\b|^غير\s*متأكد/i.test(value) ? '' : value, reason: [reason, ...cites].filter(Boolean).join(' ') };
}

// Why the form cannot be submitted yet, or '': a required upload with no file (Maverick never adds one), or a required
// question still blank (Maverick was not sure, and nobody filled it in). Questions are numbered as the form shows them.
const nos = (qs) => {
  const n = qs.map((q) => q.i + 1).sort((a, b) => a - b);
  return `question${n.length > 1 ? 's' : ''} ${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]}`;
};
export const isBlank = (q) => (q.kind === 'choice' ? !q.options.some((o) => o.checked) : q.kind === 'text' ? !String(q.value ?? '').trim() : !q.files?.length);
export function formNeeds(questions) {
  const files = questions.filter((q) => q.kind === 'upload' && q.required && isBlank(q));
  const blank = questions.filter((q) => q.kind !== 'upload' && q.required && isBlank(q));
  if (!files.length && !blank.length) return '';
  const parts = [files.length && `${nos(files)} need${files.length > 1 ? '' : 's'} your photo or file`, blank.length && `${nos(blank)} ${blank.length > 1 ? 'are' : 'is'} still blank`].filter(Boolean);
  const them = (qs) => (qs.length > 1 ? 'them' : 'it');
  const todo = files.length && blank.length ? `Add ${them(files)} and answer the blank ${blank.length > 1 ? 'ones' : 'one'} in the form window`
    : files.length ? `Add ${them(files)} in the form window` : `Answer ${them(blank)} in the form window`;
  return `Can’t submit yet: ${parts.join(', and ')}. ${todo}, then type yes again.`;
}

// The worksheet question a form question is (most of the shorter one's words in common, and the same numbers: "2 kg at
// 3 m/s" is not the worksheet's "6 kg at 5 m/s"), or null.
export function matchQuestion(text, items) {
  const words = (s) => new Set(tokens(String(s).replace(NUMBERED, ''))); // a form's own "2." is not one of the numbers
  const nums = (s) => [...s].filter((t) => /^\d/.test(t)).sort().join(' ');
  const a = words(text);
  let best = null;
  let score = 0;
  for (const it of items) {
    const b = words(it.q);
    if (nums(a) !== nums(b)) continue;
    const s = [...a].filter((t) => b.has(t)).length / Math.max(1, Math.min(a.size, b.size));
    if (s > score) { score = s; best = it; }
  }
  return score >= 0.6 ? best : null;
}
