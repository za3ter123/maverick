// Pure audio helpers. No DOM, so the browser and Node share them.

export const TARGET_RATE = 16000;
export const SILENCE_RMS = 0.004; // about -48 dBFS
// The mic chunk needs more: faint speaker bleed passed the meeting gate and the model heard a whole Arabic sentence
// in it that nobody said (desktop proof, 2026-09-27). Speech into a mic is far louder than -40 dBFS.
export const MIC_RMS = 0.01;

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function isSilent(samples, threshold = SILENCE_RMS) {
  return rms(samples) < threshold;
}

export function concatFloat32(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Box-filter decimation: each output sample averages the input span it covers.
// Good enough for speech going to 16 kHz; not a studio resampler.
export function downsample(samples, fromRate, toRate = TARGET_RATE) {
  if (fromRate === toRate) return Float32Array.from(samples);
  if (fromRate < toRate) throw new Error(`Cannot upsample ${fromRate} Hz to ${toRate} Hz`);
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / (end - start);
  }
  return out;
}

// 16-bit PCM mono WAV.
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// The whole capture path for one chunk: silence gate, 16 kHz, WAV, base64.
// Returns null when the chunk is silent.
export function prepareChunk(samples, inputRate, threshold = SILENCE_RMS) {
  if (isSilent(samples, threshold)) return null;
  return bytesToBase64(encodeWav(downsample(samples, inputRate), TARGET_RATE));
}

// Voice-activity endpointing, one step per audio batch. Before any speech nothing is kept but a short
// pre-roll (idle). After speech starts, the chunk is cut after a pause of pauseMs once it is at least
// minMs long, or at maxMs.
export const VAD = { pauseMs: 600, minMs: 1000, maxMs: 12000, threshold: SILENCE_RMS };
export const VAD_START = { total: 0, voiced: 0, quiet: 0, idle: true, cut: false };
export function vadStep(s, level, ms, o = VAD) {
  const speech = level >= o.threshold;
  if (!s.voiced && !speech) return VAD_START;
  const total = s.total + ms;
  const voiced = s.voiced + (speech ? ms : 0);
  const quiet = speech ? 0 : s.quiet + ms;
  return { total, voiced, quiet, idle: false, cut: total >= o.maxMs || (quiet >= o.pauseMs && total >= o.minMs) };
}

// ---------------------------------------------------------------- speech gate
// A speech model given a chunk with little speech in it writes some anyway ("My name is John. I am from London." from a
// pause after "Good morning", acceptance defect 3). So a chunk goes out only when it holds enough speech, measured in
// 20 ms frames louder than the gate: the silence threshold, or three times the noise floor (about +10 dB) where the
// audio is never quite silent. keepTurns (prompts.mjs) then checks each line against its share of these frames.

// The noise floor of a tap: its quiet level, followed down at once and up slowly (doubling takes about 5 s), so speech
// does not lift it but a noisier room does.
export function noiseStep(floor, level, ms) {
  if (!(floor > 0) || level < floor) return level;
  return Math.min(level, floor * 2 ** (ms / 5000));
}

export const SPEECH_FRAME_MS = 20;
export const MIN_SPEECH_MS = 300;
// Speech runs: voiced frames apart by under SEGMENT_GAP_MS belong to one run (a pause between sentences or speakers is
// longer; one between words is shorter).
export const SEGMENT_GAP_MS = 200;
// { pass, level (the gate), voicedMs, segments (speech runs), voiced: [true|false per 20 ms frame] }.
export function speechGate(samples, rate, threshold = SILENCE_RMS, floor = 0) {
  const level = Math.max(threshold, 3 * (floor || 0));
  const n = Math.round((rate * SPEECH_FRAME_MS) / 1000);
  const voiced = [];
  for (let i = 0; i + n <= samples.length; i += n) voiced.push(rms(samples.subarray(i, i + n)) >= level);
  let segments = 0;
  let gap = Infinity;
  for (const v of voiced) { if (v) { if (gap * SPEECH_FRAME_MS >= SEGMENT_GAP_MS) segments++; gap = 0; } else gap++; }
  const voicedMs = voiced.filter(Boolean).length * SPEECH_FRAME_MS;
  return { pass: voicedMs >= MIN_SPEECH_MS, level, voicedMs, segments, voiced };
}

// ---------------------------------------------------------------- speaker labels (estimates)

