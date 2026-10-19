// node test/wer.mjs   (Windows with System.Speech voices, Ollama with gemma4:12b)
// Transcription quality on generated speech. Each case is spoken by an installed Windows voice (or two, mixed),
// then runs the app's path: silence gate and 16 kHz WAV (prepareChunk) -> transcribe with the meeting prompt ->
// parseTurns -> joined text, scored by word error rate against the script. Also checks speaker fingerprints and
// the misheard-word fix pass. Writes shots/transcription-wer.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Word error rate: word-level edit distance over the reference length, after normalizing case, punctuation,
// Arabic diacritics and letter variants, and dropping [unclear] and [overlap] tags.
export function normalizeWords(s) {
  return String(s ?? '').toLowerCase()
    .replace(/\[(unclear|overlap)\]/g, ' ')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/'/g, '')
    .split(/\s+/).filter(Boolean);
}
export function wer(ref, hyp) {
  const r = normalizeWords(ref);
  const h = normalizeWords(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  const { prepareChunk, voiceprint, cosine, assignSpeaker, TARGET_RATE, PITCH_WEIGHT, SPEAKER_MATCH } = await import('../src/audio.mjs');
  const { TRANSCRIBE_PROMPT, transcribePrompt, parseTurns, buildFixPrompt, parseFixes, applyFixes, relistenPrompt, fillUnclear, buildUnclearPrompt, parseFills } = await import('../src/prompts.mjs');
  const { PROVIDERS, transcribe, streamChat } = await import('../src/providers.mjs');
  const conf = { id: 'ollama', ...Object.fromEntries(PROVIDERS.ollama.fields.map((f) => [f.key, f.value])) };
  const dir = join(tmpdir(), 'maverick-wer'); // clips are kept here, so a second run skips the speech step
  mkdirSync(dir, { recursive: true });
  const ROOT = fileURLToPath(new URL('..', import.meta.url));

  const voices = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture + "|" + $_.VoiceInfo.Gender }'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).map((l) => { const [name, culture, gender] = l.split('|'); return { name, culture, gender }; });
  const male = voices.find((v) => v.gender === 'Male' && v.culture.startsWith('en'))?.name;
  const female = voices.find((v) => v.gender === 'Female' && v.culture.startsWith('en'))?.name;
  const arabic = voices.find((v) => v.culture.startsWith('ar'))?.name;

  const S = {
    a: 'Hi team. Let us move the product launch to Thursday, and Sarah will send the budget by Friday.',
    b: 'The dashboard is almost ready, but the login page still needs two more days of testing.',
    c: 'I think we should hire one more designer before the next quarter starts.',
    d: 'Can we talk about the budget after lunch instead of right now?',
    e: 'The server costs went up by twenty percent last month.',
    f: 'Then we should move the old reports to cheaper storage this week.',
    vocab: 'Please ask Nabeel and Fatemah to send the Qurain invoice to Talabat before the Zain renewal on Sunday.',
    ar: 'مرحبا بالجميع، سننقل موعد الإطلاق إلى يوم الخميس، وسترسل سارة الميزانية يوم الجمعة.',
  };
  const VOCAB = ['Nabeel', 'Fatemah', 'Qurain', 'Talabat', 'Zain'];

  // Speak every clip in one PowerShell run: 16 kHz mono 16-bit WAVs.
  const clips = {
    male: [male, 0, S.a], female: [female, 0, S.b], fast: [male, 6, S.c], slow: [female, -5, S.d], c: [male, 0, S.c], d: [female, 0, S.d],
    e: [male, 0, S.e], f: [female, 0, S.f], vocab: [male, 0, S.vocab], deep: [male, -1, S.b, 'x-low'], ...(arabic ? { ar: [arabic, 0, S.ar] } : {}),
  };
  const ps = ['Add-Type -AssemblyName System.Speech', '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)'];
  for (const [k, [voice, rate, text, pitch]] of Object.entries(clips)) {
    const file = join(dir, `${k}.wav`);
    if (existsSync(file)) continue;
    const t = text.replace(/'/g, "''");
    ps.push(`$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $s.Rate = ${rate}; $s.SetOutputToWaveFile('${file}', $fmt)`);
    ps.push(pitch ? `$s.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="${pitch}">${t}</prosody></speak>')` : `$s.Speak('${t}')`);
    ps.push('$s.Dispose()');
  }
  if (ps.length > 2) execFileSync('powershell', ['-NoProfile', '-Command', ps.join('; ')], { stdio: 'inherit' });
  const pcm = (k) => {
    const b = readFileSync(join(dir, `${k}.wav`));
    const at = b.indexOf('data') + 8;
    const out = new Float32Array((b.length - at) >> 1);
    for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + i * 2) / 32768;
    return out;
  };
  const mix = (x, y, offsetS) => {
    const off = Math.round(offsetS * TARGET_RATE);
    const out = new Float32Array(Math.max(x.length, off + y.length));
    out.set(x);
    for (let i = 0; i < y.length; i++) out[off + i] += y[i];
    return out;
  };
  const concat = (x, gapS, y) => { const out = new Float32Array(x.length + Math.round(gapS * TARGET_RATE) + y.length); out.set(x); out.set(y, out.length - y.length); return out; };
  const scale = (x, g) => x.map((v) => v * g);

  // The app's path (transcribeTurns in src/app.mjs): the meeting prompt, then the plain prompt once after a refusal.
  const run = async (samples, prompt) => {
    const wav = prepareChunk(samples, TARGET_RATE);
    if (!wav) return { text: '', turns: [], secs: 0, silent: true };
    const seconds = samples.length / TARGET_RATE;
    const t0 = Date.now();
    const raw = await transcribe(wav, conf, AbortSignal.timeout(60000), prompt);
    let turns = parseTurns(raw, seconds);
    let retried = false;
    if (!turns.length && raw.trim() && prompt !== TRANSCRIBE_PROMPT) { retried = true; turns = parseTurns(await transcribe(wav, conf, AbortSignal.timeout(60000), TRANSCRIBE_PROMPT), seconds); }
    return { text: turns.map((t) => t.text).join(' '), turns, raw, wav, retried, secs: (Date.now() - t0) / 1000 };
  };
  const P = transcribePrompt({});
  const PV = transcribePrompt({ vocab: VOCAB });
  const rows = [];
  const row = async (name, samples, ref, prompt = P, note = '') => {
    const r = await run(samples, prompt);
    const w = wer(ref, r.text);
    const marks = [r.turns.some((t) => t.overlap) && '[overlap]', /\[unclear\]/.test(r.text) && '[unclear]'].filter(Boolean).join(' ');
    rows.push({ name, wer: w, turns: r.turns.length, marks, secs: r.secs, text: r.text, note: [note, r.retried && 'retried with the plain prompt after a refusal'].filter(Boolean).join('; ') });
    console.log(`${name.padEnd(34)} WER ${(w * 100).toFixed(0).padStart(3)}%  turns ${r.turns.length}  ${marks}  ${r.secs.toFixed(1)} s\n    ${r.text}`);
    return r;
  };

  await conf && (await transcribe(prepareChunk(pcm('male'), TARGET_RATE), conf, AbortSignal.timeout(120000))); // load the model first
  await row('clean male (old plain prompt)', pcm('male'), S.a, TRANSCRIBE_PROMPT, 'baseline: the prompt before this change');
  await row('clean male', pcm('male'), S.a);
  await row('female', pcm('female'), S.b);
  await row('fast speech (rate +6)', pcm('fast'), S.c);
  await row('slow speech (rate -5)', pcm('slow'), S.d);
  await row('quiet voice (-18 dB)', scale(pcm('male'), 0.125), S.a);
  await row('deep voice (SSML pitch x-low)', pcm('deep'), S.b);
  const turn = await row('turn change, male then female', concat(pcm('e'), 0.35, pcm('f')), `${S.e} ${S.f}`, P, 'one chunk, two speakers');
  await row('overlap, two voices at once', mix(pcm('c'), pcm('d'), 1.0), `${S.c} ${S.d}`, P, 'female starts 1 s into the male sentence');
  await row('vocabulary words, no hints', pcm('vocab'), S.vocab);
  const withVocab = await row('vocabulary words, with hints', pcm('vocab'), S.vocab, PV);
  // The misheard-word pass on the no-hint output, with the vocabulary.
  const plain = (await run(pcm('vocab'), P)).text;
  let out = '';
  for await (const t of streamChat(buildFixPrompt(plain, [], VOCAB), { temperature: 0, maxTokens: 160 }, conf)) out += t;
  const fixes = parseFixes(out, plain);
  const fixed = applyFixes(plain, fixes).map((p) => p.text).join('');
  rows.push({ name: 'vocabulary words, no hints + fix pass', wer: wer(S.vocab, fixed), turns: 1, marks: '', secs: 0, text: fixed, note: `fixes: ${fixes.map((f) => `${f.from} -> ${f.to}`).join(', ') || 'none'}` });
  console.log(`fix pass: ${plain}\n   -> ${fixed}  (${rows.at(-1).note})`);
  // Unclear speech: first pass, then listening again with the conversation, then the deep model with the whole meeting.
  const context = [
    { who: 'Speaker 1', text: 'We need to lock the launch plan today.', t: 0 },
    { who: 'Speaker 2', text: 'Sarah said the budget is almost done, she can send it this week.', t: 5000 },
    { who: 'Speaker 1', text: 'Good, and the launch itself moves from Tuesday to Thursday.', t: 10000 },
    { who: 'Speaker 2', text: 'I think we should hire one more designer before the next quarter starts.', t: 15000 },
  ];
  const noise = (x, snrDb) => {
    const r = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) / 10 ** (snrDb / 20);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    return x.map((v) => v + r * Math.sqrt(12) * rnd());
  };
  const deepConf = { ...conf, model: conf.deepModel, keepAlive: 0 };
  // mask: words of the first pass replaced with [unclear], to exercise the passes (gemma4 never wrote [unclear] here).
  const passes = async (name, samples, ref, mask = []) => {
    const first = await row(`${name}: first pass`, samples, ref);
    const start = mask.reduce((t, w) => t.replace(new RegExp(`\\b${w}\\b`, 'i'), '[unclear]'), first.text);
    let text = start;
    if (mask.length) {
      rows.push({ name: `${name}: first pass with ${mask.join(', ')} masked (simulated)`, wer: wer(ref, text), turns: 1, marks: '[unclear]', secs: 0, text, note: 'simulated: the model never wrote [unclear] itself' });
      console.log(`${name}: masked -> ${text}`);
    }
    let note = 'no [unclear] in the first pass, so nothing to listen again for';
    if (/\[unclear\]/.test(text) && first.turns.length === 1) {
      const second = await transcribe(first.wav, conf, AbortSignal.timeout(60000), relistenPrompt(text, context, VOCAB));
      const fills = fillUnclear(text, second);
      text = applyFixes(text, fills).map((p) => p.text).join('');
      note = `second pass: "${second.trim().slice(0, 120)}"; fills used: ${fills.map((f) => f.to).join(', ') || 'none'}`;
    }
    rows.push({ name: `${name}: re-listen`, wer: wer(ref, text), turns: first.turns.length, marks: /\[unclear\]/.test(text) ? '[unclear]' : '', secs: 0, text, note });
    console.log(`${name}: re-listen -> ${text} (${note})`);
    // The deep pass starts from the same first pass, so the two can be compared.
    text = start;
    let dnote = 'no [unclear] to fill';
    if (/\[unclear\]/.test(text)) {
      const lines = [...context, { who: 'Speaker 1', text, t: 20000 }];
      const t0 = Date.now();
      let out = '';
      for await (const t of streamChat(buildUnclearPrompt(lines, 0), { temperature: 0, maxTokens: 400 }, deepConf)) out += t;
      const fills = parseFills(out, lines)[lines.length - 1] || [];
      text = applyFixes(text, fills).map((p) => p.text).join('');
      dnote = `${conf.deepModel} in ${((Date.now() - t0) / 1000).toFixed(0)} s; fills: ${fills.map((f) => f.to).join(', ') || 'none'}`;
    }
    rows.push({ name: `${name}: deep pass (from the first pass)`, wer: wer(ref, text), turns: first.turns.length, marks: /\[unclear\]/.test(text) ? '[unclear]' : '', secs: 0, text, note: dnote });
    console.log(`${name}: deep pass -> ${text} (${dnote})`);
  };
  await passes('noisy (SNR 3 dB)', noise(pcm('male'), 3), S.a);
  await passes('very noisy (SNR -3 dB)', noise(pcm('male'), -3), S.a);
  await passes('fast and noisy (rate +6, SNR 3 dB)', noise(pcm('fast'), 3), S.c);
  await passes('noisy (SNR 0 dB)', noise(pcm('male'), 0), S.a, ['Thursday', 'budget']);
  await passes('fast and noisy (rate +6, SNR 0 dB)', noise(pcm('fast'), 0), S.c);
  await passes('fast and noisy (rate +6, SNR 3 dB), second run', noise(pcm('fast'), 3), S.c, ['designer', 'quarter']);

  if (arabic) await row('Arabic', pcm('ar'), S.ar);
  else rows.push({ name: 'Arabic', wer: null, turns: 0, marks: '', secs: 0, text: '', note: `not measured: no Arabic voice installed (${voices.map((v) => v.name).join(', ')})` });

  // Speaker fingerprints: same voice vs different voices, and the online clustering the app uses.
  const vp = (k) => voiceprint(pcm(k), TARGET_RATE);
  const f0 = (v) => Math.round(150 * 2 ** (v.at(-1) / PITCH_WEIGHT));
  const V = { maleA: vp('male'), maleE: vp('e'), maleFast: vp('fast'), maleDeep: vp('deep'), femaleB: vp('female'), femaleF: vp('f'), femaleSlow: vp('slow') };
  const pairs = [['maleA', 'maleE'], ['maleA', 'maleFast'], ['femaleB', 'femaleF'], ['femaleB', 'femaleSlow'], ['maleA', 'femaleB'], ['maleE', 'femaleF'], ['maleFast', 'femaleSlow'], ['maleA', 'maleDeep']];
  const sims = pairs.map(([x, y]) => `${x}~${y} ${cosine(V[x], V[y]).toFixed(2)}`);
  const speakers = [];
  const order = ['maleA', 'femaleB', 'maleE', 'femaleF', 'maleFast', 'femaleSlow'];
  const labels = order.map((k) => `${k}=${assignSpeaker(V[k], speakers).id}`);
  const pitches = Object.entries(V).map(([k, v]) => `${k} ${f0(v)} Hz`);
  // The turn-change chunk split by the text length of each turn, as the app does.
  const tc = concat(pcm('e'), 0.35, pcm('f'));
  const lens = turn.turns.map((t) => t.text.length);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  const tcSpeakers = [];
  const tcLabels = turn.turns.map((t, i) => {
    const end = i === lens.length - 1 ? tc.length : at + Math.round((tc.length * lens[i]) / total);
    const v = voiceprint(tc.subarray(at, end), TARGET_RATE) || voiceprint(tc, TARGET_RATE);
    at = end;
    return assignSpeaker(v, tcSpeakers).id;
  });

  const pct = (w) => (w === null ? 'n/a' : `${Math.round(w * 100)}%`);
  const md = [
    `# Transcription quality, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `Model ${conf.model}. Voices: ${voices.map((v) => `${v.name} (${v.culture}, ${v.gender})`).join(', ')}. WER = word edits / reference words, after lowercasing and dropping punctuation and tags.`,
    '',
    '| Case | WER | Turns | Markers | Time | Note |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${pct(r.wer)} | ${r.turns} | ${r.marks} | ${r.secs ? `${r.secs.toFixed(1)} s` : ''} | ${r.note} |`),
    '',
    '## Outputs',
    '',
    ...rows.map((r) => `- ${r.name}: ${r.text || '(nothing)'}`),
    '',
    '## Speaker fingerprints',
    '',
    `Cosine similarity: ${sims.join(', ')}.`,
    '',
    `Median pitch: ${pitches.join(', ')}.`,
    '',
    `Online clustering (threshold ${SPEAKER_MATCH}, pitch weight ${PITCH_WEIGHT}), clips in order: ${labels.join(', ')}.`,
    '',
    `Turn-change chunk split by text length: ${turn.turns.length} turns labeled ${tcLabels.join(', ') || '(no turns)'}.`,
    '',
  ].join('\n');
  mkdirSync(join(ROOT, 'shots'), { recursive: true }); // shots/ is not in the repo
  writeFileSync(join(ROOT, 'shots', 'transcription-wer.md'), md);
  console.log(`\n${md}`);
  void withVocab;
}
