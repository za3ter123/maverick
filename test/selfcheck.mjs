// node test/selfcheck.mjs  (stdlib asserts, no network)
import assert from 'node:assert/strict';
import { readFileSync as readRaw } from 'node:fs';
// source checks match \n; a CRLF checkout (core.autocrlf) must read the same
const readFileSync = (f, enc) => { const s = readRaw(f, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };
import { assignSpeaker, bytesToBase64, concatFloat32, cosine, downsample, encodeWav, isSilent, pitchOf, prepareChunk, rms, vadStep, VAD, VAD_START, voiceprint } from '../src/audio.mjs';
import {
  ACTIONS, applyFixes, buildPartPrompt, buildPrompt, buildSubtitlePrompt, buildUnclearPrompt, cleanSubtitle, cleanTranscript, coveredSince, elapsed, fillUnclear, formatTranscript, isEcho,
  MAX_TRANSCRIPT_CHARS, parseFills, parseFixes, parseTurns, RECENT_MS, replyLanguage, scriptOf, splitTranscript, subtitleLanguage, TRANSCRIBE_PROMPT, transcribePrompt,
} from '../src/prompts.mjs';
import { blackShare, CANARY, findCanary } from '../src/canary.mjs';
import { escapeHtml, holdOpen, latexMath, linkCites, renderMarkdown } from '../src/markdown.mjs';
import {
  blockGray, dHash, earlierMeetingsText, hamming, isLikelyQuestion, isPointing, isRemoteSession, routeAssist, screenAt, screenKind, screenReadsText, SLIDE, SLIDE_START, slideStep,
} from '../src/copilot.mjs';
import { actionItemsMarkdown, extractActionItems, fitHistory, markedText, meetingToMarkdown, migrateStorage, searchMeetings } from '../src/meetings.mjs';
import { normalizeWords, wer } from './wer.mjs';
import { byteRange, durationElement, MORE, recordDir, recordDirSetting, RECORDING_FILE, recordingName, recordMode, reserveDuration } from '../src/recording.mjs';
import {
  buildCliArgs, can, claudeArgs, cliEntry, countSend, DEFAULT_CLI, defaultModel, egress, formatForCli, isLocalConn, isLocalHost, leavesPc, loadModels, OLLAMA_CTX, openKeys, PRESETS, presetOf,
  remoteForTest, requestBytes, ollamaWarm, parseClaudeLine, PROVIDERS, readLines, roleConf, roleError, ROLES, SEALED, sealKeys, sseData, staticPath, streamChat,
} from '../src/providers.mjs';
import {
  bm25, BM_FOUND, buildGroundedPrompt, chunkPage, COS_FOUND, docxPages, enough, extractVocab, GROUNDED_TASKS, joinItems, markRanges, normalize, NOT_FOUND,
  checkArithmetic, checkGrounded, evalArithmetic, missingLines, notCovered, parseNotFound, rankChunks, SOURCE_ACTIONS, sourceChips, tokens, unzipEntry, urlChips, verifyCitations, withWeb,
} from '../src/library.mjs';
import {
  backlinkIndex, entityLine, entityPage, forceLayout, graphOf, homeworkNote, meetingEntities, meetingNote, memChips, noteName, parseEntities, parseLinks, parseNote, wikiHtml,
} from '../src/memory.mjs';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };
const u8 = (s) => new TextEncoder().encode(s);
const parseAll = (id, text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => PROVIDERS[id].parse(l)).filter(Boolean).join('');

// ---------------------------------------------------------------- audio

await check('wav header bytes, sample rate, length', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2]), 16000);
  const v = new DataView(wav.buffer);
  const str = (o, n) => String.fromCharCode(...wav.subarray(o, o + n));
  assert.equal(wav.length, 44 + 5 * 2);
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 10);
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint32(24, true), 16000, 'sample rate');
  assert.equal(v.getUint32(28, true), 32000, 'byte rate');
  assert.equal(v.getUint16(32, true), 2, 'block align');
  assert.equal(v.getUint16(34, true), 16, 'bits');
  assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 10);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 16383, 32767]);
});

await check('downsampler: lengths, constant signal, ramp average, errors', () => {
  assert.equal(downsample(new Float32Array(48000), 48000).length, 16000);
  assert.equal(downsample(new Float32Array(44100), 44100).length, 16000);
  assert.equal(downsample(new Float32Array(22050), 22050).length, 16000);
  assert.ok(downsample(new Float32Array(480).fill(0.25), 48000).every((x) => Math.abs(x - 0.25) < 1e-6));
  assert.deepEqual([...downsample(Float32Array.from([0, 1, 2, 3, 4, 5]), 48000)], [1, 4]);
  assert.deepEqual([...downsample(Float32Array.from([0.5, -0.5]), 16000)], [0.5, -0.5]);
  assert.throws(() => downsample(new Float32Array(10), 8000), /upsample/);
});

await check('silence detector and rms', () => {
  const sine = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  assert.ok(Math.abs(rms(sine) - 0.5 / Math.SQRT2) < 1e-3);
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(isSilent(new Float32Array(1000)));
  assert.ok(isSilent(Float32Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.002)));
  assert.ok(!isSilent(sine));
  assert.equal(prepareChunk(new Float32Array(48000), 48000), null);
  const b64 = prepareChunk(Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10)), 48000);
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.length, 44 + 16000 * 2);
  assert.equal(concatFloat32([Float32Array.of(1, 2), Float32Array.of(3)]).join(), '1,2,3');
});

await check('voice-activity endpointing: pause after speech, 1 s min, 12 s max', () => {
  const B = 85; // one worklet batch at 48 kHz
  const run = (levels) => { let st = VAD_START; return levels.map((l) => (st = vadStep(st, l, B))); };
  const loud = 0.05;
  const quiet = 0;
  const cutAt = (states) => states.findIndex((x) => x.cut);
  // leading silence is never counted, so a chunk does not start 11 s before the speech
  const lead = run([...Array(200).fill(quiet)]);
  assert.ok(lead.every((x) => x.idle && !x.cut), 'silence alone never cuts');
  // 2 s of speech, then a pause: cut once the pause reaches 600 ms
  const talk = run([...Array(5).fill(quiet), ...Array(24).fill(loud), ...Array(20).fill(quiet)]);
  assert.equal(cutAt(talk), 5 + 24 + Math.ceil(VAD.pauseMs / B) - 1, 'cut on the batch where the pause reaches 600 ms');
  // a 170 ms blip: the pause is long enough early, but the chunk waits for the 1 s minimum
  const blip = run([loud, loud, ...Array(30).fill(quiet)]);
  assert.equal(cutAt(blip), Math.ceil(VAD.minMs / B) - 1);
  // speech with no pause: cut at 12 s
  const nonstop = run(Array(400).fill(loud));
  assert.equal(cutAt(nonstop), Math.ceil(VAD.maxMs / B) - 1);
  // a short gap inside speech does not cut
  const gap = run([...Array(20).fill(loud), ...Array(5).fill(quiet), ...Array(20).fill(loud)]);
  assert.equal(cutAt(gap), -1, 'a 425 ms gap is not a pause');
});

await check('base64 matches Buffer for 100k random bytes', () => {
  const bytes = Uint8Array.from({ length: 100_003 }, () => Math.floor(Math.random() * 256));
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

// ---------------------------------------------------------------- prompts

const now = 1_000_000_000;
const lines = [
  { who: 'Meeting', text: 'Old budget talk', t: now - RECENT_MS - 60_000 },
  { who: 'Meeting', text: 'Can you commit to Friday?', t: now - 30_000 },
  { who: 'You', text: 'Let me check.', t: now - 10_000 },
];

await check('prompt builders', () => {
  const [sys, user] = buildPrompt('answer', { transcript: lines, now });
  assert.equal(sys.role, 'system');
  assert.equal(user.role, 'user');
  assert.match(user.content, /Can you commit to Friday\?/);
  assert.match(user.content, /You: Let me check\./);
  assert.doesNotMatch(user.content, /Old budget/, 'answer only uses the last 2 minutes');
  assert.match(buildPrompt('answer', { transcript: lines, now: now + 3_600_000 })[1].content, /Can you commit/, 'a paused meeting keeps its last 2 minutes');
  assert.match(user.content, /exact words I should say next/i);
  assert.match(user.content, /\[02:30\] Meeting: Can you commit/, 'lines carry elapsed times the model can cite');
  assert.match(buildPrompt('recap', { transcript: lines, now })[1].content, /Old budget/, 'recap uses everything');
  assert.match(buildPrompt('ask', { transcript: lines, now, question: '  Who owns QA? ' })[1].content, /My question: Who owns QA\?/);
  assert.match(buildPrompt('explain', { now, hasImage: true })[1].content, /attached image/);
  assert.doesNotMatch(buildPrompt('answer', { now })[1].content, /attached image/);
  assert.match(buildPrompt('followup', { now })[1].content, /follow-up questions/);
  const summary = buildPrompt('summary', { transcript: lines, now })[1].content;
  for (const h of ['## Summary', '## Decisions', '## Action items']) assert.ok(summary.includes(h), h);
  assert.equal(formatTranscript([]), '(No transcript yet.)');
  const long = formatTranscript([{ who: 'Meeting', text: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 500) + 'END', t: 0 }]);
  assert.ok(long.length <= MAX_TRANSCRIPT_CHARS + 3 && long.endsWith('END'), 'keeps the tail');
  assert.throws(() => buildPrompt('nope'), /Unknown action/);
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['answer', 'ask', 'explain', 'followup', 'recap', 'solve', 'summary']);
  assert.equal(ACTIONS.followup, 'Follow-ups', 'card labels match the buttons');
  const flagged = buildPrompt('summary', { transcript: lines, now, startedAt: lines[0].t, flags: [lines[2].t] })[1].content;
  assert.match(flagged, /flagged these moments as important:\n- \[02:50\] You: Let me check\./, 'a flag carries the words said then');
  assert.doesNotMatch(flagged, /- \[02:50\][^\n]*Can you commit/, 'a line 20 s away is outside the 15 s window');
  assert.match(buildPrompt('summary', { transcript: lines, now, startedAt: lines[0].t, flags: [now + 60_000] })[1].content, /- \[04:00\] \(a pause; the nearest lines\) \[02:50\] You: Let me check\./,
    'a flag in a pause carries the nearest lines, not "nothing was said" (acceptance defect 7)');
  assert.match(flagged, /Do not write a "Flagged moments" section: Maverick adds it from the transcript\./, 'the app writes that section (acceptance defect 14)');
  assert.match(buildPrompt('summary', { partNotes: 'part one notes', now })[1].content, /Notes from each part[\s\S]*part one notes/);
  assert.match(buildPartPrompt(lines, 1, 3, lines[0].t)[1].content, /part 2 of 3/);
});

await check('elapsed clock, long-meeting split and coverage note', () => {
  assert.equal(elapsed(0), '00:00');
  assert.equal(elapsed(754_000), '12:34');
  assert.equal(elapsed(3_600_000 + 65_000), '1:01:05', 'h:mm:ss past an hour');
  const many = Array.from({ length: 400 }, (_, i) => ({ who: i % 2 ? 'You' : 'Meeting', text: 'word '.repeat(30), t: i * 8000 }));
  const parts = splitTranscript(many, 20000);
  assert.ok(parts.length > 1, 'split');
  assert.equal(parts.flat().length, many.length, 'no line lost');
  assert.deepEqual(parts.flat(), many, 'order kept');
  assert.ok(parts.every((p) => p.reduce((n, l) => n + l.text.length, 0) <= 20000));
  assert.deepEqual(splitTranscript([]), []);
  assert.equal(coveredSince(lines), null, 'short transcript is not cut');
  const since = coveredSince(many);
  assert.ok(since > 0 && since < many.at(-1).t, 'cut point is inside the meeting');
});

await check('transcript cleaner', () => {
  assert.equal(cleanTranscript('The only thing I can tell you is that '.repeat(12)), '', 'a looping model is dropped (seen live on mic noise)');
  assert.equal(cleanTranscript('No, no, no, no. I said Thursday, not Friday.'), 'No, no, no, no. I said Thursday, not Friday.', 'short repeats are real speech');
  assert.equal(cleanTranscript('We ship on Thursday. We ship on Thursday, right? Yes, we ship on Thursday.'), 'We ship on Thursday. We ship on Thursday, right? Yes, we ship on Thursday.');
  assert.equal(cleanTranscript('  "Hello there."  '), 'Hello there.');
  assert.equal(cleanTranscript('[no speech]'), '');
  assert.equal(cleanTranscript('(silence)'), '');
  assert.equal(cleanTranscript('No speech.'), '');
  assert.equal(cleanTranscript(undefined), '');
  assert.equal(cleanTranscript('We ship Friday'), 'We ship Friday');
  // model refusals seen in shots/polish/after-thinking.png
  assert.equal(cleanTranscript('I cannot fulfill this request because there is no audio file provided.'), '');
  assert.equal(cleanTranscript('I am a text-based AI and do not have the ability to listen to audio.'), '');
  assert.equal(cleanTranscript('Please provide the audio file you would like transcribed.'), '');
  assert.equal(cleanTranscript('I cannot make Friday, sorry.'), 'I cannot make Friday, sorry.', 'real speech with "I cannot" stays');
  assert.equal(cleanTranscript('The user wants me to transcribe the audio. **Audio Content:** "The first step is to identify the core problem.'), '', 'task narration seen live');
  assert.equal(cleanTranscript('Here is the transcription of the audio clip.'), '');
  assert.equal(cleanTranscript('I can certainly help you with that. Please provide the audio or video file, and I will transcribe it, including the requested details.'), '', 'third refusal seen live');
  assert.equal(cleanTranscript('Sure! Please upload the audio.'), '');
  assert.equal(cleanTranscript('I can help you with that, and I will share the video file after lunch.'), 'I can help you with that, and I will share the video file after lunch.', 'speech about files stays');
  assert.equal(cleanTranscript('The user wants to know the plan if the payment integration is delayed.\n\nThe provided audio contains only unintelligible speech and no discernible words. Therefore, I cannot provide a plan or any information based on the audio.'), '', 'second narration seen live');
  assert.equal(cleanTranscript('The user research is done, I will send it Friday.'), 'The user research is done, I will send it Friday.', 'speech mentioning users stays');
  // prompt word leaking into lines, seen in after-1440-light.png
  assert.equal(cleanTranscript('a manual invoice for verbatim.'), 'a manual invoice for');
  assert.equal(cleanTranscript('Keep the verbatim quote in the deck'), 'Keep the verbatim quote in the deck', 'only a trailing leak is cut');
});

await check('mic echo dedupe', () => {
  const tr = [
    { who: 'Meeting', text: 'The main decision today is that we launch the beta on October 15th.', t: 10_000 },
    { who: 'You', text: 'Sounds good to me.', t: 12_000 },
  ];
  assert.ok(isEcho('The main decision today is that we launch the beta on October fifteenth', 14_000, tr), 'speaker bleed');
  assert.ok(!isEcho('I can own the launch checklist and send it tonight', 14_000, tr), 'real reply');
  assert.ok(!isEcho('The main decision today is that we launch the beta on October 15th.', 40_000, tr), 'too late to be an echo');
  assert.ok(!isEcho('Yes okay', 11_000, tr), 'too short to judge');
});

await check('languages: script detection (RTL), reply language, transcription prompt', () => {
  assert.equal(scriptOf('السلام عليكم، كيف الحال'), 'arabic');
  assert.equal(scriptOf('Hello team'), 'latin');
  assert.equal(scriptOf('خلنا نخلص the budget review اليوم'), 'mixed', 'Gulf code-switching');
  assert.equal(scriptOf('12:40 ... 99%'), '');
  assert.equal(replyLanguage({ action: 'ask', question: 'متى الإطلاق؟' }), 'Reply in Arabic, the language of my question. Keep English terms as they were said. Write every word in one script: never mix Arabic and Latin letters inside a word.');
  assert.match(replyLanguage({ action: 'ask', question: 'When is launch?' }), /language of my question/);
  const ar = [{ who: 'Speaker 1', text: 'نبي نأجل الإطلاق ليوم الخميس', t: 0 }];
  assert.match(replyLanguage({ action: 'answer', transcript: ar }), /reply in Arabic/);
  assert.equal(replyLanguage({ action: 'answer', transcript: lines }), '', 'an English meeting adds nothing');
  assert.equal(replyLanguage({ action: 'recap', transcript: ar, answerLang: 'English' }), 'Always reply in English.');
  assert.match(buildPrompt('answer', { transcript: ar, now: 1000 })[1].content, /reply in Arabic/, 'Answer on an Arabic transcript');
  assert.match(buildPrompt('summary', { transcript: ar, now: 1000 })[1].content, /reply in Arabic/, 'notes on an Arabic transcript');
  const p = transcribePrompt({ vocab: ['Nabeel', 'Talabat'] });
  assert.ok(p.startsWith(TRANSCRIBE_PROMPT), 'the plain prompt comes first');
  assert.match(p, /Arabic \(often Gulf dialect\), English/);
  assert.match(p, /never add a translation/);
  assert.match(p, /\[overlap\]/);
  assert.match(p, /\[unclear\]/);
  assert.match(p, /spelled like this: Nabeel, Talabat\.$/, 'spelling hints last (measured best)');
  assert.doesNotMatch(p, /verbatim|exactly/i, 'words the model echoes into transcripts');
  assert.match(transcribePrompt({ languages: 'French and English' }), /usually speak French and English\./);
});

await check('subtitles: which language, the prompt, and the reply cleaner', () => {
  const ar = 'الاجتماع بكرة الساعة عشرة الصبح عند نبيل';
  assert.equal(subtitleLanguage(ar), 'English', 'Auto: Arabic gets English');
  assert.equal(subtitleLanguage('Can you send the budget by Thursday?'), 'Arabic', 'Auto: English gets Arabic');
  assert.equal(subtitleLanguage('خلنا نخلص مراجعة الميزانية review اليوم'), 'English', 'a mixed line gets the language it uses less (mostly Arabic here)');
  assert.equal(subtitleLanguage('let us finish the budget review اليوم please'), 'Arabic', 'mostly English gets Arabic');
  assert.equal(subtitleLanguage('[unclear] نبي نأجل'), 'English', 'tags are not English');
  assert.equal(subtitleLanguage('12:40 ... 99%'), '', 'no letters, nothing to translate');
  assert.equal(subtitleLanguage(ar, 'off'), '');
  assert.equal(subtitleLanguage(ar, 'nonsense'), '', 'an unknown mode does nothing');
  assert.equal(subtitleLanguage('Hello team', 'English'), '', 'Always English skips English lines');
  assert.equal(subtitleLanguage('Hello يا شباب', 'English'), 'English');
  assert.equal(subtitleLanguage(ar, 'Arabic'), '', 'Always Arabic skips Arabic lines');
  assert.equal(subtitleLanguage('Hello team', 'Arabic'), 'Arabic');
  const [sys, user] = buildSubtitlePrompt(ar, 'English');
  assert.equal(user.content, ar, 'the line alone goes to the model');
  assert.match(sys.content, /into English/);
  assert.match(sys.content, /Gulf Arabic/);
  assert.match(sys.content, /names[\s\S]*never translate their meaning/i);
  assert.match(sys.content, /number[\s\S]*same value/i);
  assert.match(sys.content, /translation only[\s\S]*no quotes, labels, notes or explanations/i);
  const en = 'The meeting is tomorrow at ten in the morning at Nabeel\'s.';
  assert.equal(cleanSubtitle(en, ar, 'English'), en);
  assert.equal(cleanSubtitle(`"${en}"`, ar, 'English'), en, 'quotes');
  assert.equal(cleanSubtitle(`Translation: ${en}`, ar, 'English'), en, 'a label');
  assert.equal(cleanSubtitle(`**English:** ${en}`, ar, 'English'), en, 'a bold label');
  assert.equal(cleanSubtitle(`Here is the translation:\n${en}`, ar, 'English'), en, 'a lead-in line');
  assert.equal(cleanSubtitle(`${en}\nNote: "Bukra" means tomorrow in Gulf Arabic.`, ar, 'English'), en, 'a note after it');
  assert.equal(cleanSubtitle(`${en} (literally: at Nabeel)`, ar, 'English'), en, 'a trailing aside');
  assert.equal(cleanSubtitle('```\n' + en + '\n```', ar, 'English'), en, 'a code fence');
  assert.equal(cleanSubtitle(ar, ar, 'English'), '', 'the line echoed back');
  assert.equal(cleanSubtitle('الاجتماع غدا', ar, 'English'), '', 'the wrong script');
  assert.equal(cleanSubtitle('هل يمكنك إرسال الميزانية يوم Thursday؟', 'Can you send the budget by Thursday?', 'Arabic'), 'هل يمكنك إرسال الميزانية يوم الخميس؟', 'a weekday left in English becomes Arabic');
  assert.equal(cleanSubtitle('أرسل تقرير budget قبل الاجتماع', 'Send the budget report before the meeting', 'Arabic'), 'أرسل تقرير budget قبل الاجتماع', 'another English term may stay');
  assert.equal(cleanSubtitle('See you Thursday.', ar, 'English'), 'See you Thursday.', 'English subtitles keep English weekdays');
  assert.match(buildSubtitlePrompt('See you Thursday', 'Arabic')[0].content, /Thursday is الخميس/);
  assert.equal(cleanSubtitle('Sure! '.repeat(60), 'Hi', 'English'), '', 'commentary far longer than the line');
  assert.equal(cleanSubtitle('', ar, 'English'), '');
});