// Power spectrum of one real frame (length a power of two), radix-2 FFT.
const twiddles = new Map();
function powerSpectrum(frame) {
  const n = frame.length;
  if (!twiddles.has(n)) twiddles.set(n, Array.from({ length: n / 2 }, (_, k) => [Math.cos((-2 * Math.PI * k) / n), Math.sin((-2 * Math.PI * k) / n)]));
  const tw = twiddles.get(n);
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const [wr, wi] = tw[k * step];
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
      }
    }
  }
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

// Pitch between 70 and 400 Hz by normalized autocorrelation, or 0 when the frame is not voiced. Two periods
// correlate as well as one, so the shortest lag within 90% of the best peak wins (no octave-low errors).
export function pitchOf(frame, rate) {
  const lo = Math.floor(rate / 400);
  const hi = Math.min(Math.floor(frame.length / 2), Math.ceil(rate / 70));
  const r = new Float64Array(hi + 2);
  let best = 0;
  for (let l = lo; l <= hi + 1; l++) {
    let xy = 0; let xx = 0; let yy = 0;
    for (let i = 0; i + l < frame.length; i++) { xy += frame[i] * frame[i + l]; xx += frame[i] * frame[i]; yy += frame[i + l] * frame[i + l]; }
    r[l] = xy / Math.sqrt(xx * yy || 1);
    if (l <= hi) best = Math.max(best, r[l]);
  }
  if (best < 0.5) return 0;
  for (let l = lo + 1; l <= hi; l++) if (r[l] >= 0.9 * best && r[l] >= r[l - 1] && r[l] >= r[l + 1]) return rate / l;
  return 0;
}

const FRAME = 512;
const BANDS = 16;
const mel = (f) => 2595 * Math.log10(1 + f / 700);
const BAND_EDGES = (() => {
  const lo = mel(80); const hi = mel(7600);
  return Array.from({ length: BANDS + 1 }, (_, i) => 700 * (10 ** ((lo + ((hi - lo) * i) / BANDS) / 2595) - 1));
})();
export const PITCH_WEIGHT = 6; // test/wer.mjs: at 6, TTS voices were 0.955+ with themselves and 0.82 or less with each other

// A small voice fingerprint for speaker labels: the average log energy in 16 mel bands over voiced frames with
// its mean removed (the shape of the voice, not its loudness), plus the median pitch. Good enough to tell a few
// voices apart; not speaker recognition. Returns null for audio with under 0.3 s of voice.
export function voiceprint(samples, inputRate) {
  const x = inputRate === TARGET_RATE ? samples : downsample(samples, inputRate);
  const bin = TARGET_RATE / FRAME;
  const bands = new Float64Array(BANDS);
  const pitches = [];
  let voiced = 0;
  const win = Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  for (let s = 0; s + FRAME <= x.length; s += FRAME / 2) {
    const frame = x.subarray(s, s + FRAME);
    if (rms(frame) < SILENCE_RMS * 2) continue;
    voiced++;
    const p = powerSpectrum(frame.map((v, i) => v * win[i]));
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = Math.ceil(BAND_EDGES[b] / bin); k < Math.ceil(BAND_EDGES[b + 1] / bin); k++) e += p[k];
      bands[b] += Math.log(e + 1e-9);
    }
    if (voiced % 3 === 0) { const f0 = pitchOf(frame, TARGET_RATE); if (f0) pitches.push(f0); }
  }
  if (voiced * (FRAME / 2) < TARGET_RATE * 0.3) return null;
  const avg = [...bands].map((b) => b / voiced);
  const mean = avg.reduce((a, b) => a + b, 0) / BANDS;
  pitches.sort((a, b) => a - b);
  const f0 = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
  return [...avg.map((b) => b - mean), f0 ? PITCH_WEIGHT * Math.log2(f0 / 150) : 0];
}

export function cosine(a, b) {
  let ab = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb || 1);
}

// Online clustering: the closest known voice if it is similar enough (its centroid moves toward this one),
// otherwise a new "Speaker N". After maxSpeakers, the closest voice wins. speakers: [{ id, name, centroid, n }].
export const SPEAKER_MATCH = 0.9;
export function assignSpeaker(vec, speakers, threshold = SPEAKER_MATCH, maxSpeakers = 8) {
  let best = null;
  let sim = -2;
  for (const s of speakers) { const c = cosine(vec, s.centroid); if (c > sim) { sim = c; best = s; } }
  if (best && (sim >= threshold || speakers.length >= maxSpeakers)) {
    best.n++;
    best.centroid = best.centroid.map((v, k) => v + (vec[k] - v) / best.n);
    return best;
  }
  const id = `Speaker ${speakers.length + 1}`;
  const s = { id, name: id, centroid: [...vec], n: 1 };
  speakers.push(s);
  return s;
}
