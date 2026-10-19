// node test/stt-gate.mjs   (Windows System.Speech voices, Ollama with gemma4:12b)
// Invented transcript lines (acceptance defect 3): a TTS meeting with pauses goes through the app's live path in Node,
// frame by frame like the page gets it: VAD endpointing (vadStep), the chunk gates, transcribe, parseTurns, and the turn
// gates. It runs twice, without the new gates (the old path: the RMS silence gate only) and with them (src/audio.mjs
// speechGate, src/prompts.mjs keepTurns), and prints both transcripts with their invented and missed lines.
// Prints "stt gate passed" when the gated run invents no line and hears every sentence the old path heard (gemma4:12b
// does not hear the TTS "Hi team." at all, alone or in context, so that one is reported, not required); exits 1 otherwise.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { concatFloat32, noiseStep, prepareChunk, rms, SILENCE_RMS, speechGate, VAD, VAD_START, vadStep } from '../src/audio.mjs';
import { keepTurns, parseTurns, transcribePrompt } from '../src/prompts.mjs';
import { PROVIDERS, transcribe } from '../src/providers.mjs';
import { normalizeWords } from './wer.mjs';

// The tester's meeting: short greetings, real sentences, and long pauses (the hallucinations came from those).
export const SCRIPT = [
  ['Hi team.', 2.5],
  ['Good morning.', 2],
  ['For this second meeting, Omar will review the dashboard before Thursday.', 3],
  ['Sarah will send the budget by Friday.', 4],
  ['Any questions?', 6],
  ['Okay, thank you all.', 8],
];
const RATE = 48000; // the page's AudioContext rate
const FRAME = 4096; // src/pcm-worklet.js posts this many samples at a time

// The meeting as a 16 kHz WAV in the temp folder, spoken once (test/acceptance-fixes-proof.mjs plays the same file).
export const WAV = join(tmpdir(), 'maverick-stt-gate', 'meeting.wav');
export function speakMeeting(wav = WAV) {
  mkdirSync(join(tmpdir(), 'maverick-stt-gate'), { recursive: true });
  if (existsSync(wav)) return wav;
  const ssml = SCRIPT.map(([t, pause]) => `${t}<break time="${pause * 1000}ms"/>`).join(' ');
  execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; '
    + '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono); '
    + `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}', $fmt); `
    + `$s.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${ssml}</speak>'); $s.Dispose()`], { stdio: 'inherit' });
  return wav;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  const wav = speakMeeting();
  // 16 kHz to 48 kHz (linear), plus a faint hiss at about -60 dBFS, like a real loopback between sentences.
  const b = readFileSync(wav);
  const at = b.indexOf('data') + 8;
  const src = new Float32Array((b.length - at) >> 1);
  for (let i = 0; i < src.length; i++) src[i] = b.readInt16LE(at + i * 2) / 32768;
  let seed = 7;
  const HISS = process.argv.includes("--hiss") ? 0.002 : 0; // --hiss: a faint noise floor between sentences
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * HISS; };
  const audio = new Float32Array(src.length * 3);
  for (let i = 0; i < audio.length; i++) { const x = i / 3; const k = Math.floor(x); audio[i] = (src[k] ?? 0) + ((src[k + 1] ?? 0) - (src[k] ?? 0)) * (x - k) + noise(); }

  const conf = { id: 'ollama', ...Object.fromEntries(PROVIDERS.ollama.fields.map((f) => [f.key, f.value])) };
  const prompt = transcribePrompt({});

  async function run(gated) {
    const out = [];
    let chunks = [];
    let vad = VAD_START;
    let floor = 0;
    const flush = async () => {
      const samples = concatFloat32(chunks);
      chunks = [];
      vad = VAD_START;
      if (!samples.length) return;
      const gate = gated ? speechGate(samples, RATE, SILENCE_RMS, floor) : { pass: true };
      const wav64 = gate.pass ? prepareChunk(samples, RATE, SILENCE_RMS) : null;
      if (!wav64) { out.push({ chunk: (samples.length / RATE).toFixed(1), skipped: true }); return; }
      const seconds = samples.length / RATE;
      const raw = await transcribe(wav64, conf, AbortSignal.timeout(60_000), prompt);
      let turns = parseTurns(raw, seconds);
      if (process.env.DEBUG) console.log(`  [debug] ${seconds.toFixed(1)} s, speech ${gate.voicedMs ?? '?'} ms: ${JSON.stringify(raw).slice(0, 300)}`);
      if (gated) turns = keepTurns(turns, samples, gate, out.filter((x) => x.text));
      if (!turns.length) out.push({ chunk: seconds.toFixed(1), empty: true });
      for (const t of turns) out.push({ chunk: seconds.toFixed(1), text: t.text });
    };
    for (let i = 0; i < audio.length; i += FRAME) {
      const frame = audio.subarray(i, i + FRAME);
      chunks.push(frame);
      const level = rms(frame);
      floor = noiseStep(floor, level, frame.length / RATE * 1000);
      vad = vadStep(vad, level, (frame.length / RATE) * 1000, VAD);
      if (vad.cut) await flush();
      else if (vad.idle && chunks.length > 6) chunks = chunks.slice(-6);
    }
    await flush();
    return out;
  }

  // A line is real when most of its words are in one sentence of the script.
  const spoken = SCRIPT.map(([t]) => normalizeWords(t));
  const isReal = (text) => { const w = normalizeWords(text); return w.length > 0 && spoken.some((s) => w.filter((x) => s.includes(x)).length / w.length >= 0.6); };
  const heard = (lines) => SCRIPT.filter(([t]) => { const s = normalizeWords(t); return lines.some((l) => { const w = normalizeWords(l.text); return s.filter((x) => w.includes(x)).length / s.length >= 0.6; }); }).length;

  const report = (name, lines) => {
    const text = lines.filter((l) => l.text);
    const invented = text.filter((l) => !isReal(l.text));
    console.log(`\n${name}: ${text.length} lines, ${invented.length} invented, ${heard(text)} of ${SCRIPT.length} sentences heard, ${lines.filter((l) => l.skipped).length} chunks gated out`);
    for (const l of lines) console.log(l.empty ? `  (no line from a ${l.chunk} s chunk)` : l.skipped ? `  (gated out: ${l.chunk} s chunk)` : `  ${isReal(l.text) ? '  ' : '! '}[${l.chunk} s] ${l.text}`);
    return { invented: invented.length, heard: heard(text) };
  };
  const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] || 1);
  let ok = true;
  for (let r = 0; r < runs; r++) {
    const before = report(`before (RMS gate only), run ${r + 1}`, await run(false));
    const after = report(`after (speech gate and turn filter), run ${r + 1}`, await run(true));
    console.log(`\nrun ${r + 1}: invented ${before.invented} -> ${after.invented}, sentences heard ${before.heard} -> ${after.heard} of ${SCRIPT.length}`);
    ok &&= after.invented === 0 && after.heard >= before.heard;
  }
  console.log(ok ? '\nstt gate passed' : '\nstt gate FAILED');
  process.exit(ok ? 0 : 1);
}