await check('solve prompt: the problem on screen, answer first, then working, code and complexity', () => {
  assert.equal(ACTIONS.solve, 'Solve');
  const p = buildPrompt('solve', { hasImage: true, now: 1000 })[1].content;
  assert.match(p, /attached image is the current frame of the shared meeting screen/);
  assert.match(p, /code[\s\S]*a bug[\s\S]*math or logic question[\s\S]*form[\s\S]*error message/);
  const order = ['the answer itself', 'the working', 'the full code', 'time and space complexity'].map((w) => p.indexOf(w));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`);
  assert.match(p, /Never restate or describe the problem/);
  assert.match(p, /first line is the approach[^.]*"Hash map, one pass, O\(n\)\."/, 'code leads with the approach');
  assert.match(p, /on one line, like "Time O\(n\), space O\(n\)\."/, 'complexity on one line, not two that merge');
  assert.match(buildPrompt('solve', { hasImage: true, answerLang: 'Arabic', now: 1000 })[1].content, /Always reply in Arabic\./, 'the answer language applies');
});

// The canary: eight grey cells in the bar. A synthetic capture with the strip somewhere in noise must be found where
// the bar is; anything else (no strip, the wrong code, flat colour, a colour pattern, a strip outside the slack) must not.
await check('share check canary: found where drawn, never invented', async () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const img = (w, h, fill) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < px.length; i += 4) { const v = fill ?? Math.floor(rnd() * 256); px[i] = v; px[i + 1] = fill ?? Math.floor(rnd() * 256); px[i + 2] = fill ?? Math.floor(rnd() * 256); px[i + 3] = 255; } return px; };
  // draws the strip at (x, y) with cells of `cell` px (fractional at 125 or 150 %), blending edge pixels like a rasterizer
  const draw = (px, w, x, y, cell, h, bits = CANARY, hi = 78, lo = 16) => {
    for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++) {
      for (let xx = Math.floor(x); xx < Math.ceil(x + bits.length * cell); xx++) {
        const i = Math.min(bits.length - 1, Math.floor((xx + 0.5 - x) / cell));
        const o = (yy * w + xx) * 4;
        const v = bits[i] ? hi : lo;
        px[o] = v; px[o + 1] = v; px[o + 2] = Math.min(255, v + 2);
      }
    }
  };
  const W = 120;
  const H = 40;
  for (const [scale, at] of [[1, { x: 30, y: 20 }], [1.25, { x: 30.5, y: 20.25 }], [1.5, { x: 31.5, y: 19.5 }], [2, { x: 30, y: 20 }]]) {
    const px = img(W, H);
    const cell = 2 * scale;
    draw(px, W, at.x, at.y, cell, cell);
    assert.ok(findCanary(px, W, H, { ...at, cell, h: cell }).found, `found at ${scale * 100} %`);
    assert.ok(findCanary(px, W, H, { x: at.x + 2, y: at.y - 2, cell, h: cell }).found, `found 2 px off at ${scale * 100} %`);
    assert.ok(!findCanary(px, W, H, { x: at.x + 12, y: at.y, cell, h: cell }).found, `not found 12 px away at ${scale * 100} %`);
  }
  const light = img(W, H); draw(light, W, 30, 20, 2, 2, CANARY, 72, 28);
  assert.ok(findCanary(light, W, H, { x: 30, y: 20, cell: 2, h: 2 }).found, 'the light theme greys');
  // desktopCapturer on the test PC returns about 1.6 x + 6 of each value and clips from 156 up (measured). The bar.css
  // greys must survive that; the first light greys (255 and 200) both came back white, which would have read as hidden.
  const capture = (px) => px.map((v, i) => (i % 4 === 3 ? v : Math.min(255, Math.round(1.6 * v + 6))));
  for (const [theme, hi, lo] of [['dark', 64, 24], ['light', 72, 28]]) {
    const p = img(W, H); draw(p, W, 30, 20, 2, 2, CANARY, hi, lo);
    assert.ok(findCanary(capture(p), W, H, { x: 30, y: 20, cell: 2, h: 2 }).found, `${theme} greys survive the measured capture curve`);
  }
  const old = img(W, H); draw(old, W, 30, 20, 2, 2, CANARY, 255, 200);
  assert.ok(!findCanary(capture(old), W, H, { x: 30, y: 20, cell: 2, h: 2 }).found, 'greys above 156 vanish in that capture (why bar.css keeps them dark)');
  const css = readFileSync(new URL('../bar.css', import.meta.url), 'utf8');
  const greys = [...css.matchAll(/\.canary i(?:\.on)? \{[^}]*light-dark\(rgb\((\d+) (\d+) (\d+)\), rgb\((\d+) (\d+) (\d+)\)\)/g)].flatMap((m) => m.slice(1).map(Number));
  assert.deepEqual(greys, [28, 28, 28, 24, 24, 24, 72, 72, 72, 64, 64, 64], 'bar.css draws the greys tested here, neutral, all under 156');
  for (const [name, px] of [
    ['noise only', img(W, H)],
    ['flat white', img(W, H, 255)],
    ['flat black', img(W, H, 0)],
    ['the code inverted', (() => { const p = img(W, H); draw(p, W, 30, 20, 2, 2, CANARY.map((b) => 1 - b)); return p; })()],
    ['a plain stripe', (() => { const p = img(W, H); draw(p, W, 30, 20, 2, 2, [1, 0, 1, 0, 1, 0, 1, 0]); return p; })()],
    ['too little contrast', (() => { const p = img(W, H); draw(p, W, 30, 20, 2, 2, CANARY, 40, 30); return p; })()],
    ['coloured cells', (() => { const p = img(W, H); draw(p, W, 30, 20, 2, 2); for (const y of [20, 21]) for (let x = 30; x < 46; x++) p[(y * W + x) * 4] = 250; return p; })()],
  ]) assert.ok(!findCanary(px, W, H, { x: 30, y: 20, cell: 2, h: 2 }).found, `not found: ${name}`);
  assert.ok(!findCanary(img(W, H), W, H, { x: 110, y: 38, cell: 2, h: 2 }).found, 'a strip that would run off the capture is not matched');
  assert.equal(blackShare(img(W, H, 0), W, H, { x: 10, y: 10, width: 50, height: 20 }), 1, 'a black box');
  assert.ok(blackShare(img(W, H), W, H, { x: 10, y: 10, width: 50, height: 20 }) < 0.05, 'noise is not a black box');
  assert.equal(blackShare(img(W, H, 0), W, H, { x: 200, y: 200, width: 5, height: 5 }), 0, 'a box off the capture counts nothing');
});

await check('speaker turns, [overlap], [unclear], and dropped translations', () => {
  assert.deepEqual(parseTurns('- Speaker 1: Hello there\n[overlap] I think so\n[overlap] no, wait\n[unclear]\nsend it to [unclear] today'), [
    { text: 'Hello there', overlap: false }, { text: 'I think so', overlap: true }, { text: 'no, wait', overlap: true },
    { text: 'send it to [unclear] today', overlap: false },
  ], 'labels removed, [overlap] kept as a flag, a line of only [unclear] dropped, inline [unclear] kept');
  assert.deepEqual(parseTurns('same thing\nsame thing'), [{ text: 'same thing', overlap: false }], 'a repeated turn is dropped');
  assert.deepEqual(parseTurns('[overlap] [00:00:00.000] Hi.'), [{ text: 'Hi.', overlap: false }], 'seen live: a timestamp and a lone [overlap] on one line');
  assert.deepEqual(parseTurns('[00:\nHi team.\n...'), [{ text: 'Hi team.', overlap: false }], 'seen live: a cut-off timestamp on its own line');
  assert.deepEqual(parseTurns('(00:03) Hello\n[overlap] a\n[overlap] b').map((t) => [t.text, t.overlap]), [['Hello', false], ['a', true], ['b', true]]);
  // Seen live: an English sentence followed by an Arabic translation the model added, in a 2.5 s chunk.
  assert.deepEqual(parseTurns('I think we should hire one more designer.\nأعتقد أننا يجب أن نوظف مصممًا آخر.', 2.5).map((t) => t.text), ['I think we should hire one more designer.']);
  assert.equal(parseTurns("Let's finalize the budget today\nإن شاء الله نخلصها اليوم", 4).length, 2, 'code-switching at speaking pace is kept');
  assert.deepEqual(parseTurns('I cannot fulfill this request. I am unable to process audio files.'), [], 'refusals drop');
});

await check('misheard-word fixes and [unclear] fills stay marked', () => {
  const line = 'ask Nabil to send the Quran invoice to [unclear] today';
  const fixes = parseFixes('```json\n{"fixes":[{"from":"Nabil","to":"Nabeel"},{"from":"Quran","to":"Qurain"},{"from":"not here","to":"x"},' +
    '{"from":"send","to":"send"},{"from":"[unclear]","to":"Talabat"}]}\n```', line);
  assert.deepEqual(fixes, [{ from: 'Nabil', to: 'Nabeel' }, { from: 'Quran', to: 'Qurain' }], 'only whole words in the line; no no-ops, no [tags]');
  assert.deepEqual(parseFixes('{"fixes":[{"from":"send the Quran invoice to","to":"please write a new sentence here"}]}', line), [], 'no rewrites');
  assert.deepEqual(parseFixes('not json', line), []);
  const fills = fillUnclear('send the [unclear] invoice to [unclear] today', 'Send the Qurain invoice to [unclear], today.');
  assert.deepEqual(fills, [{ from: '[unclear]', to: 'Qurain', at: 9, by: 'relisten' }], 'fills only the spots it resolved');
  assert.deepEqual(fillUnclear('send the [unclear] invoice', 'please send a totally different invoice'), [], 'a second pass that changed other words is ignored');
  assert.deepEqual(fillUnclear('send the [unclear] invoice', 'send the one two three four five invoice'), [], 'no long fills');
  const raw = 'send the [unclear] invoice to [unclear] today';
  const parts = applyFixes(raw, [...fills, { from: '[unclear]', to: 'Talabat', at: 30, by: 'deep' }]);
  assert.equal(parts.map((x) => x.text).join(''), 'send the Qurain invoice to Talabat today');
  assert.deepEqual(parts.filter((x) => x.from).map((x) => [x.text, x.from, x.by]), [['Qurain', '[unclear]', 'relisten'], ['Talabat', '[unclear]', 'deep']], 'every change remembers what was heard and who changed it');
  // End of meeting: the deep model fills the spots still open, by line number.
  const tr = [{ who: 'Speaker 1', text: 'launch on Thursday', t: 0 }, { who: 'Speaker 2', raw, fixes: fills, text: 'send the Qurain invoice to [unclear] today', t: 5000 }];
  assert.match(buildUnclearPrompt(tr, 0)[1].content, /L1 \[00:05\] Speaker 2: send the Qurain invoice to \[unclear\] today[\s\S]*Lines with \[unclear\]: L1$/);
  assert.deepEqual(parseFills('{"lines":[{"n":1,"fills":["Talabat"]},{"n":0,"fills":["x"]},{"n":9,"fills":["y"]}]}', tr), { 1: [{ from: '[unclear]', to: 'Talabat', at: 30, by: 'deep' }] });
  assert.deepEqual(parseFills('{"lines":[{"n":1,"fills":["[unclear]"]}]}', tr), {}, 'a spot the deep model is not sure of stays [unclear]');
  // History and exports never present a change as what was said.
  const exp = markedText({ ...tr[1], fixes: [...fills, { from: 'Quran', to: 'Qurain' }], raw: 'the Quran bill and [unclear]' });
  assert.equal(markedText({ text: 'plain', t: 0 }), 'plain');
  assert.match(markedText({ raw: 'ask Nabil and [unclear]', fixes: [{ from: 'Nabil', to: 'Nabeel' }, { from: '[unclear]', to: 'Sara', at: 14 }] }), /^ask Nabeel \(corrected, heard "Nabil"\) and Sara \(guess, unclear in the audio\)$/);
  void exp;
});

await check('speaker fingerprints: pitch, voice shape, online clustering', () => {
  const rate = 16000;
  const voice = (f0, formants, secs = 1.5) => Float32Array.from({ length: rate * secs }, (_, i) => {
    let v = 0;
    for (let h = 1; h * f0 < 7000; h++) v += formants.reduce((m, [fc, bw]) => m + Math.exp(-(((h * f0 - fc) / bw) ** 2)), 0.02) * Math.sin((2 * Math.PI * h * f0 * i) / rate);
    return 0.05 * v;
  });
  for (const f0 of [85, 120, 215, 330]) {
    const est = pitchOf(voice(f0, [[600, 150]], 0.05).subarray(0, 512), rate);
    assert.ok(Math.abs(est - f0) / f0 < 0.04, `pitch ${f0} Hz read as ${est.toFixed(0)} (no octave errors)`);
  }
  assert.equal(voiceprint(new Float32Array(rate), rate), null, 'silence has no voice');
  const a1 = voiceprint(voice(115, [[700, 150], [1200, 200], [2600, 300]]), rate);
  const a2 = voiceprint(voice(118, [[680, 150], [1180, 200], [2580, 300]]), rate);
  const b1 = voiceprint(voice(210, [[400, 120], [2300, 250], [3000, 300]]), rate);
  assert.ok(cosine(a1, a2) > 0.9 && cosine(a1, b1) < 0.9, `same voice ${cosine(a1, a2).toFixed(2)}, different ${cosine(a1, b1).toFixed(2)}`);
  const speakers = [];
  assert.deepEqual([a1, b1, a2, b1].map((v) => assignSpeaker(v, speakers).id), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  assert.equal(speakers[0].n, 2, 'the centroid learns from each match');
  const many = [];
  for (let i = 0; i < 12; i++) assignSpeaker(Array.from({ length: 17 }, (_, k) => (k === i ? 1 : 0)), many, 0.9, 8);
  assert.equal(many.length, 8, 'at most 8 speakers; after that the closest one');
});

await check('word error rate for the quality report', () => {
  assert.equal(wer('a b c d', 'a b c d'), 0);
  assert.equal(wer('a b c d', 'a x c'), 0.5, 'one substitution and one deletion over four words');
  assert.equal(wer('Hi team, let us go.', 'hi TEAM let us go'), 0, 'case and punctuation do not count');
  assert.equal(wer('send it to Sarah', 'send it to [unclear]'), 0.25, 'an [unclear] tag is a missing word');
  assert.equal(wer('one two', 'one two three four'), 1, 'insertions count');
  assert.deepEqual(normalizeWords('إنّ الإطلاق يوم الخميسْ'), ['ان', 'الاطلاق', 'يوم', 'الخميس'], 'Arabic diacritics and alef forms');
  assert.equal(wer('', ''), 0);
});

await check('markdown renderer escapes HTML', () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>\n\n**bold** and `<b>` and *it*\n\n- [ ] Sam: send deck\n- plain\n\n1. one\n\n## Head\n\n```\n<script>\n```');
  assert.ok(!/<img|<script|<b>/.test(out), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(out.includes('<strong>bold</strong>'));
  assert.ok(out.includes('<code>&lt;b&gt;</code>'));
  assert.ok(out.includes('<em>it</em>'));
  assert.ok(out.includes('<span class="check"></span>Sam: send deck'));
  assert.ok(out.includes('<ol><li>one</li></ol>'));
  assert.ok(out.includes('<h4>Head</h4>'));
  assert.ok(out.includes('<pre><code>&lt;script&gt;</code></pre>'));
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
  assert.equal(renderMarkdown('```\nopen fence'), '<pre><code>open fence</code></pre>', 'unclosed fence while streaming');
  // streaming: an unclosed mark waits until it closes
  assert.equal(holdOpen('We launch on **Fri'), 'We launch on ');
  assert.equal(holdOpen('Done **today**.'), 'Done **today**.');
  assert.equal(holdOpen('It is Thursday. [10:5'), 'It is Thursday. ');
  assert.equal(holdOpen('It is Thursday. [10:52]'), 'It is Thursday. [10:52]');
  assert.equal(holdOpen('Run `ollama'), 'Run ');
  assert.equal(holdOpen('Launch *'), 'Launch ');
  assert.equal(holdOpen('- item'), '- item');
  assert.equal(holdOpen('She said:\n> "'), 'She said:\n', 'an empty quote block waits for its first word');
  assert.equal(holdOpen('> "No'), '> "No');
  assert.equal(holdOpen('```\nx = **y'), '```\nx = **y', 'inside a code block nothing is held');
  assert.equal(renderMarkdown('> say **this**\n> now\n\nafter'), '<blockquote><p>say <strong>this</strong> now</p></blockquote><p>after</p>');
  assert.equal(renderMarkdown('> <b>x</b>'), '<blockquote><p>&lt;b&gt;x&lt;/b&gt;</p></blockquote>', 'quotes stay escaped');
  assert.equal(renderMarkdown('a > b'), '<p>a &gt; b</p>', 'only a leading > quotes');
  assert.equal(renderMarkdown('> "No spend goes out," she said. It\'s Sarah\'s call, not \'mine\'.'), '<blockquote><p>\u201CNo spend goes out,\u201D she said. It\u2019s Sarah\u2019s call, not \u2018mine\u2019.</p></blockquote>', 'typographic quotes');
  assert.equal(renderMarkdown('Run `say "hi"` now'), '<p>Run <code>say &quot;hi&quot;</code> now</p>', 'code keeps straight quotes');
});

await check('meeting search and markdown export', () => {
  const ms = [
    { id: 'a', title: 'Budget sync', startedAt: 1, endedAt: 60001, summary: 'Cut costs', transcript: [{ who: 'You', text: 'hello', t: 1 }] },
    { id: 'b', title: 'Design review', startedAt: 2, endedAt: 60002, summary: '', transcript: [{ who: 'Meeting', text: 'The LOGO is blue', t: 2 }] },
  ];
  assert.deepEqual(searchMeetings(ms, '').map((m) => m.id), ['b', 'a'], 'newest first');
  assert.deepEqual(searchMeetings(ms, 'logo').map((m) => m.id), ['b'], 'searches transcript, case-insensitive');
  assert.deepEqual(searchMeetings(ms, 'cut').map((m) => m.id), ['a'], 'searches summary');
  assert.deepEqual(searchMeetings(ms, 'zzz'), []);
  const md = meetingToMarkdown(ms[0]);
  assert.ok(md.startsWith('# Budget sync\n'));
  assert.ok(md.includes('Cut costs') && md.includes('## Transcript') && md.includes('You:** hello'));
  assert.ok(md.includes('**00:00 You:** hello'), 'elapsed clock, not UTC');
  assert.ok(!/T\d\d:\d\d:\d\d/.test(md) && !md.includes('UTC'), 'no ISO timestamps');
  const flagged = meetingToMarkdown({ ...ms[0], flags: [1], answers: [{ label: 'Answer', question: '', text: 'Say yes.', at: 1 }] });
  assert.ok(flagged.includes('## Flagged moments') && flagged.includes('**00:00** hello'));
  assert.ok(flagged.includes('## Asked during the meeting') && flagged.includes('Say yes.'));
  const once = meetingToMarkdown({ ...ms[0], summary: '## Summary\nx\n## Flagged moments\n- 00:00 hello', flags: [1] });
  assert.equal(once.match(/Flagged moments/g).length, 1, 'no second flag section when the notes have one');
  const subbed = meetingToMarkdown({ ...ms[0], transcript: [{ who: 'Speaker 1', text: 'بكرة الساعة عشرة', t: 1, sub: { lang: 'English', text: 'Tomorrow at ten.' } }] });
  assert.ok(subbed.includes('- **00:00 Speaker 1:** بكرة الساعة عشرة\n  - *English:* Tomorrow at ten.'), 'the subtitle is exported under its line');
  assert.match(renderMarkdown(subbed), /<li><strong>00:00 Speaker 1:<\/strong> بكرة الساعة عشرة<\/li><li><em>English:<\/em> Tomorrow at ten\.<\/li>/, 'and History shows it');
  const notes = '## Summary\nShipped.\n## Decisions\n- Go\n## Action items\n- [ ] Omar: onboarding screens (Friday)\n- [x] Lena: pricing sheet\n## Flagged moments\n- 00:10 x';
  assert.deepEqual(extractActionItems(notes), ['Omar: onboarding screens (Friday)', 'Lena: pricing sheet']);
  assert.deepEqual(extractActionItems('## Action items\nNone noted.'), []);
  assert.ok(actionItemsMarkdown({ title: 'Sync', summary: notes }).includes('- [ ] Omar: onboarding screens (Friday)'));
});

await check('history size cap drops oldest transcripts, keeps notes', () => {
  const big = (id, startedAt) => ({ id, title: id, startedAt, endedAt: startedAt + 1, summary: `notes ${id}`, transcript: [{ who: 'You', text: 'x'.repeat(5000), t: startedAt }] });
  const list = [big('new', 3), big('old', 1), big('mid', 2)];
  const { list: out, trimmed } = fitHistory(list, 8000);
  assert.equal(trimmed, 2);
  assert.deepEqual(out.map((m) => m.transcript.length), [1, 0, 0], 'newest keeps its transcript');
  assert.ok(out.every((m) => m.summary.startsWith('notes')), 'notes kept');
  assert.equal(list[1].transcript.length, 1, 'input not mutated');
  assert.equal(fitHistory(list, 1e9).trimmed, 0);
});

await check('storage migration moves cue.* keys to maverick.* once', () => {
  const m = new Map([['cue.settings', '{"provider":"ollama"}'], ['cue.meetings', '[1]'], ['maverick.theme', 'dark'], ['cue.theme', 'light'], ['other', 'x']]);
  const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.deepEqual(migrateStorage(st).sort(), ['maverick.meetings', 'maverick.settings']);
  assert.equal(m.get('maverick.settings'), '{"provider":"ollama"}');
  assert.equal(m.get('maverick.theme'), 'dark', 'an existing new key wins');
  assert.deepEqual([...m.keys()].filter((k) => k.startsWith('cue.')), [], 'old keys removed');
  assert.equal(m.get('other'), 'x');
  assert.deepEqual(migrateStorage(st), [], 'second run moves nothing');
});

await check('static file allowlist (path traversal, dotfiles, ADS)', () => {
  for (const ok of ['/', '/index.html', '/styles.css', '/bar.css', '/icon.svg', '/src/app.mjs', '/src/pcm-worklet.js']) assert.ok(staticPath(ok), ok);
  const bad = ['/serve.mjs', '/test/selfcheck.mjs', '/shots/x.png', '/.git/config', '/.git/HEAD', '/cue.config.json', '/maverick.config.json',
    '/src\\..\\.git\\config', '/src/..\\.git\\config', '/src/../serve.mjs', '/src/.hidden.mjs', '/serve.mjs::$DATA',
    '/index.html::$DATA', '/C:\\Windows\\win.ini', '//C:/Windows/win.ini', '/SERVE~1.MJS', '/serve.mjs.', '/index.html\0.png',
    '/README.md', '/extension/background.js', '/src/app.mjs.', '/src/'];
  for (const b of bad) assert.equal(staticPath(b), null, b);
  // node_modules: PDF.js and its worker only, exactly these two files
  for (const ok of ['/node_modules/pdfjs-dist/build/pdf.min.mjs', '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs']) assert.equal(staticPath(ok), ok);
  for (const b of ['/node_modules/pdfjs-dist/build/pdf.mjs', '/node_modules/pdfjs-dist/build/pdf.worker.mjs', '/node_modules/pdfjs-dist/build/pdf.min.mjs.map',
    '/node_modules/pdfjs-dist/package.json', '/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', '/node_modules/pdfjs-dist/web/pdf_viewer.mjs',
    '/node_modules/pdfjs-dist/build/../package.json', '/node_modules/pdfjs-dist/build/..%2fpackage.json', '/node_modules/electron/index.js', '/node_modules/.package-lock.json',
    '/node_modules/pdfjs-dist/build/pdf.min.mjs::$DATA', '/node_modules/pdfjs-dist/build/pdf.min.mjs.', '/node_modules/PDFJS-DIST/build/pdf.min.mjs',
    '/node_modules/pdfjs-dist/build/pdf.sandbox.min.mjs', '/node_modules/']) assert.equal(staticPath(b), null, b);
});

await check('Sources, Web: the Claude Code CLI gets web search and fetch, and nothing else', () => {
  const at = (args, flag) => args[args.indexOf(flag) + 1];
  const web = claudeArgs('', true);
  assert.equal(at(web, '--tools'), 'WebSearch,WebFetch');
  assert.equal(at(web, '--allowedTools'), 'WebSearch,WebFetch');
  assert.ok(web.includes('--restricted') && web.includes('--strict-mcp-config') && web.includes('--no-session-persistence'), 'still restricted, no MCP, no session');
  assert.equal(at(claudeArgs('sonnet'), '--tools'), 'Read', 'without web: Read only, as before');
  assert.deepEqual(claudeArgs('sonnet').slice(-2), ['--model', 'sonnet']);
  assert.equal(PROVIDERS.claudecode.build([{ role: 'user', content: 'q' }], { web: true }, { token: 't' }).body.web, true);
  assert.equal(PROVIDERS.claudecode.build([{ role: 'user', content: 'q' }], {}, { token: 't' }).body.web, undefined);
  const m = withWeb([{ role: 'system', content: 's' }, { role: 'user', content: 'My question: q' }]);
  assert.equal(m[0].content, 's');
  assert.match(m[1].content, /^My question: q\n\nSearch the web[\s\S]*markdown link/);
});

await check('library: Arabic-aware tokens, chunks by page, keyword plus vector ranking', () => {
  assert.equal(normalize('الإجتماعُ في المَدْرسةِ إلى مستشفى'), 'الاجتماع في المدرسه الي مستشفي', 'tashkeel gone; alef, taa marbuta and yaa unified');
  assert.equal(normalize('سعته ١٢٠٠ منصة'), 'سعته 1200 منصه', 'Arabic-Indic digits');
  assert.deepEqual(tokens('ما هي سعة المستودع الرئيسي؟'), ['سعه', 'مستودع', 'رئيسي'], 'stop words and the article dropped');
  assert.deepEqual(tokens('The Launch of Project ATLAS, 14 March'), ['launch', 'project', 'atlas', '14', 'march']);
  // chunks: 800 to 1200 characters, cut at a sentence, overlapping, by page, with positions
  const sentence = (i) => `Sentence number ${i} talks about the plan in some detail. `;
  const page = Array.from({ length: 60 }, (_, i) => sentence(i)).join('');
  const cs = chunkPage(page, 4);
  assert.ok(cs.length >= 3, `${cs.length} chunks`);
  for (const [i, c] of cs.entries()) {
    assert.equal(c.page, 4);
    assert.equal(c.text, page.slice(c.start, c.end).trim(), 'positions point at the text');
    if (i < cs.length - 1) { assert.ok(c.end - c.start >= 800 && c.end - c.start <= 1200, `chunk ${i} is ${c.end - c.start}`); assert.match(c.text, /\.$/, 'cut at a sentence end'); }
    if (i) assert.ok(c.start < cs[i - 1].end && cs[i - 1].end - c.start <= 200, 'overlaps the one before by about 150');
  }
  assert.deepEqual(chunkPage('Short page.', 2), [{ page: 2, start: 0, end: 11, text: 'Short page.' }]);
  assert.deepEqual(chunkPage('', 1), []);
  const { text, at } = joinItems([{ str: 'Hello ', hasEOL: false }, { str: 'world', hasEOL: true }, { type: 'beginMarkedContent' }, { str: 'Next', hasEOL: false }]);
  assert.equal(text, 'Hello world\nNext');
  assert.deepEqual(at, [0, 6, 12, 12]);
  // Arabic drawn glyph by glyph left to right, in presentation forms (as Chromium writes it): read right to left, as
  // letters, with a Latin run kept in order. The line is "في المستودع Kuwait City"; x is where each item is drawn.
  const ar = [['\uFED3\uFEF2', 200], [' ', 196], ['دع', 150], ['\uFEEE', 160], ['\uFE98', 166], ['\uFEB4', 172], ['\uFEE4', 178], ['\uFEDF', 184], ['ا', 190],
    [' ', 146], ['City', 120], [' ', 116], ['Kuwait', 80]].map(([str, x], i) => ({ str, transform: [1, 0, 0, 1, x, 700], hasEOL: i === 12 }));
  const j = joinItems(ar);
  assert.equal(j.text, 'في المستودع Kuwait City\n', JSON.stringify(j.text));
  assert.equal(j.text.slice(j.at[10], j.at[10] + j.len[10]), 'City', 'positions still find each item');
  assert.equal(j.text.slice(j.at[0], j.at[0] + j.len[0]), 'في');
  // BM25: rare matching words win; ranking blends it with the cosine
  const docs = [tokens('budget approved by finance'), tokens('the warehouse capacity is large'), tokens('budget budget budget')];
  const s = bm25(tokens('approved budget'), docs);
  assert.ok(s[0] > s[2] && s[2] > 0 && s[1] === 0, JSON.stringify(s));
  const chunks = [
    { name: 'a.pdf', page: 1, text: 'Project Atlas launches on 14 March 2027.', vec: [1, 0, 0] },
    { name: 'a.pdf', page: 2, text: 'The approved budget is 2.4 million KWD.', vec: [0, 1, 0] },
    { name: 'b.png', page: 1, text: 'المستودع الرئيسي سعته 1200 منصة', vec: [0, 0, 1] },
  ];
  assert.equal(rankChunks('When does Atlas launch?', [0.9, 0.1, 0], chunks, 2)[0].page, 1);
  assert.equal(rankChunks('ما سعة المستودع', [0, 0.2, 0.9], chunks)[0].name, 'b.png', 'an Arabic question finds the Arabic page');
  assert.equal(rankChunks('x', null, chunks, 2).length, 2, 'top k');
  assert.ok(enough([{ cos: COS_FOUND, bm: 0 }]) && enough([{ cos: 0.36, bm: BM_FOUND }]), 'close in meaning, or a strong keyword match');
  assert.ok(!enough([{ cos: COS_FOUND - 0.01, bm: BM_FOUND - 0.1 }]) && !enough([]), 'otherwise not, and an empty library never');
});

await check('My material only: the grounded prompt, the citation checker and the not-found path', () => {
  assert.deepEqual([...SOURCE_ACTIONS].sort(), ['answer', 'ask', 'followup', 'solve'], 'Recap and the notes stay on the meeting');
  const chunks = [
    { fileId: 'f1', name: 'atlas brief.pdf', page: 1, start: 0, end: 40, text: 'Project Atlas launches on 14 March 2027.' },
    { fileId: 'f2', name: 'scan.pdf', page: 3, start: 10, end: 60, text: 'Late delivery penalty: 2% a week.' },
  ];
  const [sys, user] = buildGroundedPrompt({ task: GROUNDED_TASKS.ask, question: 'My question: when?', chunks });
  assert.match(sys.content, /only from the excerpts/);
  assert.match(sys.content, /Never use outside knowledge/);
  assert.match(sys.content, /cite[\s\S]*label exactly as given/i);
  assert.match(sys.content, new RegExp(`${NOT_FOUND}: `));
  assert.ok(user.content.includes('[atlas brief.pdf p.1]\nProject Atlas launches on 14 March 2027.') && user.content.includes('[scan.pdf p.3]\nLate delivery'), 'each chunk under its label');
  assert.ok(user.content.endsWith('My question: when?'));
  assert.doesNotMatch(user.content, /Transcript|Speaker/, 'only the chunks and the question');
  assert.match(buildGroundedPrompt({ task: 't', question: 'q', chunks, answerLang: 'Arabic' })[0].content, /Always reply in Arabic\./);
  assert.match(sys.content, /Reply in English\.$/, 'auto names the language of the question');
  assert.match(buildGroundedPrompt({ task: 't', question: 'سؤالي: ما سعة المستودع؟', chunks })[0].content, /Reply in Arabic\.$/);
  // citations: matching ones kept and normalized, others removed and counted
  let v = verifyCitations('Atlas launches on 14 March 2027 [atlas brief.pdf p.1]. Penalty is 2% [Scan.PDF, page 3]. Budget is huge [budget.xlsx p.2]. Also [atlas brief.pdf p.9].', chunks);
  assert.equal(v.text, 'Atlas launches on 14 March 2027 [atlas brief.pdf p.1]. Penalty is 2% [scan.pdf p.3]. Budget is huge. Also.');
  assert.equal(v.removed, 2);
  assert.deepEqual(v.cited.map((c) => c.fileId), ['f1', 'f2']);
  v = verifyCitations('Both [atlas brief.pdf p.1; scan.pdf p.3].', chunks);
  assert.equal(v.text, 'Both [atlas brief.pdf p.1][scan.pdf p.3].', 'a shared bracket is split');
  assert.equal(verifyCitations('No citations at all.', chunks).cited.length, 0);
  assert.equal(verifyCitations('Times stay: [12:40].', chunks).text, 'Times stay: [12:40].');
  // not found
  assert.deepEqual(parseNotFound('NOT FOUND: the lead engineer\'s salary'), { missing: 'the lead engineer\'s salary' });
  assert.deepEqual(parseNotFound('**NOT_FOUND** - 2022 World Cup winner\nmore'), { missing: '2022 World Cup winner' });
  assert.deepEqual(parseNotFound('The excerpts do not contain the salary.'), { missing: '' });
  assert.equal(parseNotFound('Atlas launches on 14 March 2027 [atlas brief.pdf p.1].'), null);
  assert.equal(parseNotFound('The excerpts do not mention a delay, so the launch stays on 14 March [atlas brief.pdf p.1]. ' + 'x'.repeat(400)), null, 'a long answer that mentions a gap is still an answer');
  // chips: only labels of given chunks become buttons; only http(s) links do
  assert.equal(sourceChips('<p>On 14 March [atlas brief.pdf p.1] and [other.pdf p.2].</p>', chunks),
    '<p>On 14 March <button type="button" class="cite src" data-cmd="src" data-file="f1" data-page="1" data-tip="Open atlas brief.pdf at page 1">atlas brief.pdf p.1</button> and [other.pdf p.2].</p>');
  const u = urlChips('<p>See [BBC](https://www.bbc.com/news?a=1&amp;b=2), https://example.org/x. Not [x](javascript:alert(1)) or file:///C:/x</p>');
  assert.match(u, /data-url="https:\/\/www\.bbc\.com\/news\?a=1&amp;b=2"[^>]*>BBC<\/button>/);
  assert.match(u, /data-url="https:\/\/example\.org\/x"[^>]*>example\.org<\/button>\./);
  assert.ok(u.includes('[x](javascript:alert(1))') && u.includes('file:///C:/x') && (u.match(/<button/g) || []).length === 2, 'other schemes stay text');
  assert.equal(markRanges('a<b>cdef', [{ start: 1, end: 3 }, { start: 2, end: 5 }]), 'a<mark>&lt;b&gt;c</mark>def');
});

await check('My material only: half answers, named gaps, false premises, comma citations and checked arithmetic', () => {
  const chunks = [
    { fileId: 'h', name: 'history-chapter.docx', page: 1 }, { fileId: 'h', name: 'history-chapter.docx', page: 2 },
    { fileId: 'a', name: 'atlas brief.pdf', page: 1 },
  ];
  // (d) comma-joined citations, with and without the file name repeated; a file name with a comma stays whole
  assert.equal(verifyCitations('X [history-chapter.docx p.1, history-chapter.docx p.2].', chunks).text, 'X [history-chapter.docx p.1][history-chapter.docx p.2].');
  assert.equal(verifyCitations('X [history-chapter.docx p.1, p.2].', chunks).cited.length, 2);
  assert.equal(verifyCitations('X [Smith, Jones p.1].', chunks).removed, 1, 'one bracket, one unknown file');
  // (c) a cited half answer is kept, the gap named; (e) the raw marker never shows
  let g = checkGrounded('The Domesday Book was completed in 1086 [history-chapter.docx p.1]. The excerpts do not mention who its chief clerk was.', chunks, 'q');
  assert.ok(!g.notFound && /1086/.test(g.text) && /do not mention/.test(g.text), 'P01: the half answer stays');
  g = checkGrounded('Thylakoid membranes [history-chapter.docx p.2].\n\nNOT FOUND: how many photons are needed.', chunks, 'q');
  assert.equal(g.text, 'Thylakoid membranes [history-chapter.docx p.2].\n\nMissing: how many photons are needed.');
  assert.equal(missingLines('**NOT FOUND:** the rest'), 'Missing: the rest.');
  // (a / 13a) no valid citation: the card names what is missing, never the generic line
  g = checkGrounded('The phone number is 2222 3333.', chunks, 'ما هو رقم هاتف مدير المستودع في الشويخ؟');
  assert.equal(g.notFound.missing, 'Nothing in your files covers “ما هو رقم هاتف مدير المستودع في الشويخ؟”');
  assert.equal(checkGrounded('NOT FOUND: the clerk', chunks, 'q').notFound.missing, 'the clerk');
  assert.equal(checkGrounded('NOT FOUND', chunks, 'Who was the clerk?').notFound.missing, 'Nothing in your files covers “Who was the clerk?”');
  assert.equal(notCovered(''), 'Your files do not answer this');
  // (b, g / 13b) a false premise is corrected from the files; partial answers and calculations have their rules
  const sys = buildGroundedPrompt({ task: 't', question: 'q', chunks: [] })[0].content;
  assert.match(sys, /state differently[\s\S]*say what the excerpts say about it, with its label, and do not repeat the wrong claim/);
  assert.match(sys, /Only when the excerpts say nothing at all about what the question asks, reply with one line only: "NOT FOUND: "/);
  assert.match(sys, /only some, answer those with their labels, then add one line: "Missing: "/);
  assert.match(sys, /calculation, reply in exactly this order[\s\S]*"Numbers:" naming each value you use with its label[\s\S]*"Working:"[\s\S]*"Answer:"[\s\S]*Do not state any result before the Working line/);
  // (f) arithmetic: evaluated here, a wrong stated result corrected and said; units and prose are left alone
  assert.equal(evalArithmetic('1/2 × 10 × 4^2'), 80);
  assert.equal(evalArithmetic('\\frac{18}{6}'), 3);
  assert.equal(evalArithmetic('(3 + 4)²'), 49);
  assert.equal(evalArithmetic('2 x 3'), 6);
  assert.equal(evalArithmetic('alert(1)'), null);
  assert.equal(evalArithmetic('1,284 - 284'), 1000);
  let a = checkArithmetic('So $s = 1/2 \\times 10 \\times 4^2 = 200$ m [physics.pdf p.1].');
  assert.deepEqual(a.fixes, [{ expr: '1/2 × 10 × 4^2', said: '200', got: '80' }]);
  assert.match(a.text, /= 80 m[\s\S]*Maverick checked the arithmetic: 1\/2 × 10 × 4\^2 = 80, not 200\.$/);
  assert.doesNotMatch(a.text, /wait|recalculat|correction:/i);
  a = checkArithmetic('s = 1/2 × 10 × 4^2 = 80 m, 18 / 6 = 3, 1492 − 1348 = 144, 10 / 3 = 3.33.');
  assert.equal(a.fixes.length, 0, 'right results and rounding stay');
  assert.equal(checkArithmetic('g = 10 m/s^2 × 4^2 = 80').fixes.length, 0, 'a part of an expression with units is not checked');
  assert.equal(checkArithmetic('In 2024 there were 3 rooms = 12 seats').fixes.length, 0);
  a = checkArithmetic('Numbers: g = 10 [p.1], t = 4 s\nWorking: s = 1/2 x 10 x 4^2 = 80\nAnswer: 200 m');
  assert.match(a.text, /Answer: 80 m\n\nMaverick checked the arithmetic: 1\/2 x 10 x 4\^2 = 80, not 200\.$/, 'an Answer line that disagrees with the working');
  assert.equal(checkArithmetic('Working: 18 / 6 = 3\nAnswer: 3 times more').fixes.length, 0);
  assert.equal(checkArithmetic('Working: 18 / 6 = 3\nAnswer: 3 times more than at 30 cm').fixes.length, 0, 'an Answer line with two numbers is left alone');
  const slow = Date.now();
  checkArithmetic(`${'1 + '.repeat(400)}x = 9`);
  assert.ok(Date.now() - slow < 200, 'no runaway backtracking');
  g = checkGrounded('Using g = 10 [history-chapter.docx p.1]: 1/2 × 10 × 4^2 = 200, so 200 m.', chunks, 'q');
  assert.match(g.text, /= 80, so 200 m\.[\s\S]*= 80, not 200\./, 'the checked sum goes through checkGrounded');
});

await check('auto vocabulary and the .docx reader (a minimal zip, deflated)', async () => {
  const v = extractVocab(['Project Atlas uses QRN for deliveries. The lead is Fatemah Alsabah. Atlas launches soon. The plan is ready.']);
  assert.ok(['Atlas', 'QRN', 'Fatemah', 'Alsabah', 'Project'].every((w) => v.includes(w)) && v[0] === 'Atlas', v.join(','));
  assert.ok(!v.includes('The') && !v.includes('Plan'), 'sentence-start words are not names');
  assert.equal(extractVocab(['A B C D E F G H'].concat(Array.from({ length: 50 }, (_, i) => `Name${String.fromCharCode(65 + (i % 26))}x${i}`)), 30).length <= 30, true, 'capped');
  const { deflateRawSync } = await import('node:zlib');
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Atlas &amp; QRN</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">plan </w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>المستودع &#1575;</w:t></w:r></w:p></w:body></w:document>';
  const zip = (name, data) => {
    const raw = Buffer.from(data);
    const body = deflateRawSync(raw);
    const nm = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(0, 42);
    const dirAt = 30 + nm.length + body.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(dirAt, 16);
    return Buffer.concat([local, nm, body, cen, nm, end]);
  };
  const docx = zip('word/document.xml', xml);
  const got = new TextDecoder().decode(await unzipEntry(docx, 'word/document.xml'));
  assert.equal(got, xml, 'inflated back');
  assert.equal(await unzipEntry(docx, 'word/missing.xml'), null);
  await assert.rejects(unzipEntry(Buffer.from('not a zip at all, just text bytes here'), 'x'), /not a zip/);
  assert.deepEqual(docxPages(got), ['Atlas & QRN\tplan \nLine one\nline two', 'المستودع ا']);
});

await check('CLI bridge allowlist', () => {
  for (const c of Object.keys(DEFAULT_CLI)) assert.ok(cliEntry(c, DEFAULT_CLI), c);
  assert.deepEqual(cliEntry('Codex', DEFAULT_CLI), { name: 'codex', args: DEFAULT_CLI.codex.args }, 'case-insensitive like Windows');
  for (const b of ['cmd', 'powershell', 'node', 'shim.cmd.', 'codex.cmd', '..', '..\\x', 'C:\\Windows\\System32\\cmd.exe', '', 'claude&calc'])
    assert.equal(cliEntry(b, DEFAULT_CLI), null, JSON.stringify(b));
  assert.ok(cliEntry('mytool', { mytool: { args: [] } }), 'owner additions from maverick.config.json');
  // Arguments come only from the server-side table; the model fills {model} and is checked.
  assert.deepEqual(buildCliArgs(['-p', '--model', '{model}'], 'sonnet'), ['-p', '--model', 'sonnet']);
  assert.deepEqual(buildCliArgs(['-p', '--model', '{model}'], ''), ['-p'], 'no model: the flag goes too');
  assert.deepEqual(buildCliArgs(['run', '{model}'], 'gemma4:12b'), ['run', 'gemma4:12b']);
  assert.deepEqual(buildCliArgs(['--model={model}'], ''), []);
  for (const bad of ['--dangerously-skip-permissions', '-x', 'x y', 'a;b', 'm&calc', '"q"', '../x', 'a/b', 'a'.repeat(101)]) {
    assert.throws(() => buildCliArgs(['run', '{model}'], bad), /Bad model name/, bad);
  }
});

await check('hotkey extension sends the command to the Maverick tab', async () => {
  const calls = [];
  let listener;
  globalThis.chrome = {
    commands: { onCommand: { addListener: (f) => { listener = f; } } },
    tabs: { query: async (q) => { calls.push(['query', q.url]); return [{ id: 7 }]; } },
    scripting: { executeScript: async (o) => { calls.push(['exec', o.target.tabId, o.world, o.args]); } },
  };
  const { readFile } = await import('node:fs/promises');
  new Function(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))();
  listener('answer');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [['query', ['http://localhost:5174/*', 'http://127.0.0.1:5174/*']], ['exec', 7, 'MAIN', ['answer']]]);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const keyed = Object.values(manifest.commands).filter((c) => c.suggested_key);
  assert.ok(keyed.length <= 4, 'Chrome allows at most 4 suggested keys');
  assert.ok(keyed.every((c) => /^Ctrl\+Shift\+\d$/.test(c.suggested_key.default) && c.global), 'global commands must be Ctrl+Shift+digit');
  delete globalThis.chrome;
});

