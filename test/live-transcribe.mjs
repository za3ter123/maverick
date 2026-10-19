// node test/live-transcribe.mjs [file.wav]
// Live check against real Ollama. Without an argument it speaks a sentence with Windows
// System.Speech into a temp WAV, then runs it through the same path the browser uses:
// prepareChunk (silence gate, 16 kHz, WAV, base64) -> transcribe (providers.mjs) -> cleanTranscript.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareChunk } from '../src/audio.mjs';
import { cleanTranscript } from '../src/prompts.mjs';
import { PROVIDERS, transcribe } from '../src/providers.mjs';

const SENTENCE = "Hi team. Let's move the product launch to Thursday, and Sarah will send the budget by Friday.";
let file = process.argv[2];
const generated = !file;
if (generated) {
  file = join(tmpdir(), `cue-live-${process.pid}.wav`);
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.SetOutputToWaveFile('${file}'); $s.Speak('${SENTENCE.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'inherit' });
}

// Minimal RIFF reader for 16-bit PCM (test-only).
function decodeWav(buf) {
  let off = 12;
  let fmt;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (fmt?.bits !== 16) throw new Error(`Need 16-bit PCM, got ${fmt?.bits}`);
      const frames = Math.floor(size / 2 / fmt.channels);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(off + 8 + (i * fmt.channels + c) * 2);
        out[i] = s / fmt.channels / 32768;
      }
      return { samples: out, rate: fmt.rate, channels: fmt.channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('No data chunk');
}

const { samples, rate, channels } = decodeWav(readFileSync(file));
if (generated) rmSync(file, { force: true });
console.log(`input: ${(samples.length / rate).toFixed(2)} s, ${rate} Hz, ${channels} ch`);

const wav = prepareChunk(samples, rate);
if (!wav) throw new Error('Chunk was judged silent');
console.log(`chunk: ${Buffer.from(wav, 'base64').length} bytes of 16 kHz mono WAV`);

const conf = { id: 'ollama', ...Object.fromEntries(PROVIDERS.ollama.fields.map((f) => [f.key, f.value])) };
const t0 = Date.now();
const text = cleanTranscript(await transcribe(wav, conf));
console.log(`model: ${conf.model} at ${conf.url}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (generated) console.log(`spoken:     ${SENTENCE}`);
console.log(`transcript: ${text}`);
if (!text) process.exitCode = 1;