// ---------------------------------------------------------------- providers: request builders

const msgs = buildPrompt('ask', { question: 'What now?', now });
const IMG = 'SU1H';
const WAV = 'UklGRg==';

await check('ollama request + NDJSON parser', () => {
  const r = PROVIDERS.ollama.build(msgs, { images: [IMG], audio: [WAV], temperature: 0 }, { url: 'http://127.0.0.1:11434/', model: 'gemma4:12b' });
  assert.equal(r.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(r.body.model, 'gemma4:12b');
  assert.equal(r.body.think, false);
  assert.equal(r.body.stream, true);
  assert.deepEqual(r.body.options, { num_ctx: OLLAMA_CTX, temperature: 0 });
  assert.equal(r.body.keep_alive, '1h');
  // Deep model: a separate default, and the warm-up after a deep run loads the live model with the live context size.
  const od = Object.fromEntries(PROVIDERS.ollama.fields.map((f) => [f.key, f.value]));
  assert.equal(od.model, 'gemma4:12b');
  assert.equal(od.deepModel, 'qwen3.8:27b');
  const w = ollamaWarm({ url: 'http://127.0.0.1:11434/', model: 'gemma4:12b' });
  assert.equal(w.url, 'http://127.0.0.1:11434/api/generate');
  assert.deepEqual(w.body, { model: 'gemma4:12b', keep_alive: '1h', options: { num_ctx: OLLAMA_CTX } }, 'no prompt: load only, same num_ctx as live requests');
  assert.equal(w.body.options.num_ctx, r.body.options.num_ctx);
  // Model roles: every provider has a live and a deep model; the deep call to Ollama unloads right after (keep_alive 0).
  for (const [id, p] of Object.entries(PROVIDERS)) assert.deepEqual(p.fields.filter((f) => /model/i.test(f.key)).map((f) => f.key), ['model', 'deepModel'], id);
  assert.equal(PROVIDERS.ollama.build(msgs, {}, { url: 'http://x', model: 'qwen3.8:27b', keepAlive: 0 }).body.keep_alive, 0, 'deep: unload after');
  assert.equal(r.body.keep_alive, '1h', 'live: stays loaded');
  assert.equal(PROVIDERS.ollama.build(msgs, { maxTokens: 400 }, { url: 'http://x', model: 'm' }).body.options.num_predict, 400, 'transcription cap');
  assert.equal(PROVIDERS.openai.build(msgs, { maxTokens: 400 }, { baseUrl: 'http://x', model: 'm' }).body.max_tokens, 400);
  assert.deepEqual(PROVIDERS.gemini.build(msgs, { maxTokens: 400 }, { key: 'k', model: 'm' }).body.generationConfig, { maxOutputTokens: 400 });
  assert.deepEqual(PROVIDERS.ollama.build(msgs, {}, { url: 'http://x', model: 'm' }).body.options, { num_ctx: 16384 });
  assert.deepEqual(r.body.messages[1].images, [IMG, WAV], 'audio rides in images');
  assert.equal(r.body.messages[0].images, undefined);
  const fixture = '{"message":{"role":"assistant","content":"Hel"},"done":false}\n{"message":{"role":"assistant","content":"lo"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true}';
  assert.equal(parseAll('ollama', fixture), 'Hello');
  assert.throws(() => PROVIDERS.ollama.parse('{"error":"model \\"x\\" not found"}'), /not found/);
});

await check('openai-compatible request + SSE parser', () => {
  const r = PROVIDERS.openai.build(msgs, { images: [IMG], audio: [WAV] }, { baseUrl: 'https://openrouter.ai/api/v1/', key: 'sk-1', model: 'm' });
  assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer sk-1');
  const parts = r.body.messages[1].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].image_url.url, `data:image/jpeg;base64,${IMG}`);
  assert.deepEqual(parts[2], { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } });
  assert.equal(typeof r.body.messages[0].content, 'string');
  const local = PROVIDERS.openai.build(msgs, {}, { baseUrl: 'http://localhost:1234/v1', key: '', model: 'm' });
  assert.equal(local.headers.authorization, undefined, 'no key for local servers');
  assert.equal(typeof local.body.messages[1].content, 'string');
  const fixture = ': keep-alive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n';
  assert.equal(parseAll('openai', fixture), 'Hi there');
  assert.throws(() => PROVIDERS.openai.parse('data: {"error":{"message":"rate limited"}}'), /rate limited/);
});

await check('anthropic request + SSE parser', () => {
  const r = PROVIDERS.anthropic.build(msgs, { images: [IMG] }, { key: 'k', model: 'claude-sonnet-5' });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(r.headers['x-api-key'], 'k');
  assert.equal(r.body.model, 'claude-sonnet-5');
  assert.equal(r.body.stream, true);
  assert.match(r.body.system, /You are Maverick/);
  assert.equal(r.body.messages.length, 1, 'system is not a message');
  assert.deepEqual(r.body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG } });
  assert.throws(() => PROVIDERS.anthropic.build(msgs, { audio: [WAV] }, { key: 'k' }), /cannot take audio/);
  assert.throws(() => PROVIDERS.anthropic.build(msgs, {}, { key: '' }), /API key/);
  const fixture = [
    'event: message_start', 'data: {"type":"message_start","message":{"id":"m"}}',
    'event: content_block_start', 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: ping', 'data: {"type":"ping"}',
    'event: content_block_delta', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Say "}}',
    'event: content_block_delta', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yes."}}',
    'event: message_stop', 'data: {"type":"message_stop"}',
  ].join('\n');
  assert.equal(parseAll('anthropic', fixture), 'Say yes.');
  assert.throws(() => PROVIDERS.anthropic.parse('data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), /Overloaded/);
});

await check('gemini request + SSE parser', () => {
  const r = PROVIDERS.gemini.build(msgs, { images: [IMG], audio: [WAV], temperature: 0 }, { key: 'g', model: 'gemini-2.5-flash' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(r.headers['x-goog-api-key'], 'g');
  assert.match(r.body.systemInstruction.parts[0].text, /You are Maverick/);
  assert.deepEqual(r.body.generationConfig, { temperature: 0 });
  const parts = r.body.contents[0].parts;
  assert.equal(r.body.contents[0].role, 'user');
  assert.deepEqual(parts[1], { inline_data: { mime_type: 'image/jpeg', data: IMG } });
  assert.deepEqual(parts[2], { inline_data: { mime_type: 'audio/wav', data: WAV } });
  const fixture = 'data: {"candidates":[{"content":{"parts":[{"text":"Good "}],"role":"model"}}]}\r\n\r\ndata: {"candidates":[{"content":{"parts":[{"text":"point."}],"role":"model"},"finishReason":"STOP"}]}\r\n';
  assert.equal(parseAll('gemini', fixture), 'Good point.');
  assert.throws(() => PROVIDERS.gemini.parse('data: {"error":{"code":400,"message":"API key not valid"}}'), /API key not valid/);
});

await check('claude code + cli bridge requests + bridge SSE parser', () => {
  const r = PROVIDERS.claudecode.build(msgs, { images: [IMG] }, { model: 'haiku', token: 't0k', server: 'http://localhost:5174' });
  assert.equal(r.url, 'http://localhost:5174/bridge/claude');
  assert.equal(r.headers['x-cue-token'], 't0k');
  assert.deepEqual(r.body, { messages: msgs, images: [IMG], model: 'haiku' });
  assert.equal(PROVIDERS.claudecode.build(msgs, {}, { token: 't' }).url, '/bridge/claude', 'relative in the browser');
  assert.throws(() => PROVIDERS.claudecode.build(msgs, { audio: [WAV] }, {}), /cannot take audio/);
  const c = PROVIDERS.cli.build(msgs, {}, { command: 'gemini', model: 'x', args: '--yolo', token: 't' });
  assert.equal(c.url, '/bridge/cli');
  assert.deepEqual([c.body.command, c.body.model, 'args' in c.body], ['gemini', 'x', false], 'the page never sends arguments');
  const fixture = 'data: {"text":"po"}\n\ndata: {"text":"ng"}\n\ndata: {"done":true}\n';
  assert.equal(parseAll('claudecode', fixture), 'pong');
  assert.throws(() => PROVIDERS.cli.parse('data: {"error":"Claude Code is not logged in."}'), /not logged in/);
  // audio-capable providers are exactly the transcription choices
  assert.deepEqual(Object.entries(PROVIDERS).filter(([, p]) => p.audio).map(([id]) => id), ['ollama', 'openai', 'gemini', 'publik']); // publik: /audio/transcriptions (transcribe)
});

await check('claude stream-json line parser (real output shape)', () => {
  const lines = [
    '{"type":"system","subtype":"init","tools":["Read"]}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"pong"}},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sub"}},"parent_tool_use_id":"toolu_1"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"pong"}',
    'not json',
  ];
  assert.deepEqual(lines.map(parseClaudeLine).filter(Boolean), [{ text: 'pong' }], 'only top-level text deltas, no duplicates');
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'), { error: 'Not logged in · Please run /login' });
});

await check('cli prompt formatting and argv template', () => {
  const p = formatForCli(msgs, ['C:\\tmp\\screen-1.jpg']);
  assert.match(p, /You are Maverick/);
  assert.match(p, /My question: What now\?/);
  assert.match(p, /C:\\tmp\\screen-1\.jpg/);
  assert.deepEqual(buildCliArgs([], 'm'), [], 'empty template: prompt on stdin only');
  assert.deepEqual(buildCliArgs(['exec', '{prompt}'], ''), ['exec', '{prompt}'], '{prompt} is not a placeholder any more');
});

await check('readLines splits across chunk boundaries', async () => {
  const body = new ReadableStream({ start(c) { for (const s of ['{"a":', '1}\n{"b"', ':2}\n\n', '{"c":3}']) c.enqueue(u8(s)); c.close(); } });
  const out = [];
  for await (const l of readLines(body)) out.push(l);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(sseData('data: [DONE]'), null);
  assert.equal(sseData('event: ping'), null);
});

await check('streamChat maps HTTP and network errors', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":"model not found"}', { status: 404 });
    await assert.rejects(streamChat(msgs, {}, { id: 'ollama', url: 'http://x', model: 'nope:1b' }).next(), /ollama pull nope:1b/);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(streamChat(msgs, {}, { id: 'ollama', url: 'http://x', model: 'm' }).next(), /Can’t reach Ollama at http:\/\/x/);
    globalThis.fetch = async () => new Response('bad', { status: 401 });
    await assert.rejects(streamChat(msgs, {}, { id: 'openai', baseUrl: 'http://x', model: 'm' }).next(), /rejected the API key/);
    globalThis.fetch = async () => new Response('nope', { status: 403 });
    await assert.rejects(streamChat(msgs, {}, { id: 'claudecode', token: 'bad' }).next(), /Reload it/);
    globalThis.fetch = async () => new Response('data: {"text":"a"}\n\ndata: {"text":"b"}\n\n');
    let text = '';
    for await (const t of streamChat(msgs, {}, { id: 'cli', command: 'x', token: 't' })) text += t;
    assert.equal(text, 'ab');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- session recording

await check('recording mode parsing: off, audio, screen; anything else is off', () => {
  assert.deepEqual(['off', 'audio', 'screen'].map(recordMode), ['off', 'audio', 'screen']);
  for (const v of [undefined, null, '', 'Audio', 'video', 1, true, {}]) assert.equal(recordMode(v), 'off', String(v));
});

await check('recording file naming: local time, numbered when taken, the only names playback serves', () => {
  const d = new Date(2026, 9, 7, 9, 5, 3);
  assert.equal(recordingName(d), 'maverick-2026-10-07-090503.webm');
  assert.equal(recordingName(d, 2), 'maverick-2026-10-07-090503-2.webm');
  for (const n of [recordingName(d), recordingName(d, 2), recordingName(new Date(), 99)]) assert.match(n, RECORDING_FILE);
  for (const n of ['maverick-2026-10-07-090503.webm.exe', 'notes.webm', 'maverick-2026-10-07-090503.md', '..\\maverick-2026-10-07-090503.webm', 'maverick-x.webm']) assert.doesNotMatch(n, RECORDING_FILE, n);
});

await check('recording folder setting: the chosen folder, or Maverick recordings under Videos', () => {
  const videos = 'C:\\Users\\A\\Videos';
  assert.equal(recordDir(undefined, videos), 'C:\\Users\\A\\Videos\\Maverick recordings');
  assert.equal(recordDir('', videos), 'C:\\Users\\A\\Videos\\Maverick recordings');
  assert.equal(recordDir('relative\\dir', videos), 'C:\\Users\\A\\Videos\\Maverick recordings', 'a relative path is never used');
  assert.equal(recordDir('D:\\Calls', videos), 'D:\\Calls');
  assert.equal(recordDirSetting('D:\\Calls'), 'D:\\Calls');
  assert.equal(recordDirSetting(''), '', 'empty goes back to the default');
  for (const v of [undefined, null, 3, 'relative', 'C:\\a\0b', `C:\\${'x'.repeat(1001)}`]) assert.equal(recordDirSetting(v), null, String(v).slice(0, 20));
});

await check('recording playback byte ranges', () => {
  assert.deepEqual(byteRange(undefined, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(byteRange('bytes=0-', 100), { start: 0, end: 99, partial: true });
  assert.deepEqual(byteRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(byteRange('bytes=90-500', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.equal(byteRange('bytes=100-', 100), null);
  assert.equal(byteRange('bytes=20-10', 100), null);
  assert.deepEqual(byteRange('items=1-2', 100), { start: 0, end: 99, partial: false });
});

await check('recording duration: space kept in the first chunk, filled in place at the end', () => {
  // EBML header, Segment (unknown size, as MediaRecorder writes it), Info { TimecodeScale 1 ms, MuxingApp "x" }, Tracks, a Cluster byte
  const info = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x4d, 0x80, 0x81, 0x78];
  const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x80 | info.length, ...info, 0x16, 0x54, 0xae, 0x6b, 0x80, 0x1f]);
  const infoEnd = 21 + 5 + info.length;
  const r = reserveDuration(head);
  assert.ok(r, 'the chunk is understood');
  assert.equal(r.at, infoEnd);
  assert.equal(r.scale, 1e6);
  assert.equal(r.buf.length, head.length + 11);
  assert.equal(r.buf[25], 0x80 | (info.length + 11), 'Info grew by the Void');
  assert.deepEqual([...r.buf.subarray(infoEnd, infoEnd + 2)], [0xec, 0x89]);
  assert.deepEqual([...r.buf.subarray(infoEnd + 11)], [...head.subarray(infoEnd)], 'the rest is untouched');
  assert.deepEqual([...r.buf.subarray(13, 21)], [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 'the unknown Segment size stays unknown');
  const dur = durationElement(12345, r.scale);
  assert.equal(dur.length, 11);
  r.buf.set(dur, r.at);
  assert.deepEqual([...r.buf.subarray(infoEnd, infoEnd + 3)], [0x44, 0x89, 0x88]);
  assert.equal(r.buf.readDoubleBE(infoEnd + 3), 12345);
  assert.equal(durationElement(1000, 1e9).readDoubleBE(3), 1, 'ticks follow the TimecodeScale');
  assert.equal(reserveDuration(r.buf), null, 'a file that has a duration is left alone');
  assert.equal(reserveDuration(Buffer.from('not webm')), null);
  assert.equal(reserveDuration(head.subarray(0, 30)), MORE, 'a chunk that ends inside Info waits for the next one');
});

await check('acceptance 2, defect B: a 1-byte first chunk (no video frame in the first second) still gets the Duration', () => {
  // the 18-minute file's header (Chromium, VP8 + Opus), cut where MediaRecorder cut it, then the rest
  const info = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x4d, 0x80, 0x81, 0x78];
  const file = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x80 | info.length, ...info, 0x16, 0x54, 0xae, 0x6b, 0x80, ...Array(1109).fill(0x1f)]);
  // main.cjs, rec-chunk: a header cut short is held and joined to the next chunk until it is whole
  let held = null;
  let out = null;
  for (const chunk of [file.subarray(0, 1), file.subarray(1, 20), file.subarray(20, 40), file.subarray(40)]) {
    const buf = held ? Buffer.concat([held, chunk]) : chunk;
    const r = reserveDuration(buf);
    held = r === MORE ? buf : null;
    if (r && r !== MORE) { out = r; break; }
  }
  assert.ok(out, 'the Void is reserved once the header is whole');
  assert.equal(out.at, 21 + 5 + info.length);
  assert.equal(reserveDuration(file.subarray(0, 1)), MORE);
  assert.equal(reserveDuration(Buffer.from('not webm')), null, 'not a WebM: written as it came, nothing held');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /if \(rec\.head\) buf = Buffer\.concat\(\[rec\.head, buf\]\);/, 'main.cjs joins a held header to the next chunk');
  assert.match(main, /rec\.head = r === recording\.MORE && buf\.length < 1 << 20 \? buf : null;\s*\n\s*if \(rec\.head\) return \{ ok: true \};/, 'and holds it while it is cut short');
  // defect G: a recording that never got a byte leaves no file, and the meeting no player
  assert.match(main, /if \(!r\.pos && !r\.head\) \{ try \{ fs\.unlinkSync\(r\.file\); \}/);
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /if \(!res\?\.file\) delete rec\.meeting\.recording;/);
});

// ---------------------------------------------------------------- copilot batch 3 (src/copilot.mjs and friends)

await check('question detection: English and Arabic questions from the other side, not statements', () => {
  for (const q of ['Can you send me the Q3 report by Thursday?', 'What is our budget for next year', 'So how do we handle the delay?', '[overlap] Why did the launch slip?',
    'Tell me what the plan is for Kuwait', 'هل خلصتوا التقرير؟', 'شلون نقدر نقلل التكاليف', 'متى بنبدأ المشروع الجديد', 'من هو المسؤول عن المستودع', 'ممكن ترسل لي الملف اليوم', 'Any thoughts on the pricing?', 'Did you finish it؟']) {
    assert.ok(isLikelyQuestion(q), q);
  }
  for (const s of ['We shipped the report on Thursday.', 'Right?', 'You know?', 'The launch is in March.', 'خلصنا التقرير أمس', 'من الشركة جاء الرد', 'What a day.', '']) {
    assert.ok(!isLikelyQuestion(s), s);
  }
});

await check('smart assist routing: a question to Answer, a slide to Explain screen, code or math to Solve', () => {
  const now = 1_000_000;
  const q = { who: 'Speaker 1', text: 'Can you walk us through the numbers?', t: now - 10_000 };
  const said = { who: 'Speaker 1', text: 'Thanks, that was clear.', t: now - 5000 };
  const mine = { who: 'You', text: 'Should I share my screen?', t: now - 3000 };
  let r = routeAssist({ transcript: [q], now, sharing: true, screen: 'Q3 results / Revenue 2.4M KWD, up 12%' });
  assert.equal(r.action, 'answer');
  assert.equal(r.line, q);
  r = routeAssist({ transcript: [q, said], now, answeredAt: now - 8000, sharing: true, screen: 'Q3 results / Revenue 2.4M KWD, up 12% / 2024-2025 plan' });
  assert.equal(r.action, 'explain', 'answered already, a slide is up');
  assert.equal(routeAssist({ transcript: [mine], now, sharing: true, screen: 'Agenda' }).action, 'explain', 'my own question is not one to answer');
  assert.equal(routeAssist({ transcript: [{ ...q, t: now - 120_000 }], now, sharing: true, screen: 'Agenda' }).action, 'explain', 'a question from two minutes ago has passed');
  assert.equal(routeAssist({ transcript: [], now, sharing: true, screen: 'def two_sum(nums, target):\n    for i in range(len(nums)):\n        return [i]' }).action, 'solve');
  assert.equal(routeAssist({ transcript: [], now, sharing: true, screen: 'Exercise 3: Solve for x: 2x + 6 = 14' }).action, 'solve');
  assert.equal(routeAssist({ transcript: [], now, sharing: false, screen: '' }).action, 'answer');
  assert.match(routeAssist({ transcript: [], now, sharing: true, screen: 'x' }).why, /slide or document/);
  assert.equal(screenKind('console.log(x);\nfunction f() { return 1; }'), 'code');
  assert.equal(screenKind('Revenue grew from 2.1M to 2.4M (+12%) in Q3 2025'), '', 'figures on a slide are not a problem');
  assert.equal(screenKind('احسب مساحة الدائرة إذا كان نصف القطر 7 سم'), 'math');
});

await check('slide hashing: a new slide counts once, a one-frame flicker and noise never do', () => {
  const W = 64;
  const H = 36;
  const frame = (draw) => { const px = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = draw(x, y); px.set([v, v, v, 255], (y * W + x) * 4); } return px; };
  const slideA = frame((x, y) => (x < 24 && y > 8 && y < 28 ? 30 : 245)); // a dark block on the left
  const slideB = frame((x, y) => (x > 40 && y > 4 ? 40 : 240)); // a dark block on the right
  const noisy = frame((x, y) => (x < 24 && y > 8 && y < 28 ? 30 : 245) + ((x * 7 + y * 13) % 3) - 1); // A with compression noise
  const [a, b, n] = [dHash(slideA, W, H), dHash(slideB, W, H), dHash(noisy, W, H)];
  assert.equal(a.length, 32, '64 edge bits and 64 light bits');
  assert.equal(hamming(a, n), 0, 'the dead zone ignores noise');
  assert.ok(hamming(a, b) >= SLIDE.threshold, `A and B differ by ${hamming(a, b)} bits`);
  // seen live: a full-screen red flash over a mostly white slide differed by only 9 edge bits; the light bits catch it
  const red = new Uint8ClampedArray(W * H * 4).map((_, i) => [198, 40, 40, 255][i % 4]);
  const white = frame((x, y) => (x < 20 && y > 30 ? 60 : 244));
  assert.ok(hamming(dHash(red, W, H), dHash(white, W, H)) >= SLIDE.threshold, `a flat red frame is not the white slide (${hamming(dHash(red, W, H), dHash(white, W, H))} bits)`);
  assert.equal(hamming(a, 'zz'), Infinity);
  assert.equal(blockGray(slideA, W, H).length, 72);
  const run = (hashes) => { let st = SLIDE_START; const changes = []; hashes.forEach((h, i) => { const r = slideStep(st, h, i * 700); st = r.state; if (r.change) changes.push(r.change.t); }); return { st, changes }; };
  let { st, changes } = run([a, a, a, b, a, a]);
  assert.deepEqual(changes, [0], 'the first screen once; the one-frame flicker to B does not count');
  assert.equal(st.flickers, 1);
  ({ st, changes } = run([a, a, b, b, b]));
  assert.deepEqual(changes, [0, 1400], 'B counts once, dated at its first frame');
  ({ changes } = run([a, a, b, a, b, a]));
  assert.deepEqual(changes, [0], 'alternating single frames never count');
  ({ changes } = run([a, n, a, n]));
  assert.deepEqual(changes, [0], 'noise is the same screen');
});

await check('pointing phrases in English and Arabic, with negatives, linked to the screen read active then', () => {
  for (const s of ['As you can see, this is our target', 'Look at this chart', 'this number is the one that matters', 'the spike here is March', 'These figures are final',
    'هذا هو الهدف', 'شوف الرقم', 'زي ما تشوفون المبيعات زادت', 'وهذه النسبة', 'هنا المشكلة', 'كما ترون الأرقام']) assert.ok(isPointing(s), s);
  for (const s of ['Where is the report?', 'There are three options', 'I hear you', 'This morning we met the client', 'That is a good point',
    'هناك ثلاث خيارات', 'لهذا السبب تأخرنا', 'شوفت الإيميل أمس', '']) assert.ok(!isPointing(s), s);
  const screens = [{ t: 1000, text: 'Target 4,750 units' }, { t: 5000, text: 'Hiring plan' }];
  assert.equal(screenAt(screens, 3000).t, 1000);
  assert.equal(screenAt(screens, 5000).t, 5000);
  assert.equal(screenAt(screens, 500), null);
  assert.equal(screenAt([], 9), null);
});

await check('prompts carry the screen reads in time order, earlier meetings, style rules and the caught question', () => {
  const start = 0;
  const screens = [{ t: 70_000, text: 'Hiring plan\nEngineers: 6' }, { t: 10_000, text: 'Q3 target\n4,750 units' }, { t: 90_000, text: '' }];
  const lines = [{ who: 'Speaker 1', text: 'As you can see, this is our target', t: 20_000, screen: 10_000 }, { who: 'Speaker 2', text: 'Next slide.', t: 69_000 }];
  const text = screenReadsText(screens, lines, start);
  assert.ok(text.indexOf('[00:10] Screen: Q3 target / 4,750 units') < text.indexOf('[01:10] Screen: Hiring plan / Engineers: 6'), 'oldest first');
  assert.match(text, /\[00:10\] Screen: Q3 target \/ 4,750 units\n {2}Pointed at by \[00:20\] Speaker 1: As you can see, this is our target/);
  assert.equal((text.match(/Screen:/g) || []).length, 2, 'a pending read is left out');
  assert.equal(screenReadsText([], lines, 0), '');
  const capped = screenReadsText(Array.from({ length: 50 }, (_, i) => ({ t: i * 1000, text: `slide ${i} ${'x'.repeat(300)}` })), [], 0, 2000);
  assert.ok(capped.length < 2600 && capped.includes('slide 49') && !capped.includes('slide 0 '), 'over the cap, the oldest go first');
  assert.match(formatTranscript(lines, 0, 0), /\[00:20\] Speaker 1: As you can see, this is our target \(pointing at the screen shown at \[00:10\]\)/);
  const hist = [1, 2, 3, 4].map((n) => ({ id: `m${n}`, title: `Weekly ${n}`, startedAt: Date.UTC(2026, 9, n), summary: `## Summary\nDecision ${n}.`, transcript: [] }));
  const earlier = earlierMeetingsText([...hist, { id: 'now', title: 'Now', startedAt: Date.UTC(2026, 9, 9), summary: 'this one', transcript: [] }, { id: 'e', title: 'Empty', startedAt: Date.UTC(2026, 9, 8), summary: '', transcript: [] }], 'now');
  assert.match(earlier, /^Earlier meetings, from my History, newest first/);
  assert.deepEqual([...earlier.matchAll(/### Earlier meeting E\d: (Weekly \d) \((2026-10-0\d)\)/g)].map((m) => m[1]), ['Weekly 4', 'Weekly 3', 'Weekly 2'], 'the last three with notes, not this one');
  assert.ok(!earlier.includes('Decision 1') && !earlier.includes('this one'));
  assert.equal(earlierMeetingsText([], 'x'), '');
  const tr = [{ who: 'Speaker 1', text: 'Can you send the report?', t: 30_000 }];
  const ctx = { transcript: tr, startedAt: 0, now: 40_000, screens: text, earlier, style: 'Answer in bullets, max 3 sentences.' };
  for (const action of ['answer', 'ask', 'followup']) assert.ok(buildPrompt(action, { ...ctx, question: 'q' })[1].content.includes('### Earlier meeting E1: Weekly 4'), action);
  for (const action of ['explain', 'solve', 'recap', 'summary']) assert.ok(!buildPrompt(action, ctx)[1].content.includes('Earlier meeting'), `${action} stays on this meeting`);
  for (const action of ['answer', 'ask', 'explain', 'solve', 'followup', 'recap']) {
    assert.ok(buildPrompt(action, { ...ctx, question: 'q' })[1].content.includes('My style rules, follow them in this answer: Answer in bullets, max 3 sentences.'), `style in ${action}`);
  }
  assert.ok(!buildPrompt('summary', ctx)[1].content.includes('My style rules'), 'the notes keep their fixed sections');
  for (const action of ['answer', 'ask', 'recap', 'summary']) assert.ok(buildPrompt(action, { ...ctx, question: 'q' })[1].content.includes('[00:10] Screen: Q3 target'), `screen reads in ${action}`);
  assert.match(buildPrompt('summary', ctx)[1].content, /Use what the shared screen showed too/);
  assert.match(buildPrompt('answer', { ...ctx, question: 'Can you send the report?' })[1].content, /The question to answer, just asked in the meeting: Can you send the report\?/);
  assert.ok(!/question to answer/.test(buildPrompt('answer', ctx)[1].content));
  assert.equal(buildPrompt('answer', { transcript: tr, startedAt: 0, now: 40_000 })[1].content, buildPrompt('answer', { transcript: tr, startedAt: 0, now: 40_000, screens: '', earlier: '', style: '  ' })[1].content, 'nothing added when empty');
  assert.match(buildGroundedPrompt({ task: 't', question: 'q', chunks: [], style: 'Bullets only.' })[1].content, /t\n\nMy style rules, follow them in this answer: Bullets only\.\n\nq$/);
});

await check('egress counter: bytes counted where requests leave this PC, zero for local Ollama', async () => {
  const seen = [];
  const fn = (n, url) => seen.push([n, url]);
  egress.add(fn);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":{"content":"ok"},"done":true}\n', { status: 200 });
  try {
    for await (const _ of streamChat([{ role: 'user', content: 'hi' }], {}, { id: 'ollama', url: 'http://127.0.0.1:11434', model: 'gemma4:12b' })) { /* drain */ }
    assert.equal(seen.length, 0, 'local Ollama: nothing leaves');
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n', { status: 200 });
    const conf = { id: 'openai', baseUrl: 'https://api.openai.com/v1', key: 'k', model: 'm' };
    for await (const _ of streamChat([{ role: 'user', content: 'héllo' }], {}, conf)) { /* drain */ }
    const req = PROVIDERS.openai.build([{ role: 'user', content: 'héllo' }], {}, conf);
    assert.deepEqual(seen, [[requestBytes(JSON.stringify(req.body), req.headers), 'https://api.openai.com/v1/chat/completions']], 'a cloud provider: the exact body and header bytes');
    assert.equal(requestBytes('é', { a: 'b' }), 2 + 'a: b\r\n'.length, 'UTF-8 bytes, not characters');
    seen.length = 0;
    globalThis.fetch = async () => new Response('data: {"text":"ok"}\n', { status: 200 });
    for await (const _ of streamChat([{ role: 'user', content: 'q' }], { web: true }, { id: 'claudecode', model: '', token: 't' })) { /* drain */ }
    assert.equal(seen.length, 1, 'Web answers go through Claude Code to the cloud, though the bridge is on this PC');
  } finally {
    globalThis.fetch = realFetch;
    egress.delete(fn);
  }
  assert.ok(isLocalHost('http://localhost:11434/api/chat') && isLocalHost('/bridge/claude') && !isLocalHost('https://api.anthropic.com/v1/messages'));
  assert.ok(!leavesPc({ id: 'cli', command: 'ollama' }, '/bridge/cli') && leavesPc({ id: 'cli', command: 'gemini' }, '/bridge/cli'));
  assert.ok(!leavesPc({ id: 'openai' }, 'http://127.0.0.1:1234/v1/chat/completions') && leavesPc({ id: 'ollama' }, 'http://10.0.0.5:11434/api/chat'));
  assert.equal(countSend('http://127.0.0.1:11434/api/embed', '{"input":"x"}', {}), 0);
});

await check('RTL math: formulas inside Arabic answers are isolated left to right, never reordered', () => {
  const ar = renderMarkdown('الناتج هو 12 × 3 + 4 = 40 تقريبا.');
  assert.match(ar, /<bdi dir="ltr">12 × 3 \+ 4 = 40<\/bdi>/);
  assert.match(renderMarkdown('الناتج هو 40.\n\n- أولا 12 × 3 = 36\n- English line', { bidi: true }), /^<p dir="auto">الناتج[\s\S]*<li dir="auto">أولا[\s\S]*<li>English line<\/li>/, 'answer cards: Arabic blocks read right to left');
  assert.match(ar, /^<p>/, 'without bidi the block keeps its markup');
  assert.match(renderMarkdown('المعادلة $x^{2} + 3x = 10$ هنا'), /<bdi dir="ltr">x<sup>2<\/sup> \+ 3x = 10<\/bdi>/);
  assert.match(renderMarkdown('السرعة \\(v = \\frac{d}{t}\\) دائما'), /<bdi dir="ltr">v = \(d\)\/\(t\)<\/bdi>/);
  assert.match(renderMarkdown('إذا كان 5 - 3 = 2 و a &lt; b'), /<bdi dir="ltr">5 - 3 = 2<\/bdi>/);
  assert.match(renderMarkdown('الناتج ١٢ × ٣ = ٣٦ دائما'), /<bdi dir="ltr">١٢ × ٣ = ٣٦<\/bdi>/, 'Arabic-Indic digits too');
  assert.match(renderMarkdown('اكتب `a = b + 1` في الكود'), /<code dir="ltr">a = b \+ 1<\/code>/);
  assert.equal(renderMarkdown('In English 5 - 3 = 2 stays as it is.'), '<p>In English 5 - 3 = 2 stays as it is.</p>', 'left-to-right text is not touched');
  assert.doesNotMatch(renderMarkdown('اجتماع يوم الخميس الساعة 10:30'), /bdi/, 'a time alone is not a formula');
  assert.match(renderMarkdown('**الجواب: 1/2 × 10 × 4^2 = 80 م**'), /<strong>الجواب: <bdi dir="ltr">1\/2 × 10 × 4<sup>2<\/sup> = 80<\/bdi> م<\/strong>/);
  assert.equal(latexMath('\\frac{1}{2} \\times g \\cdot t^{2}'), '(1)/(2) × g · t^2');
});

await check('citation targets: [mm:ss] chips name their moment, [file p.N] chips their file and page', () => {
  const html = linkCites('<p>She asked about the budget [12:40, 13:05].</p><p>It slipped [1:02:03]</p>');
  assert.deepEqual([...html.matchAll(/class="cite" data-cmd="cite" data-t="([\d:]+)"/g)].map((m) => m[1]), ['12:40', '13:05', '1:02:03']);
  assert.match(html, /budget\.<button/, 'after the full stop');
  const files = [{ id: 'f9', name: 'atlas brief.pdf', pages: ['a', 'b', 'c'] }];
  const chips = sourceChips('<p>On 14 March [atlas brief.pdf p.1], see [atlas brief.pdf p.7] and [gone.pdf p.1].</p>', [], files);
  assert.match(chips, /data-cmd="src" data-file="f9" data-page="1"/, 'a file still in the library opens at its page from History');
  assert.ok(chips.includes('[atlas brief.pdf p.7]') && chips.includes('[gone.pdf p.1]'), 'a page it does not have, or a removed file, stays text');
  const md = meetingToMarkdown({ title: 'T', startedAt: 0, endedAt: 60_000, egress: 0, transcript: [{ who: 'Speaker 1', text: 'this number', t: 20_000, screen: 10_000 }],
    screens: [{ t: 10_000, text: 'Target\n4,750' }], answers: [{ label: 'Answer', question: 'q', text: 'It is 4,750. [00:20]', at: 30_000, ttfw: 1840 }], summary: '' });
  assert.match(md, /Sent off this PC: 0 bytes\./);
  assert.match(md, /### Answer: q \(00:30, first word in 1\.8 s\)/, 'the speed meter is kept in History');
  assert.match(md, /## Shared screen\n\n- \*\*00:10 Screen:\*\* Target \/ 4,750/);
  assert.match(md, /- \*\*00:20 Speaker 1:\*\* this number \(pointing at the screen shown at 00:10\)/);
});

await check('remote-session flag: an RDP session warns, the console does not', () => {
  assert.ok(isRemoteSession({ sessionName: 'RDP-Tcp#3' }));
  assert.ok(isRemoteSession({ sessionName: 'rdp-tcp#0' }));
  assert.ok(isRemoteSession({ sessionName: 'Console', metric: 1 }), 'GetSystemMetrics(SM_REMOTESESSION) not 0');
  assert.ok(!isRemoteSession({ sessionName: 'Console', metric: 0 }));
  assert.ok(!isRemoteSession({}));
  assert.ok(!isRemoteSession({ sessionName: 'Console', metric: 'x' }));
});

// Screen sharing: anything that opens its own OS window would show in a share while Maverick hides (content
// protection covers only Maverick's own windows). So no title tooltips, native dialogs, notifications, native menus
// or taskbar flashes anywhere in the app.
await check('no native popups that a screen share would see', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const page = src('index.html') + src('src/app.mjs');
  assert.doesNotMatch(page, /\stitle="|\.title\s*=(?!\s*'Maverick')|setAttribute\('title'/, 'tooltips use data-tip, not title');
  const all = page + src('desktop/main.cjs') + src('desktop/preload.cjs');
  for (const re of [/\b(confirm|alert|prompt)\(/, /new Notification\b/, /flashFrame|displayBalloon|showMessageBox|showErrorBox|setContextMenu|\.popup\(|popUpContextMenu/]) {
    assert.doesNotMatch(all, re, String(re));
  }
  assert.match(src('styles.css'), /\.dlg select, \.dlg ::picker\(select\) \{ appearance: base-select; \}/, 'dropdowns are drawn in the page');
  // The one accepted exception: the recordings folder dialog, only on the explicit Choose folder click.
  assert.doesNotMatch(all, /showSaveDialog|showOpenDialogSync|showSaveDialogSync/);
  assert.equal(all.match(/showOpenDialog\b/g)?.length, 1, 'one native dialog in the app');
  assert.match(src('desktop/main.cjs'), /ipcMain\.handle\('pick-record-dir'[^\n]*\n[^\n]*\n\s+const r = await dialog\.showOpenDialog\(/, 'and it is the recordings folder picker');
  assert.match(src('src/app.mjs'), /\$\('#set-record-dir'\)\.addEventListener\('click', async \(\) => \{\r?\n\s+const dir = await desk\.pickRecordDir\(\);/, 'opened only by the Choose folder click');
  // Electron cannot content-protect it, so the Settings row says so next to the button (fix pass 2026-10-17, item 7)
  assert.match(src('index.html'), /id="set-record-dir"[^\n]*<small>Choose folder opens the Windows folder window, which screen shares show/, 'the Choose folder row says its window shows in shares');
});

// ---------------------------------------------------------------- acceptance test fixes (2026-10-17), one check each

await check('acceptance 1: a whole equation in Arabic is one left-to-right unit, terms like 5x included', () => {
  const q = renderMarkdown('إذا كان 5x - 3 = 2x + 9 فكم قيمة x؟', { bidi: true });
  assert.match(q, /<bdi dir="ltr">5x - 3 = 2x \+ 9<\/bdi>/, 'not 9 + 2x = 3 - 5x, and not a lone "3 = 9"');
  assert.match(renderMarkdown('…المعادلة: 3x = 12'), /<bdi dir="ltr">3x = 12<\/bdi>/);
  assert.match(renderMarkdown('نطرح 2x من الطرفين: 5x - 2x - 3 = 9، إذن x = 4'), /<bdi dir="ltr">5x - 2x - 3 = 9<\/bdi>، إذن <bdi dir="ltr">x = 4<\/bdi>/);
  assert.match(renderMarkdown('الحل x = -4 هنا'), /<bdi dir="ltr">x = -4<\/bdi>/, 'a negative result stays with its sign');
  assert.doesNotMatch(renderMarkdown('اجتماع يوم الخميس الساعة 10:30'), /bdi/);
});

await check('acceptance 2: TeX delimiters never show, in English cards too; prices stay', () => {
  assert.equal(renderMarkdown('Subtract 7 from both sides: $3x = 18$'), '<p>Subtract 7 from both sides: 3x = 18</p>');
  assert.equal(renderMarkdown('Then $x^{2} = 9$, so \\(x = 3\\).'), '<p>Then x<sup>2</sup> = 9, so x = 3.</p>');
  assert.equal(renderMarkdown('$$y = \\frac{1}{2}$$'), '<p>y = (1)/(2)</p>');
  assert.equal(renderMarkdown('It costs $5 and $10 today'), '<p>It costs $5 and $10 today</p>');
  assert.equal(renderMarkdown('between $5-$10'), '<p>between $5-$10</p>');
  assert.equal(renderMarkdown('`$x$` in code'), '<p><code>$x$</code> in code</p>', 'code keeps its dollars');
});

await check('acceptance 3: the speech gate and the turn filter drop invented lines and keep speech', async () => {
  const { keepTurns } = await import('../src/prompts.mjs');
  const { noiseStep, speechGate } = await import('../src/audio.mjs');
  const R = 16000;
  const tone = (s) => Float32Array.from({ length: R * s }, (_, i) => 0.1 * Math.sin(i / 3));
  const quiet = (s) => new Float32Array(R * s);
  const cat = (...p) => concatFloat32(p);
  assert.ok(!speechGate(cat(quiet(1), tone(0.1), quiet(1)), R).pass, 'a 100 ms click is not speech');
  assert.ok(speechGate(cat(quiet(0.5), tone(0.8), quiet(0.6)), R).pass);
  const hum = Float32Array.from({ length: R * 2 }, (_, i) => 0.02 * Math.sin(i / 5));
  assert.ok(speechGate(hum, R).pass && !speechGate(hum, R, 0.004, 0.02).pass, 'a steady hum at the noise floor is not speech');
  let floor = 0;
  for (let i = 0; i < 50; i++) floor = noiseStep(floor, 0.02, 85);
  assert.ok(Math.abs(floor - 0.02) < 1e-9 && noiseStep(floor, 0.2, 85) < 0.0205, 'the floor follows the quiet level and rises slowly');
  // one run of speech ("Good morning."): the model's made-up dialogue after it goes
  const one = cat(quiet(0.5), tone(0.8), quiet(0.6));
  const g1 = speechGate(one, R);
  assert.equal(g1.segments, 1);
  const turns = ['Good morning.', 'How are you?', 'I am fine, thank you.', 'My name is John.'].map((text) => ({ text, overlap: false }));
  assert.deepEqual(keepTurns(turns, one, g1).map((t) => t.text), ['Good morning.']);
  assert.deepEqual(keepTurns([{ text: '[Arabic] يا هلا والله.' }, { text: 'Thank you for watching.' }], one, g1), [], 'labels and artifacts');
  const hi = cat(quiet(0.5), tone(0.5), quiet(0.6));
  assert.deepEqual(keepTurns([{ text: 'يا هلا والله' }, { text: '[English] Welcome.' }], hi, speechGate(hi, R)), [], 'half a second of speech answered with a labelled translation');
  const seen = parseTurns('The provided audio is a recording of a conversation between two people.\n\n[Arabic]\nيا هلا والله\n[English]\nHello\n');
  assert.ok(seen.suspect && seen.length === 2, 'labels on their own lines and a description of the audio mark the reply');
  assert.deepEqual(keepTurns(seen, hi, speechGate(hi, R)), [], 'seen live in the app: the Arabic greeting for "Hi team." is not kept');
  assert.equal(parseTurns('Good morning.').suspect, false);
  // two runs: two lines kept, each with its share of the speech
  const two = cat(quiet(0.3), tone(1), quiet(0.5), tone(1), quiet(0.3));
  const g2 = speechGate(two, R);
  const kept = keepTurns([{ text: 'Sarah will send the budget.' }, { text: 'Omar will review it.' }], two, g2);
  assert.equal(kept.length, 2);
  assert.ok(kept[0].start === 0 && kept[1].end === two.length && kept[0].end <= kept[1].start + R * 0.6, 'the spans cover the chunk in order');
  assert.deepEqual(keepTurns([{ text: 'We agreed to move the launch to Thursday.' }], one, g1, [{ text: 'We agreed to move the launch to Thursday.' }]), [], 'a line repeated word for word');
  assert.deepEqual(parseTurns('00:00:00.000 -> 00:00:01.000: [unclear]\n00:00:01.000 -> 00:00:02.000: [unclear]'), [], 'subtitle ranges over silence');
});

await check('acceptance 4: a time from an earlier meeting links to that meeting, never to this transcript', () => {
  const earlier = [{ id: 'm1', title: 'Budget sync', summary: '## Decisions\n- Sarah sends the budget [00:20]' }];
  const here = (t) => t === '00:11';
  const html = linkCites('<p>Sarah sends it [E1 00:20]. Also [00:20]. Now [00:11]. Lost [07:07].</p>', { here, earlier });
  assert.equal((html.match(/data-cmd="earlier" data-m="m1" data-t="00:20"/g) || []).length, 2, 'tagged, and bare but in the earlier notes');
  assert.equal((html.match(/data-cmd="cite"/g) || []).length, 1);
  assert.match(html, /data-cmd="cite" data-t="00:11"/);
  assert.doesNotMatch(html, /07:07/, 'a time of no meeting is dropped');
  assert.match(linkCites('<p>Layla sends it [E1 00:11].</p>', { here, earlier }), /data-cmd="cite" data-t="00:11"/, 'a line of this meeting the model tagged E1 is a jump');
  assert.match(linkCites('<p>x [00:20].</p>'), /data-cmd="cite" data-t="00:20"/, 'History and the notes keep plain jumps');
  const text = earlierMeetingsText([{ id: 'm1', title: 'Budget sync', startedAt: 1, summary: '- Sarah sends the budget [00:20]', transcript: [] }], 'now');
  assert.match(text, /### Earlier meeting E1: Budget sync[^\n]*\n- Sarah sends the budget \[E1 00:20\]/);
  assert.match(text, /like \[E1 00:20\], never as a bare \[00:20\]/);
});

await check('acceptance 5: the recording file gets its length after every chunk, not only at a clean stop', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /rec\.pos \+= buf\.length;\s*\n\s*if \(rec\.voidAt >= 0\) fs\.writeSync\(rec\.fd, recording\.durationElement\(Date\.now\(\) - rec\.t0, rec\.scale\), 0, 11, rec\.voidAt\);/);
  const head = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from([0x80]), Buffer.from('18538067', 'hex'), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from('1549a966', 'hex'), Buffer.from([0x84]), Buffer.from('2ad7b1', 'hex'), Buffer.from([0x81, 0x40])]);
  const r = reserveDuration(head);
  assert.ok(r, 'the Void is reserved');
  const buf = Buffer.from(r.buf);
  durationElement(5000, r.scale).copy(buf, r.at);
  assert.equal(buf.readDoubleBE(r.at + 3), (5000 * 1e6) / r.scale, 'a later write of the same slot holds the length');
});

await check('acceptance 6: Ask uses the whole meeting, and the matching earlier lines when it does not fit', async () => {
  const { relevantLines } = await import('../src/prompts.mjs');
  const start = 0;
  const lines = [{ who: 'Speaker 1', text: 'Sarah will send the budget by Friday.', t: 20_000 }];
  for (let t = 60_000; t < 9 * 60_000; t += 4000) lines.push({ who: 'Speaker 2', text: `We talked about the store layout and the shelves, item ${t}. `.repeat(3), t });
  const p = buildPrompt('ask', { transcript: lines, question: 'Who will send the budget?', startedAt: start, now: 9 * 60_000 })[1].content;
  assert.match(p, /Earlier lines of this meeting that may answer the question:\n\[00:20\] Speaker 1: Sarah will send the budget by Friday\./);
  assert.match(p, /Transcript, the latest part:/);
  const small = buildPrompt('ask', { transcript: lines.slice(0, 3), question: 'Who will send the budget?', startedAt: start, now: 9 * 60_000 })[1].content;
  assert.match(small, /Transcript so far:\n\[00:20\] Speaker 1: Sarah will send/, 'a meeting that fits goes in whole');
  assert.ok(p.length < MAX_TRANSCRIPT_CHARS + 6000, 'within the prompt budget');
  assert.deepEqual(relevantLines(lines, 'من سيرسل الميزانية؟', 1e9), [], 'no shared words, nothing added');
  const caught = buildPrompt('answer', { transcript: lines, question: 'Who sends the budget?', startedAt: start, now: 9 * 60_000 })[1].content;
  assert.match(caught, /Earlier lines of this meeting[^\n]*\n\[00:20\] Speaker 1: Sarah/, 'Answer to a caught question too');
});

await check('acceptance 2, defect A: a throw while an answer card starts ends that card; keepFocus survives a card the bar dropped', () => {
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const run = app.slice(app.indexOf('async function runAction'), app.indexOf('// What every answer prompt carries'));
  assert.ok(run.indexOf('try {') < run.indexOf('renderAnswers();'), 'the first paint is inside the try, so finally ends the card and clears active');
  const keep = app.slice(app.indexOf('function keepFocus'), app.indexOf('function renderAnswers'));
  assert.match(keep, /const card = \$\(`\.answer\[data-id="\$\{id\}"\]`, box\);\n\s*if \(!card\) return;/);
});

await check('acceptance 2, defect C: a reasoning model\'s notes to itself never reach the card; nothing left means the live model answers', async () => {
  const { stripThinking } = await import('../src/prompts.mjs');
  // the card the ghost pass saw: qwen3.8:27b, Think harder on an Arabic Recap
  const leaked = 'The user wants a recap of the meeting so far. Constraints:\n\nFormat: At most 8 short bullets.\nLanguage: Arabic (since previous answers were in Arabic).\n\n'
    + 'Key points from transcript:\n\n01:00 Discussion about Jleeb branch.\n\nDrafting bullets in Arabic:\n\nانخفاض مبيعات فرع الجهراء بسبب صيانة المواقف01:20\n\nCheck constraints:\n\nAt most 8 bullets? Yes (7).\n\nLooks good.';
  assert.equal(stripThinking(leaked), '');
  assert.equal(stripThinking('<think>The user wants a recap.</think>\n\n- ارتفعت المبيعات [00:35]'), '- ارتفعت المبيعات [00:35]');
  assert.equal(stripThinking('Okay, so the meeting is about sales.\n</think>\n- Sales rose [00:35]'), '- Sales rose [00:35]', 'only the closing tag reached the reply');
  assert.equal(stripThinking('<think>still thinking about'), '', 'an open block is hidden while it streams');
  for (const ok of ['- ارتفعت مبيعات فرع السالمية 12% [00:35]', 'We need to send the budget by Friday.', 'I need to check with Sarah first, then I will confirm.', 'The user guide is on page 4.']) {
    assert.equal(stripThinking(ok), ok, `an answer is kept: ${ok}`);
  }
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /card\.raw \+= t; card\.text = dropPlaceholders\(stripThinking\(card\.raw\)\);/, 'the card shows only what is left');
  assert.match(app, /const answered = \(\) => \{ if \(!card\.text && card\.raw\.trim\(\)\) throw new Error\('it wrote only its reasoning, no answer'\); \};/);
  // the deep model's empty answer goes through the fallback that answers with the live model and says so in the note
  const run = app.slice(app.indexOf('async function runAction'), app.indexOf('// What every answer prompt carries'));
  assert.ok(run.indexOf('answered();') < run.indexOf("if (!dc || card.text || e.name === 'AbortError') throw e;"));
  // End & summarize: the notes, each part of a long meeting and the unclear-words pass keep no reasoning either; reasoning
  // alone throws into deepFailed, so the live model writes the notes and their first line says why
  assert.match(app, /function notesText\(raw\) \{\n\s*const s = stripThinking\(raw\);\n\s*if \(!s\.trim\(\) && raw\.trim\(\)\) throw new Error\('it wrote only its reasoning, no notes'\);/);
  const stream = app.slice(app.indexOf('async function streamInto'), app.indexOf('// The live transcript is cleared'));
  assert.match(stream, /text = stripThinking\(raw\);/, 'what streams into the notes is stripped too');
  assert.match(stream, /text = fixMixedScript\(notesText\(raw\)\);/);
  assert.match(app, /notes\.push\(`### Part \$\{i \+ 1\}\\n\$\{notesText\(n\)\.trim\(\)\}`\);/, 'each part of a long meeting');
  assert.match(app, /parseFills\(notesText\(out\), m\.transcript\)/, 'the unclear-words pass');
  const end = app.slice(app.indexOf('async function endMeeting'), app.indexOf('let histSelected'));
  assert.match(end, /if \(deep\) \{ try \{ text = await write\(deep, .*?\); \} catch \(e\) \{ deepFailed\(e\); \} \}/, 'a throw in the deep notes goes to the fallback');
});

await check('acceptance 2, defect E: no "no transcript" placeholder goes into the prompt as citable text, or out of a card', async () => {
  const { dropPlaceholders } = await import('../src/prompts.mjs');
  const q = 'إذا كان 5x - 3 = 2x + 9 فكم قيمة x؟ اكتب الخطوات';
  const p = buildPrompt('ask', { transcript: [], question: q, now: 1000 })[1].content;
  assert.doesNotMatch(p, /No transcript yet|Transcript so far/, 'an Ask with no meeting has no empty transcript block');
  assert.match(p, /There are no transcript lines for this, so there is nothing to cite: write no time and no note in square brackets\./);
  assert.match(buildPrompt('solve', { transcript: [], hasImage: true, now: 1000 })[1].content, /There are no transcript lines for this/, 'Solve and Explain with no meeting too');
  // the card the ghost pass saw: every step ended with the placeholder
  const card = '- اطرح 2x من الطرفين: 3x - 3 = 9 [لا يوجد نص سابق].\n- أضف 3 إلى الطرفين: 3x = 12 [لا يوجد نص سابق].\n- اقسم على 3: x = 4 [لا يوجد نص سابق].';
  assert.equal(dropPlaceholders(card), '- اطرح 2x من الطرفين: 3x - 3 = 9.\n- أضف 3 إلى الطرفين: 3x = 12.\n- اقسم على 3: x = 4.');
  assert.equal(dropPlaceholders('Sarah sends it. [No transcript yet.] And (no previous text) here.'), 'Sarah sends it. And here.');
  for (const ok of ['Sarah sends it. [00:20]', 'لا يوجد تأخير في الإطلاق (لا يوجد تأخير). [01:10]', 'Use [E1 00:20] here.']) assert.equal(dropPlaceholders(ok), ok, `kept: ${ok}`);
});

await check('acceptance 2, defect H: Answer to a caught question reaches the whole meeting, not the last 2 minutes', () => {
  // the smoke run: the facts minutes before the question, a slide equation on screen; one fact shares no word with it
  const lines = [
    { who: 'Speaker 1', text: 'Sarah owns the supplier contract.', t: 20_000 },
    { who: 'Speaker 2', text: 'We have forty thousand to spend this quarter.', t: 60_000 },
    { who: 'Speaker 1', text: 'Next slide is the growth equation.', t: 280_000 },
    { who: 'Speaker 2', text: 'Who owns the supplier contract and what is the budget?', t: 300_000 },
  ];
  const q = 'Who owns the supplier contract and what is the budget?';
  const p = buildPrompt('answer', { transcript: lines, question: q, startedAt: 0, now: 301_000, screens: 'Screen: y = 2x + 3' })[1].content;
  assert.match(p, /Transcript so far:\n\[00:20\] Speaker 1: Sarah owns the supplier contract\.\n\[01:00\] Speaker 2: We have forty thousand/, 'the whole meeting goes in');
  assert.match(p, /however long ago; use the shared screen only when the question is about it/);
  const plain = buildPrompt('answer', { transcript: lines, startedAt: 0, now: 301_000 })[1].content;
  assert.match(plain, /Transcript, last 2 minutes:/, 'Answer without a caught question stays on the last 2 minutes');
  assert.doesNotMatch(plain, /forty thousand/);
});

await check('acceptance 7: a flag marks the line spoken at it, and the notes get the nearest lines for a pause', async () => {
  const { flagLine } = await import('../src/prompts.mjs');
  const lines = [{ t: 47_000 }, { t: 230_000 }, { t: 240_000 }, { t: 300_000 }];
  assert.equal(flagLine(lines, 237_000), 1, 'the line being spoken (started 7 s before), not the nearest start');
  assert.equal(flagLine(lines.slice(0, 1), 237_000), 0, 'only one line yet: that one');
  assert.equal(flagLine(lines, 275_000), 3, 'in a pause: the nearest line');
  const tr = [{ who: 'Speaker 1', text: 'Omar will review the dashboard.', t: 215_000 }, { who: 'Speaker 2', text: 'The budget is 50,000 dinar.', t: 262_000 }];
  const notes = buildPrompt('summary', { transcript: tr, startedAt: 0, flags: [237_000], now: 300_000 })[1].content;
  assert.match(notes, /- \[03:57\] \(a pause; the nearest lines\) \[03:35\] Speaker 1: Omar will review the dashboard\. \/ \[04:22\] Speaker 2: The budget is 50,000 dinar\./);
  assert.doesNotMatch(notes, /nothing was transcribed within/);
});

await check('acceptance 8: notes keep only decisions and action items a cited transcript line backs', async () => {
  const { groundNotes } = await import('../src/meetings.mjs');
  const lines = [{ who: 'S1', text: 'Let us move the product launch to Thursday.', t: 5000 }, { who: 'S1', text: 'Sarah will send the budget by Friday.', t: 20_000 },
    { who: 'S2', text: 'Omar will review the dashboard.', t: 35_000 }];
  const md = '## Summary\nThe budget came up [00:20].\n\n## Decisions\n- The product launch moves to Thursday. [00:05]\n- The budget was approved in principle. [00:20]\n- Marketing gets two people.\n\n'
    + '## Action items\n- [ ] Sarah: send the budget (due Friday) [00:20]\n- [ ] Ali: book the venue [00:50]';
  const g = groundNotes(md, lines, 0);
  assert.ok(g.text.includes('- The product launch moves to Thursday. [00:05]') && g.text.includes('- [ ] Sarah: send the budget (due Friday) [00:20]'));
  assert.ok(!/approved in principle|Marketing|Ali/.test(g.text), 'an invented decision, an uncited one and one citing no line are dropped');
  assert.equal(g.dropped.length, 3);
  assert.match(g.text, /The budget came up \[00:20\]\./, 'the summary prose is left alone');
  assert.match(groundNotes('## Decisions\n- Nothing real [00:40]\n\n## Action items\nNone noted.', lines, 0).text, /## Decisions\n\nNone noted\.\n## Action items/);
  const ar = groundNotes('## Decisions\n- Launch on Thursday [00:05]', [{ who: 'S1', text: 'قررنا نأجل الإطلاق ليوم الخميس', t: 5000 }], 0);
  assert.equal(ar.dropped.length, 0, 'notes in another script than the line need only the citation (and, for a decision, its verb)');
  assert.match(buildPrompt('summary', { transcript: lines, now: 60_000 })[1].content, /never infer one\. End each decision and action item with the time of the line that states it/);
});

await check('acceptance 2, defect D: a decision needs a decision or agreement verb in its line; the summary claims no agreement nobody made', async () => {
  const { groundNotes } = await import('../src/meetings.mjs');
  // the ghost pass: stated facts and a "we need" listed as decisions, and a summary that says the team agreed
  const en = [{ who: 'S1', text: 'Sarah owns the supplier contract.', t: 10_000 }, { who: 'S2', text: 'The lease ends March 3rd.', t: 20_000 },
    { who: 'S1', text: 'We decided to renew the lease for one year.', t: 30_000 }, { who: 'S2', text: 'Okay, let\'s go with the cheaper supplier.', t: 40_000 }];
  const g = groundNotes('## Summary\nThe team reviewed contracts.\n\n## Decisions\n- Sarah owns the supplier contract [00:10]\n- The lease ends March 3rd [00:20]\n'
    + '- Renew the lease for one year [00:30]\n- Go with the cheaper supplier [00:40]\n\n## Action items\n- [ ] Sarah: own the supplier contract [00:10]', en, 0);
  assert.deepEqual(g.dropped, ['Sarah owns the supplier contract [00:10]', 'The lease ends March 3rd [00:20]']);
  assert.match(g.text, /- Renew the lease for one year \[00:30\]\n- Go with the cheaper supplier \[00:40\]/, '"we decided" and "let\'s go with" back a decision');
  assert.match(g.text, /- \[ \] Sarah: own the supplier contract \[00:10\]/, 'action items need no decision verb');
  const ar = [{ who: 'S1', text: 'نحتاج عرضاً جديداً على القهوة المختصة قبل نهاية الشهر.', t: 110_000 }, { who: 'S2', text: 'الميزانية المقترحة ألفان وخمسمئة دينار.', t: 200_000 }];
  const n = groundNotes('## الملخص\nناقش الفريق المبيعات. اتفق الفريق على إطلاق عرض جديد للقهوة المختصة [01:50]. الميزانية المقترحة 2500 دينار [03:20].\n\n## القرارات\n- اعتماد عرض جديد للقهوة المختصة [01:50]', ar, 0);
  assert.equal(n.dropped.length, 1, 'a need is not a decision');
  assert.match(n.text, /## القرارات\nNone noted\./);
  assert.doesNotMatch(n.text, /اتفق الفريق/, 'no line agreed to anything, so the summary does not say the team agreed');
  assert.match(n.text, /ناقش الفريق المبيعات\. الميزانية المقترحة 2500 دينار \[03:20\]\./, 'the rest of the summary stays');
  const yes = groundNotes('## Summary\nThe team agreed to renew the lease [00:30].', en, 0);
  assert.match(yes.text, /The team agreed to renew the lease/, 'a meeting where someone decided keeps the sentence');
  assert.match(buildPrompt('summary', { transcript: en, now: 60_000 })[1].content, /A decision needs a line where someone decides or agrees, in words like "we decided", "agreed", "let's go with", "قررنا" or "اتفقنا"\. A stated fact/);
});

await check('acceptance 9: answers keep the meeting\'s answer language; no word mixes Arabic and Latin letters', async () => {
  const { fixMixedScript } = await import('../src/prompts.mjs');
  const en = [{ who: 'Speaker 1', text: 'Sarah will send the budget by Friday.', t: 0 }];
  assert.match(buildPrompt('recap', { transcript: en, now: 1000, prior: 'سترسل سارة الميزانية يوم الجمعة. [00:20]' })[1].content, /My earlier answers in this meeting were in Arabic: reply in Arabic/);
  assert.equal(replyLanguage({ action: 'recap', transcript: en, prior: 'Sarah sends it.' }), '', 'English answers to an English meeting add nothing');
  assert.equal(replyLanguage({ action: 'summary', transcript: en, prior: 'سترسل سارة' }), '', 'the notes follow the meeting');
  assert.equal(fixMixedScript('سترسل سارة 50,000 دinar يوم الجمعة.'), 'سترسل سارة 50,000 دينار يوم الجمعة.');
  assert.equal(fixMixedScript('نراجع الـbudget بالAPI و APIات اليوم'), 'نراجع الـbudget بالAPI و APIات اليوم', 'Gulf usage is kept');
  assert.equal(fixMixedScript('Sarah sends the budget on Friday.'), 'Sarah sends the budget on Friday.');
});

await check('acceptance 10 and 11: the recording list leaves out Maverick\'s windows; the bar opens the main window without the keyboard', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /const notOwn = \(list\) => \{ const own = new Set\(\[main, bar, menuWin\]/);
  assert.match(main, /return \[\.\.\.new Set\(notOwn\(list\)\.map/, 'the Settings list');
  assert.match(main, /const sources = notOwn\(await listSources/, 'and the pick when recording starts');
  assert.match(main, /if \(main\.isFocused\(\)\) return;\s*\n\s*main\.showInactive\(\);/);
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.equal(app.match(/desk\.showMain\(document\.hasFocus\(\)\)/g)?.length, 5, 'Library, a cited page, an earlier meeting, Homework and Memory');
});

await check('acceptance 13: History and the notes isolate Arabic lines after their labels', () => {
  const md = meetingToMarkdown({ title: 'T', startedAt: 0, endedAt: 60_000, summary: '## Summary\nسنرسل الميزانية يوم الجمعة.',
    transcript: [{ who: 'Speaker 1', text: 'بكرة الساعة عشرة، تمام؟', t: 1000, sub: { lang: 'English', text: 'Tomorrow at ten, okay?' } },
      { who: 'Speaker 2', text: 'Sure, see you then.', t: 5000, sub: { lang: 'Arabic', text: 'أكيد، أشوفك وقتها.' } }] });
  const html = renderMarkdown(md, { bidi: true });
  assert.match(html, /<li><strong>00:01 Speaker 1:<\/strong> <bdi dir="auto">بكرة الساعة عشرة، تمام؟<\/bdi><\/li>/, 'the label stays first; the Arabic keeps its order and its question mark');
  assert.match(html, /<li><em>Arabic:<\/em> <bdi dir="auto">أكيد، أشوفك وقتها\.<\/bdi><\/li>/, 'an Arabic subtitle');
  assert.match(html, /<li><strong>00:05 Speaker 2:<\/strong> Sure, see you then\.<\/li>/, 'English lines as before (History seeks on <li><strong>time)');
  assert.match(html, /<p dir="auto">سنرسل الميزانية/, 'Arabic notes read right to left');
  assert.doesNotMatch(renderMarkdown(md), /bdi|dir=/, 'without bidi, nothing changes');
  assert.equal(renderMarkdown('- **تصحيح:** قيمة x هي 4.', { bidi: true }), '<ul><li dir="auto"><strong>تصحيح:</strong> قيمة x هي 4.</li></ul>', 'an Arabic label is part of the Arabic block');
});

await check('acceptance 14: the Flagged moments section is written from the transcript, with valid times', async () => {
  const { withFlagSection } = await import('../src/meetings.mjs');
  const m = { startedAt: 0, flags: [237_000, 4_536_000, 60_000], transcript: [{ who: 'Speaker 1', text: 'Good morning.', t: 5000 }, { who: 'Speaker 2', text: 'Omar will review the dashboard.', t: 232_000 }] };
  const notes = withFlagSection('## Summary\nx\n\n## Flagged moments\n- :15:36 (nothing was transcribed within 15 s)\n', m);
  assert.doesNotMatch(notes, /:15:36 \(|nothing was transcribed within/, 'the model\'s section is replaced');
  assert.match(notes, /## Flagged moments\n- \*\*03:57\*\* \[03:52\] Speaker 2: Omar will review the dashboard\.\n/);
  assert.match(notes, /- \*\*1:15:36\*\* Nothing was said within 15 s\. Nearest: \[03:52\] Speaker 2: Omar will review the dashboard\.\n/, 'past an hour: h:mm:ss');
  assert.match(notes, /- \*\*01:00\*\* Nothing was said within 15 s\. Nearest: \[00:05\] Speaker 1: Good morning\. \/ \[03:52\] Speaker 2: Omar/);
  assert.equal(withFlagSection('## Summary\nx', { ...m, transcript: [], flags: [9000] }), '## Summary\nx\n\n## Flagged moments\n- **00:09** Nothing was transcribed in this meeting.');
  assert.equal(withFlagSection('## Summary\nx\n', { ...m, flags: [] }), '## Summary\nx', 'no flags, no section');
  assert.match(linkCites(renderMarkdown(notes)), /<strong>03:57<\/strong> <button[^>]*data-t="03:52"/, 'the line times are transcript links');
});

await check('a deep model that does not start in time gives way to the live model; the meeting is saved first', async () => {
  const { firstTokenWithin } = await import('../src/providers.mjs');
  // a model that never answers: the stream waits until its signal aborts, like fetch does
  let seen = null;
  const hang = async function* (signal) { seen = signal; await new Promise((_, j) => signal.addEventListener('abort', () => j(new DOMException('aborted', 'AbortError')))); yield 'never'; };
  const t0 = Date.now();
  await assert.rejects(async () => { for await (const _ of firstTokenWithin(80, hang)) { /* none */ } }, (e) => e.name === 'Error' && /did not start writing within 0 s/.test(e.message));
  assert.ok(Date.now() - t0 < 1000 && seen.aborted, 'gives up at the limit and cancels the request');
  // the first word in time: the rest may take longer than the limit
  const slow = async function* () { yield 'a'; await new Promise((r) => setTimeout(r, 150)); yield 'b'; };
  let out = '';
  for await (const t of firstTokenWithin(80, slow)) out += t;
  assert.equal(out, 'ab');
  // Stop is the caller's: it stays an AbortError, so no fallback runs
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(async () => { for await (const _ of firstTokenWithin(5000, hang, stop.signal)) { /* none */ } }, (e) => e.name === 'AbortError');
  // a model that fails at once (not installed, out of memory) fails with its own message
  await assert.rejects(async () => { for await (const _ of firstTokenWithin(5000, async function* () { throw new Error('Model "x" is not installed in Ollama.'); })) { /* none */ } }, /not installed/);
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const end = app.slice(app.indexOf('async function endMeeting'), app.indexOf('let histSelected'));
  assert.ok(end.indexOf('let saved = keep()') > 0 && end.indexOf('let saved = keep()') < end.indexOf('await queue'), 'History holds the meeting before any wait or model work');
  assert.match(end, /fellBack = `Written with \$\{liveName\}, because the deep model \(\$\{dc\.model\}\) failed: /, 'the notes say the live model wrote them');
  assert.match(app, /firstTokenWithin\(DEEP_START_MS, \(s\) => ask\(dc, s\), card\.ctrl\.signal\)/, 'Think harder has the same limit');
});

// ---------------------------------------------------------------- homework (src/homework.mjs, src/formfill.mjs)

await check('homework: a worksheet splits into its questions, English and Arabic numbering', async () => {
  const { splitQuestions } = await import('../src/homework.mjs');
  const en = splitQuestions('Science homework, Unit 3\nName: ________\n1. Where does photosynthesis take place?\nQ2 Which gas do plants release?\n3) What happens to water vapour when it cools?\nIt is part of the water cycle.\nQuestion 4: State Newton\'s first law.\n5. The budget is 2.4 million. Who walked on the Moon first?\na) Armstrong b) Aldrin');
  assert.deepEqual(en.map((q) => q.n), ['1', '2', '3', '4', '5'], 'numbers, Q2, 3) and Question 4: each start a question; the title and Name line are dropped');
  assert.equal(en[2].text, 'What happens to water vapour when it cools?\nIt is part of the water cycle.', 'a question runs on to the next marker');
  assert.match(en[4].text, /2\.4 million[\s\S]*a\) Armstrong/, 'a decimal is not a marker, and a) under a number stays in its question');
  const ar = splitQuestions('واجب العلوم\n١. ما هي وظيفة الميتوكوندريا في الخلية؟\n٢- أين توجد المادة الوراثية في الخلية؟');
  assert.deepEqual(ar.map((q) => [q.n, q.text]), [['1', 'ما هي وظيفة الميتوكوندريا في الخلية؟'], ['2', 'أين توجد المادة الوراثية في الخلية؟']], 'Arabic-Indic numbers');
  assert.deepEqual(splitQuestions('السؤال الأول: ما هي الخلية؟\nالسؤال الثاني: ما النواة؟\nس3 ما الطاقة؟').map((q) => q.n), ['1', '2', '3'], 'Arabic ordinals and س3');
  assert.deepEqual(splitQuestions('a) What is x?\n(b) What is y?').map((q) => q.n), ['a', 'b'], 'letters split when nothing is numbered');
  assert.deepEqual(splitQuestions('أ) ما هو؟\nب) ما هي؟').map((q) => q.n), ['أ', 'ب'], 'Arabic letters too');
  assert.deepEqual(splitQuestions('Intro line\nWhat is light?\nWhy is the sky blue?').map((q) => q.text), ['What is light?', 'Why is the sky blue?'], 'no markers: lines that end in ?');
  assert.deepEqual(splitQuestions('Explain gravity'), [{ n: '1', text: 'Explain gravity' }], 'no markers, no ?: the whole text');
  assert.deepEqual(splitQuestions('  '), []);
  assert.equal(splitQuestions('1.5 kg of flour\n2.4 m long').length, 1, 'decimals at a line start are not markers');
});

await check('homework: answer language, calculations, export', async () => {
  const { enoughForHomework, homeworkMarkdown, isMath, worksheetLang, webQuestion } = await import('../src/homework.mjs');
  assert.ok(enoughForHomework([{ cos: 0.30, bm: 2.28 }]), 'a calculation on a page of formulas (measured: the cyclist question)');
  assert.ok(enoughForHomework([{ cos: 0.332, bm: 1.5 }]) && enoughForHomework([{ cos: 0.272, bm: 1.5 }]), 'measured: the car and the train speed questions');
  assert.ok(![[0.254, 1.14], [0.256, 0.83], [0.252, 0]].some(([cos, bm]) => enoughForHomework([{ cos, bm }])), 'measured: science questions the notes do not answer');
  assert.ok(enoughForHomework([{ cos: 0.5, bm: 0 }]), 'what the Library gate passes still passes');
  assert.ok(!enoughForHomework([{ cos: 0.06, bm: 0.78 }]) && !enoughForHomework([{ cos: 0.30, bm: 1.2 }]), 'an unrelated question, or a near meaning without its words, does not');
  // A one-file Library is one chunk: its words once scored BM25 0.4 to 0.6 there, so every question was Not in your
  // material. Measured cosines with embeddinggemma on this note: 0.396, 0.293, 0.434; the World Cup 0.005.
  const note = [{ name: 'team-notes.md', page: 1, text: '# Q3 launch notes\n\nThe launch moves to Thursday 14 November. Sarah owns the budget and sends it by Friday.\nPricing has three tiers: Starter at 9 KD, Team at 29 KD and Enterprise on request.\nThe EU rollout waits for the GDPR review, owned by Omar.' }];
  for (const [q, cos] of [['What day does the launch move to?', 0.396], ['Who sends the budget, and by when?', 0.293], ['How many pricing tiers are there?', 0.434]]) {
    const bm = rankChunks(q, null, note)[0].bm;
    assert.ok(enoughForHomework([{ cos, bm }]), `a one-chunk Library answers "${q}": bm ${bm.toFixed(2)}`);
  }
  assert.ok(!enoughForHomework([{ cos: 0.005, bm: rankChunks('Who won the 2022 World Cup?', null, note)[0].bm }]), 'and still not an unrelated question');
  assert.equal(worksheetLang('١. ما هي وظيفة الميتوكوندريا؟ (DNA)'), 'Arabic');
  assert.equal(worksheetLang('1. What is the cell?'), 'English');
  assert.ok(isMath('A trolley of mass 6 kg moves at 5 m/s. Calculate its kinetic energy.') && isMath('2 + 3 = ?') && isMath('احسب الطاقة الحركية'));
  assert.ok(!isMath('How many engineers are we hiring in Q3?') && !isMath('Where does photosynthesis take place?'));
  assert.match(webQuestion('Calculate 3 × 4'), /^Solve this homework problem: the answer first, then the working step by step/);
  const md = homeworkMarkdown({ name: 'sheet.pdf', items: [
    { n: '1', q: 'Where?\nIn the cell', a: 'In the chloroplasts [notes.pdf p.1].' },
    { n: '2', q: 'Who?', a: '', notFound: { missing: 'Missing: the first Moon walker.' } },
    { n: '3', q: 'Why?', a: '' },
  ] });
  assert.equal(md, '# sheet.pdf\n\n## 1. Where? In the cell\n\nIn the chloroplasts [notes.pdf p.1].\n\n## 2. Who?\n\nNot in your material. Missing: the first Moon walker.\n\n## 3. Why?\n\n(No draft yet.)\n');
});

await check('homework form: lettered options, the Choice line, the worksheet match', async () => {
  const { choiceQuestion, matchQuestion, parseChoice } = await import('../src/homework.mjs');
  const q = { text: 'A 2 kg ball moves at 3 m/s. Its kinetic energy?', multi: false, options: [{ label: '6 J' }, { label: '9 J' }, { label: '18 J' }] };
  assert.equal(choiceQuestion(q, 'about 9 J'), 'A 2 kg ball moves at 3 m/s. Its kinetic energy?\nA) 6 J\nB) 9 J\nC) 18 J\n\nMy worksheet\'s draft answer to this question: about 9 J');
  assert.deepEqual(parseChoice('Numbers: m = 2 kg [n.pdf p.3]\nWorking: 1/2 × 2 × 3^2 = 9\nAnswer: 9 J\nChoice: B) 9 J\nReason: KE = 1/2 m v² [n.pdf p.3]', 3), { picks: [1], reason: 'KE = 1/2 m v² [n.pdf p.3]' }, 'the Answer line is not the Choice; "9 J" after the letter is not a pick');
  assert.deepEqual(parseChoice('**Choice:** NOT SURE\n**Reason:** the excerpts do not give it', 3), { picks: [], reason: 'the excerpts do not give it' });
  assert.deepEqual(parseChoice('Choice: A, C', 3).picks, [0, 2]);
  assert.deepEqual(parseChoice('Choice: Option C', 3).picks, [2]);
  assert.deepEqual(parseChoice('Choice: Because the formula', 3).picks, [], 'a word is not a letter');
  assert.deepEqual(parseChoice('Choice: D', 3).picks, [], 'a letter past the options is dropped');
  assert.deepEqual(parseChoice('The answer is B.', 3).picks, [], 'no Choice line: not sure');
  assert.deepEqual(parseChoice('الخيار: B\nالسبب: من الملف', 3), { picks: [1], reason: 'من الملف' });
  const items = [{ n: '1', q: 'Which gas do plants release during photosynthesis?' }, { n: '2', q: 'Where is DNA kept?' }];
  assert.equal(matchQuestion('2. Which gas do plants release in photosynthesis?', items)?.n, '1');
  assert.equal(matchQuestion('Who won the 2018 World Cup?', items), null);
  assert.equal(matchQuestion('A ball of mass 2 kg moves at 3 m/s. What is its kinetic energy?', [{ n: '1', q: 'A trolley of mass 6 kg moves at 5 m/s. Calculate its kinetic energy.' }]), null, 'other numbers: another question');
  assert.equal(matchQuestion('A trolley of mass 6 kg moves at 5 m/s. What is its kinetic energy?', [{ n: '1', q: 'A trolley of mass 6 kg moves at 5 m/s. Calculate its kinetic energy.' }])?.n, '1');
});

await check('homework: My material stays on this PC, the form window is visible, and only a typed yes or Submit submits it, once', async () => {
  const { formScript } = await import('../src/formfill.mjs');
  assert.doesNotThrow(() => new Function(`return (${formScript})`), 'the page script compiles on its own (it is sent as source text)');
  assert.doesNotMatch(String(formScript), /\b(?:import|require)\b/, 'it uses nothing outside itself');
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const hw = app.slice(app.indexOf('// ---------------------------------------------------------------- Homework: a worksheet'), app.indexOf('// ---------------------------------------------------------------- desktop app'));
  // with per-task models, "local Ollama" is localConf: the Live or Vision role, whichever is on this PC, and nothing else
  assert.equal((hw.match(/c = localConf\(\)/g) || []).length, 2, 'drafts and form answers from My material run on this PC');
  assert.match(hw, /const c = \['live', 'vision'\]\.map\(tryConf\)\.find\(isLocalConn\);\n {2}if \(!c\) throw new Error/, 'a local connection or an error, never a cloud one');
  assert.equal((hw.match(/c = conf\('web'\)/g) || []).length, 2, 'only Web goes through the Web role (Claude Code)');
  assert.equal((hw.match(/desk\.formSubmit\(\)/g) || []).length, 1, 'one place clicks Submit');
  assert.match(hw, /async function submitForm\(\) \{\n {2}const f = hwForm;\n {2}if \(!f \|\| f\.state !== 'review' \|\| !desk\) return;/, 'and only from the review');
  assert.match(hw, /if \(e\.target\.value\.trim\(\)\.toLowerCase\(\) === 'yes'\) return submitForm\(\);/, 'a typed yes');
  assert.equal((hw.match(/submitForm\(\)/g) || []).length, 3, 'the yes, the review\'s Submit button, and its definition');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /formWin\.setContentProtection|formWin\]|, formWin/, 'the form window is never hidden from shares');
  assert.match(main, /formSubmitted = true; \/\/ before the click/, 'Submit is marked used before the click, so it is never retried');
  assert.match(main, /partition: FORM_PARTITION, sandbox: true, contextIsolation: true/, 'its own session, sandboxed, no preload');
});

await check('homework form: text answers go in plain, uploads are never filled, and an empty required question or upload blocks the submit', async () => {
  const { formNeeds, isBlank, parseTyped, plainAnswer, textTask } = await import('../src/homework.mjs');
  assert.deepEqual(parseTyped('Numbers: d = 300 m [n.pdf p.3]\nWorking: 300 / 15 = 20\nAnswer: 20 m/s [n.pdf p.3]\nAnswer: **20 m/s**\nReason: speed = distance ÷ time [n.pdf p.3]'),
    { value: '20 m/s', reason: 'speed = distance ÷ time [n.pdf p.3]' }, 'the last Answer line, without markdown');
  assert.deepEqual(parseTyped('Answer: In the chloroplasts [notes.pdf p.1].\nReason: That is where it happens.'),
    { value: 'In the chloroplasts.', reason: 'That is where it happens. [notes.pdf p.1]' }, 'a citation on the Answer line moves to the reason: the box gets none');
  assert.deepEqual(parseTyped('**Answer:** NOT SURE\nReason: the excerpts do not give it'), { value: '', reason: 'the excerpts do not give it' });
  assert.equal(parseTyped('Rio, I think.').value, '', 'no Answer line: nothing to type');
  assert.equal(plainAnswer('Clouds form, see [BBC](https://www.bbc.co.uk/x) [a.pdf p.2] .'), 'Clouds form, see BBC.');
  assert.match(textTask(false), /one-line box/);
  assert.match(textTask(true), /short paragraph of at least two and at most four full sentences/);
  assert.deepEqual(parseTyped('Answer: Water vapour cools.\nIt condenses into clouds [n.pdf p.2].\nReason: the notes say so [n.pdf p.2]'),
    { value: 'Water vapour cools. It condenses into clouds.', reason: 'the notes say so [n.pdf p.2]' }, 'an answer run on to more lines before its Reason line is kept whole');
  assert.equal(parseTyped('Answer: 20 m/s\nMissing: the time').value, '20 m/s', 'with no Reason line after it, only the Answer line goes in the box');
  const q = (i, kind, required, extra) => ({ i, kind, required, ...extra });
  const done = q(0, 'choice', true, { options: [{ checked: true }] });
  assert.equal(formNeeds([done, q(6, 'text', true, { value: 'x' }), q(8, 'text', false, { value: '' }), q(10, 'upload', true, { files: ['a.png'] })]), '', 'all required ones answered: nothing blocks');
  assert.equal(formNeeds([done, q(10, 'upload', true, { files: [] })]), 'Can’t submit yet: question 11 needs your photo or file. Add it in the form window, then type yes again.');
  assert.equal(formNeeds([q(9, 'text', true, { value: ' ' }), q(10, 'upload', true, { files: [] }), q(3, 'choice', true, { options: [{ checked: false }] })]),
    'Can’t submit yet: question 11 needs your photo or file, and questions 4 and 10 are still blank. Add it and answer the blank ones in the form window, then type yes again.');
  assert.equal(formNeeds([q(5, 'choice', false, { options: [{ checked: false }] }), q(11, 'upload', false, { files: [] })]), '', 'an optional question or upload may stay empty');
  assert.ok(isBlank(q(1, 'text', true, { value: '' })) && !isBlank(q(1, 'text', true, { value: 'a' })));
  const { formScript } = await import('../src/formfill.mjs');
  const src = String(formScript).replace(/\r\n/g, '\n');
  assert.doesNotMatch(src, /\.files\s*=|DataTransfer|setFileInputFiles/, 'the page script never puts a file in an upload');
  assert.match(src, /Object\.getOwnPropertyDescriptor\(el\.matches\('textarea'\) \? HTMLTextAreaElement\.prototype : HTMLInputElement\.prototype, 'value'\)\.set\.call\(el, String\(arg\)\);\n\s*el\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);\n\s*el\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/,
    'a text box gets the native value setter, then input and change, as a React-controlled box needs');
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const submit = app.slice(app.indexOf('async function submitForm()'), app.indexOf('function formRowHtml'));
  assert.ok(submit.indexOf('await rereadForm()') < submit.indexOf('formNeeds(f.questions)') && submit.indexOf('formNeeds(f.questions)') < submit.indexOf('desk.formSubmit()'),
    'Submit reads the form again, then checks what is still empty, and only then clicks');
  assert.match(submit, /if \(needs\) \{ f\.state = 'review'; f\.note = needs; return; \}/, 'and stays in the review, saying why');
  assert.doesNotMatch(app, /formType\([^)]*upload|kind === 'upload'[^\n]*formType/, 'uploads are never typed into');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('form-type', async \(e, i, text\) => \{\n {2}if \(!fromMain\(e\) \|\| !Number\.isInteger\(i\) \|\| i < 0 \|\| i > 999 \|\| typeof text !== 'string' \|\| text\.length > 20000\) return null;/, 'typing takes a checked index and text, from the main page only');
});

// ---------------------------------------------------------------- per-task models: connections and roles

await check('models: a fresh install is all local Ollama, Claude Code for Web', () => {
  const m = loadModels({});
  assert.deepEqual(m.connections.map((c) => [c.id, c.type]), [['ollama', 'ollama'], ['claudecode', 'claudecode']]);
  assert.equal(m.connections[0].url, 'http://127.0.0.1:11434');
  assert.equal(m.connections[0].model, undefined, 'models live on the roles, not the connections');
  assert.deepEqual(m.roles, {
    live: { conn: 'ollama', model: 'gemma4:12b' }, deep: { conn: 'ollama', model: 'qwen3.8:27b' }, vision: { conn: 'ollama', model: 'gemma4:12b' },
    transcribe: { conn: 'ollama', model: 'gemma4:12b' }, web: { conn: 'claudecode', model: '' },
  });
  assert.deepEqual(Object.keys(ROLES), ['live', 'deep', 'vision', 'transcribe', 'web']);
  assert.deepEqual(roleConf(m, 'live'), { url: 'http://127.0.0.1:11434', id: 'ollama', conn: 'ollama', name: 'Ollama (local)', model: 'gemma4:12b', sees: true });
});

await check('models: old settings become connections and roles that send the same requests, and round-trip', () => {
  const old = {
    provider: 'anthropic', transcriber: 'openai',
    providers: {
      anthropic: { key: 'sk-ant-1', model: 'claude-x', deepModel: 'claude-y' },
      openai: { baseUrl: 'https://openrouter.ai/api/v1/', key: 'sk-or-1', model: 'gpt-4o-audio-preview', deepModel: '' },
      gemini: { key: 'g-1' }, // a saved key is kept as a connection, though no role uses it
      ollama: { url: 'http://127.0.0.1:11500', model: 'gemma4:4b' },
    },
  };
  const m = loadModels(old);
  assert.deepEqual(m.connections.map((c) => c.id), ['ollama', 'openai', 'anthropic', 'gemini', 'claudecode']);
  const or = m.connections.find((c) => c.id === 'openai');
  assert.deepEqual(or, { id: 'openai', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1/', key: 'sk-or-1', preset: 'openrouter' });
  assert.equal(m.connections.find((c) => c.id === 'gemini').key, 'g-1');
  assert.deepEqual(m.roles, {
    live: { conn: 'anthropic', model: 'claude-x' }, deep: { conn: 'anthropic', model: 'claude-y' }, vision: { conn: 'ollama', model: 'gemma4:4b' },
    transcribe: { conn: 'openai', model: 'gpt-4o-audio-preview' }, web: { conn: 'claudecode', model: '' },
  });
  // the requests: what the old conf(provider), deepConf() and conf(transcriber) built, byte for byte
  const merged = (id) => ({ id, ...Object.fromEntries(PROVIDERS[id].fields.map((f) => [f.key, f.value])), ...old.providers[id] });
  const same = (role, id, oldConf) => assert.deepEqual(PROVIDERS[id].build(msgs, { images: [IMG] }, roleConf(m, role)), PROVIDERS[id].build(msgs, { images: [IMG] }, oldConf), role);
  same('live', 'anthropic', merged('anthropic'));
  same('deep', 'anthropic', { ...merged('anthropic'), model: 'claude-y' });
  same('transcribe', 'openai', merged('openai'));
  same('vision', 'ollama', merged('ollama')); // the screen and Library reads used conf('ollama')
  // round-trip: saved and loaded again, nothing changes
  assert.deepEqual(loadModels(JSON.parse(JSON.stringify({ ...m, chunkSeconds: 12 }))), m);
  // a provider or transcriber that no longer fits falls back to Ollama, as before
  const bad = loadModels({ provider: 'nope', transcriber: 'anthropic' });
  assert.equal(bad.roles.live.conn, 'ollama');
  assert.equal(bad.roles.transcribe.conn, 'ollama');
  // the new shape: an unknown type is dropped, a missing role gets the fresh install's, a missing field its type's default
  const n = loadModels({ connections: [{ id: 'x', type: 'nope' }, { id: 'ds', type: 'openai', preset: 'deepseek', name: 'DeepSeek', key: 'k' }], roles: { live: { conn: 'ds', model: 'deepseek-chat' } } });
  assert.deepEqual(n.connections.map((c) => c.id), ['ds']);
  assert.equal(n.connections[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(n.roles.vision.conn, 'ollama');
  assert.throws(() => roleConf(n, 'vision'), /Pick a connection for Vision in Settings/, 'its connection is gone: the call says so');
  assert.equal(roleConf(n, 'live').key, 'k');
});

await check('models: what each connection can do, and Settings errors for a role it cannot do', () => {
  const ds = { name: 'DeepSeek', type: 'openai', preset: 'deepseek' };
  const or = { name: 'OpenRouter', type: 'openai', preset: 'openrouter' };
  assert.equal(can(ds, 'images'), false);
  assert.equal(can(ds, 'audio'), false);
  assert.equal(can(or, 'images'), true);
  assert.equal(can(or, 'audio'), true);
  assert.equal(can({ type: 'anthropic' }, 'audio'), false);
  assert.equal(can({ type: 'anthropic' }, 'images'), true);
  assert.equal(can({ type: 'claudecode' }, 'web'), true);
  for (const t of ['ollama', 'openai', 'anthropic', 'gemini', 'cli']) assert.equal(can({ type: t }, 'web'), false, t);
  assert.equal(can({ type: 'nope' }, 'chat'), false);
  assert.match(roleError('vision', ds), /^DeepSeek cannot read images\./);
  assert.match(roleError('transcribe', ds), /^DeepSeek cannot take audio\./);
  assert.match(roleError('transcribe', { name: 'Claude API', type: 'anthropic' }), /cannot take audio/);
  assert.match(roleError('web', { name: 'Ollama', type: 'ollama' }), /cannot search the web/);
  assert.equal(roleError('deep', ds), '');
  assert.equal(roleError('live', ds), '');
  assert.equal(roleError('vision', or), '');
  assert.equal(roleError('vision', null), 'Pick a connection.');
  assert.equal(roleConf({ connections: [{ id: 'ds', ...ds, baseUrl: 'x', key: 'k' }], roles: { deep: { conn: 'ds', model: 'm' } } }, 'deep').sees, false, 'the frame is left out for it');
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const shown = \[live, dc\]\.every\(\(c\) => !c \|\| c\.sees\) \? frame : null;/, 'Answer and Think harder send no image to a model that cannot read one');
  // the form saves only with no problem left, and a problem is said in the dialog, never dropped silently (ghost pass 3)
  assert.match(app, /const fields = \[form\.elements\.chunkSeconds, \.\.\.\$\$\('\[name\^="role\."\]', form\),/, 'a role error keeps Settings from saving');
  assert.match(app, /const formValid = \(\) => !formProblem\(\);/);
  assert.match(app, /sayUnsaved\(problem\);\n {4}if \(!problem\) saveSettings\(true\);/, 'what keeps it from saving is shown');
  assert.match(app, /if \(refused && back\) \{\n {6}t\.value = back\.id;/, 'a refused connection goes back to the last one');
  assert.deepEqual(app.match(/.*store\(SETTINGS_KEY.*/g).map((l) => l.trim().slice(0, 30)), ['const storeSettings = (s) => s'], 'every settings write goes through storeSettings, which seals the keys');
});

await check('models: a role moved to another connection starts with its model; keys are sealed at rest', () => {
  assert.equal(defaultModel({ type: 'openai', preset: 'deepseek' }, 'deep'), 'deepseek-reasoner');
  assert.equal(defaultModel({ type: 'openai', preset: 'deepseek' }, 'live'), 'deepseek-chat');
  assert.equal(defaultModel({ type: 'openai', preset: 'openai' }, 'live'), 'gpt-4o-mini');
  assert.equal(defaultModel({ type: 'openai', preset: 'openrouter' }, 'live'), '', 'no guessed model name: blank, with the placeholder');
  assert.equal(defaultModel({ type: 'ollama' }, 'deep'), 'qwen3.8:27b');
  assert.equal(defaultModel({ type: 'ollama' }, 'vision'), 'gemma4:12b');
  assert.equal(defaultModel({ type: 'claudecode' }, 'web'), '');
  const seal = (t) => Buffer.from(`x${t}`).toString('base64');
  const open = (t) => Buffer.from(t, 'base64').toString().slice(1);
  const conns = [{ id: 'a', key: 'sk-plain-1' }, { id: 'b', key: '' }, { id: 'c' }];
  const sealed = sealKeys(conns, seal);
  assert.ok(sealed[0].key.startsWith(SEALED) && !sealed[0].key.includes('sk-plain-1'), 'the stored value is not the key');
  assert.deepEqual(sealed.slice(1), conns.slice(1), 'no key, nothing to seal');
  assert.deepEqual(sealKeys(sealed, seal), sealed, 'sealed once');
  assert.deepEqual(openKeys(sealed, open), conns);
  assert.deepEqual(sealKeys(conns, () => null), conns, 'nothing to seal with (the browser): as before');
  assert.equal(openKeys(sealed, () => null)[0].key, '', 'a key that cannot be read is blank, never the sealed text');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /const canSeal = \(e\) => fromMain\(e\) && safeStorage\.isEncryptionAvailable\(\);/, 'the main window only, and only with OS encryption');
  assert.doesNotMatch(main, /console\.\w+\([^)]*text/, 'never logged');
});

await check('models: OpenAI-compatible presets, and which connections stay on this PC', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.baseUrl])), {
    openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/v1', openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1', xai: 'https://api.x.ai/v1', together: 'https://api.together.xyz/v1', lmstudio: 'http://127.0.0.1:1234/v1', custom: '',
  });
  for (const k of Object.keys(PRESETS)) if (k !== 'custom') assert.equal(presetOf(`${PRESETS[k].baseUrl}/`), k);
  assert.equal(presetOf('https://example.com/v1'), 'custom');
  assert.equal(isLocalConn({ type: 'openai', baseUrl: PRESETS.lmstudio.baseUrl }), true);
  assert.equal(isLocalConn({ type: 'openai', baseUrl: 'http://localhost:1234/v1' }), true);
  assert.equal(isLocalConn({ type: 'openai', baseUrl: PRESETS.deepseek.baseUrl }), false);
  assert.equal(isLocalConn({ type: 'ollama', url: 'http://127.0.0.1:11434' }), true);
  assert.equal(isLocalConn({ id: 'ollama', url: 'http://127.0.0.1:11434', conn: 'x' }), true, 'a request conf too');
  assert.equal(isLocalConn({ type: 'anthropic' }), false);
  assert.equal(isLocalConn({ type: 'claudecode' }), false, 'the bridge hands the prompt to a cloud agent');
  assert.equal(isLocalConn(null), false);
  // the bytes counter: a local connection counts 0; a test can count a local mock as remote, and only that host:port
  const seen = [];
  const fn = (n, url) => seen.push([n, url]);
  egress.add(fn);
  const lm = { id: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', key: 'k', model: 'm' };
  const r = PROVIDERS.openai.build(msgs, {}, lm);
  assert.equal(countSend(r.url, JSON.stringify(r.body), r.headers, lm), 0, 'LM Studio on this PC');
  remoteForTest.add('127.0.0.1:1234');
  assert.equal(countSend(r.url, JSON.stringify(r.body), r.headers, lm), requestBytes(JSON.stringify(r.body), r.headers));
  assert.equal(countSend('http://127.0.0.1:11434/api/chat', '{}', {}, { id: 'ollama' }), 0, 'Ollama on another port stays local');
  remoteForTest.clear();
  egress.delete(fn);
  assert.equal(seen.length, 1);
});

await check('ghost pass 3: Answer takes the caught question, never stalls; History shows no literal underscores', () => {
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /if \(action === 'answer' && !question\.trim\(\)\) question = takeCaught\(\);/, 'the Answer button answers the question waiting in the ask field');
  assert.match(app, /filter\(\(i\) => i\?\.value\.trim\(\) && i\.value === i\.dataset\.caught\)/, 'only a caught question the user has not changed');
  const lines = [{ who: 'Speaker 1', text: 'The new server room door code is 7419.', t: 40_000 }, ...Array.from({ length: 60 }, (_, i) => ({ who: 'Speaker 2', text: `Status item ${i} on the rollout.`, t: 60_000 + i * 11_000 }))];
  const p = buildPrompt('answer', { transcript: lines, question: 'What is the new server room door code?', startedAt: 0, now: 750_000 })[1].content;
  assert.match(p, /7419/, 'the whole meeting is searched for it, not the last 2 minutes');
  assert.doesNotMatch(p, /Transcript, last 2 minutes/);
  assert.match(p, /Never stall or promise to come back to it later/, 'no invented deferral');
  assert.match(meetingToMarkdown({ title: 'T', startedAt: 0, endedAt: 60_000, transcript: [], flags: [], answers: [] }), /\n\*No summary\.\*\n/);
});

await check('memory: note names, [[links]], frontmatter, backlinks', () => {
  assert.equal(noteName('Meeting Oct 19 10:05'), 'Meeting Oct 19 10-05', 'a time\'s colon is not a file name character');
  assert.equal(noteName('Move the launch to May [03:12]'), 'Move the launch to May', 'citations go');
  assert.equal(noteName('a/b\\c*?"<>|#^[x]'), 'a b c x');
  assert.equal(noteName('CON'), 'CON note', 'a Windows device name');
  assert.ok(noteName('word '.repeat(40)).length <= 80);
  assert.deepEqual(parseLinks('See [[Sara Ahmed]], [[Physics|phys]] and [[Physics#Waves]]; [[sara ahmed]] again. [not] [[ ]]'), ['Sara Ahmed', 'Physics']);
  const a = parseNote('Lecture 1', '---\ntype: meeting\ndate: 2026-10-19\ntags: [meeting, physics]\n---\n# Lecture 1\n[[Sara Ahmed]] taught [[Physics]].');
  assert.equal(a.type, 'meeting');
  assert.equal(a.date, '2026-10-19');
  assert.deepEqual(a.tags, ['meeting', 'physics']);
  assert.ok(!a.body.includes('---'), 'the body has no frontmatter');
  const b = parseNote('Homework 1', '[[lecture 1]] and [[Physics]] and [[Homework 1]]');
  const p = parseNote('Physics', '# Physics');
  const idx = backlinkIndex([a, b, p]);
  assert.deepEqual(idx.get('physics'), ['Homework 1', 'Lecture 1'], 'both notes that link to Physics, sorted');
  assert.deepEqual(idx.get('lecture 1'), ['Homework 1'], 'a link matches whatever its case');
  assert.equal(idx.get('homework 1'), undefined, 'a note linking to itself is no backlink');
  assert.deepEqual(idx.get('sara ahmed'), ['Lecture 1'], 'a link to a page not written yet still counts');
});

await check('memory: graph, force layout, notes, entity reply, link and chip HTML', () => {
  const notes = [parseNote('A', '[[B]] [[C]] [[Missing]]'), parseNote('B', '[[A]]'), parseNote('C', ''), parseNote('D', '')];
  const g = graphOf(notes);
  assert.deepEqual(g.edges, [[0, 1], [0, 2]], 'A-B once although both link, no edge to a missing note');
  assert.deepEqual(g.nodes.map((n) => n.degree), [2, 1, 1, 0]);
  const p = forceLayout(4, g.edges, { w: 400, h: 300, pad: 20 });
  assert.ok(p.every((q) => q.x >= 20 && q.x <= 380 && q.y >= 20 && q.y <= 280 && Number.isFinite(q.x + q.y)), 'every node inside the box');
  const d = (i, j) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
  assert.ok(d(0, 1) < d(1, 3) && d(0, 2) < d(2, 3), 'linked notes sit closer than unlinked ones');
  assert.deepEqual(forceLayout(4, g.edges, { w: 400, h: 300, pad: 20 }), p, 'the same notes lay out the same');
  assert.deepEqual(parseEntities('Sure: {"people": ["Dr Huda Salem", "Speaker 2", "You"], "subjects": ["Physics 101", 7]} done'), { people: ['Dr Huda Salem'], subjects: ['Physics 101'] });
  assert.deepEqual(parseEntities('no json'), { people: [], subjects: [] });
  const at = (h, mi) => new Date(2026, 9, 19, h, mi).getTime();
  const m = { title: 'Physics lecture 10:05', startedAt: at(10, 5), endedAt: at(10, 17),
    transcript: [{ who: 'Dr Huda Salem', text: 'The midterm is on November 12.', t: at(10, 6) }, { who: 'Speaker 2', text: 'Okay.', t: at(10, 7) }],
    summary: '### Summary\nThe midterm date was set.\n\n### Decisions\n- The midterm is on November 12 [01:00]\n\n### Action items\n- [ ] Omar: book the hall [01:00]' };
  const ents = meetingEntities(m, { people: ['Omar', 'Huda Salem'], subjects: ['Physics'] });
  assert.deepEqual(ents, { people: ['Dr Huda Salem', 'Omar'], subjects: ['Physics'], decisions: ['The midterm is on November 12'] });
  const md = meetingNote(m, ents);
  assert.match(md, /^---\ntype: meeting\ndate: 2026-10-19\ntags: \[meeting, physics\]\n---\n# Physics lecture 10:05\n/);
  assert.match(md, /People: \[\[Dr Huda Salem\]\], \[\[Omar\]\]/);
  assert.match(md, /## Decisions\n\n- \[\[The midterm is on November 12\]\]\n/);
  assert.match(md, /## Action items\n\n- \[ \] Omar: book the hall \[01:00\]/);
  assert.match(md, /## Transcript excerpt\n\n- \*\*01:00 Dr Huda Salem:\*\* The midterm is on November 12\./);
  assert.doesNotMatch(md, /### (?:Decisions|Summary)/, 'the notes\' own Summary and Decisions headings are not written twice');
  assert.match(md, /## Summary\n\nThe midterm date was set\./);
  assert.equal(entityPage('Omar', 'person'), '---\ntype: person\ntags: [person]\n---\n# Omar\n\n## Mentioned in\n\n');
  assert.equal(entityLine('Physics lecture 10-05', '2026-10-19'), '- [[Physics lecture 10-05]] (2026-10-19)\n');
  const hw = homeworkNote({ name: 'sheet.pdf', lang: 'English', items: [{ n: '1', q: 'When is the midterm?', a: 'On November 12 [Physics lecture 10-05 p.1] [notes.pdf p.2].' }, { n: '2', q: 'Moon?', notFound: { missing: 'x' } }] },
    { people: [], subjects: [] }, ['Physics lecture 10-05'], m.startedAt);
  assert.match(hw, /From the lectures: \[\[Physics lecture 10-05\]\]/);
  assert.match(hw, /On November 12 \[\[Physics lecture 10-05\]\] \[notes\.pdf p\.2\]\./, 'a meeting citation becomes a link, a file citation stays');
  assert.match(hw, /## 2\. Moon\?\n\nNot in your material\. x/);
  const find = (n) => [{ name: 'Newton\'s laws' }, { name: 'Omar' }].find((x) => x.name.toLowerCase() === n.replace(/&#39;|’/g, '\'').toLowerCase()) ?? null;
  const html = wikiHtml(renderMarkdown('[[omar]] met [[Nobody]] about [[Newton\'s laws|the laws]]'), find);
  assert.match(html, /<button type="button" class="wikilink" data-note="Omar">omar<\/button>/);
  assert.match(html, /<span class="wikilink missing"[^>]*>Nobody<\/span>/);
  assert.match(html, /data-note="Newton&#39;s laws">the laws<\/button>/);
  assert.match(memChips('<p>Yes [Omar p.1] [other.pdf p.1]</p>', find), /<button type="button" class="cite src mem" data-cmd="note" data-note="Omar"[^>]*>Omar<\/button> \[other\.pdf p\.1\]/);
});

console.log(`\nselfcheck passed: ${passed} checks`);
