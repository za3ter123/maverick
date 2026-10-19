import { assignSpeaker, concatFloat32, MIC_RMS, noiseStep, prepareChunk, rms, SILENCE_RMS, speechGate, VAD, VAD_START, vadStep, voiceprint } from './audio.mjs';
import {
  ACTIONS, applyFixes, buildFixPrompt, EARLIER_ACTIONS, buildPartPrompt, buildPrompt, buildSubtitlePrompt, buildUnclearPrompt, cleanSubtitle, coveredSince, elapsed, fillUnclear, fixMixedScript, flagLine, formatTranscript, isEcho,
  keepTurns, parseFills, parseFixes, parseTurns, RECENT_MS, relistenPrompt, dropPlaceholders, splitTranscript, stripThinking, SUBTITLE_MODES, subtitleLanguage, TRANSCRIBE_PROMPT, transcribePrompt,
  buildEntityPrompt,
} from './prompts.mjs';
import { CANARY } from './canary.mjs';
import {
  buildGroundedPrompt, checkGrounded, enough, extractVocab, GROUNDED_TASKS, markRanges, missingLines, notCovered, SCREEN_PROBLEM, SOURCE_ACTIONS, sourceChips, SOURCES,
  urlChips, withWeb, rankChunks,
} from './library.mjs';
import {
  ACCEPT, addFiles, blobOf, fileById, kindOf, lib, MAX_BYTES, onChange as onLibrary, openLibrary, readPages, removeFile, renderPdfPage, search as searchLibrary, totalBytes,
  EMBED_DOC, EMBED_QUERY,
} from './libstore.mjs';
import {
  backlinkIndex, dateOf, entityLine, entityPage, forceLayout, graphOf, homeworkNote, meetingEntities, meetingNote, memChips, noteChunks, noteKey, noteName,
  parseEntities, parseNote, wikiHtml,
} from './memory.mjs';
import {
  CHOICE_TASK, choiceQuestion, enoughForHomework, formNeeds, HOMEWORK_TASK, homeworkMarkdown, isMath, LETTERS, matchQuestion, parseChoice, parseTyped, splitQuestions,
  textTask, UPLOAD_TASK, WEB_CHOICE_TASK, WEB_UPLOAD_TASK, webQuestion, webTextTask, WORKSHEET_READ_PROMPT, worksheetLang,
} from './homework.mjs';
import { escapeHtml, holdOpen, linkCites, renderMarkdown, TIME } from './markdown.mjs';
import { actionItemsMarkdown, extractActionItems, fitHistory, groundNotes, meetingToMarkdown, migrateStorage, searchMeetings, withFlagSection } from './meetings.mjs';
import {
  connFields, countSend, defaultModel, egress, embedPublik, firstTokenWithin, isLocalConn, loadModels, ollamaWarm, openKeys, PRESETS, PROVIDERS, PUBLIK_MODELS, remoteForTest, roleConf, roleError, ROLES, sealKeys,
  isPublikTopUp, streamChat, transcribe,
} from './providers.mjs';
import {
  dHash, earlierMeetings, earlierMeetingsText, isLikelyQuestion, isPointing, routeAssist, SCREEN_READ_PROMPT, screenAt, screenReadsText, SLIDE_START, slideStep,
} from './copilot.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const TOKEN = $('meta[name="cue-token"]')?.content || '';
const desk = window.maverick; // the desktop app's bridge (desktop/preload.cjs); undefined in a browser
let shareCheck = null; // the last share check (renderShare); declared up here because renderEgress paints the badge from boot
if (desk?.glass) document.documentElement.classList.add('glass'); // Mica window: the preload sets it too, before first paint
const SETTINGS_KEY = 'maverick.settings';
const HISTORY_KEY = 'maverick.meetings';
const LIVE_KEY = 'maverick.live';
const HISTORY_MAX_CHARS = 4_000_000; // localStorage holds about 5 million characters per origin
const TEST_TIMEOUT_MS = 60_000;
const CATCH_UP_MS = 4000;
const QUIET_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  chunkSeconds: 12, // the longest chunk; a pause in speech sends one sooner
  languages: '', // blank: Auto, which expects Arabic, English or both
  answerLang: 'auto',
  vocab: '',
  fixWords: true,
  subtitles: 'auto', // 'off', 'auto', 'English' or 'Arabic' (prompts.mjs, subtitleLanguage)
  sources: 'meeting', // 'meeting', 'web' or 'material' (My material only): what Answer, Ask, Solve and Follow-ups work from
  fileVocab: true, // names and acronyms from the library go to transcription too
  style: '', // the user's style rules ("answer in bullets, max 3 sentences"), added to every answer prompt
};

// connections and roles (providers.mjs, loadModels): settings saved before them become them, a fresh install gets local Ollama
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* corrupt, use defaults */ }
  const { provider, transcriber, providers, ...rest } = s;
  const merged = { ...DEFAULTS, ...rest, ...loadModels(s) };
  merged.connections = openKeys(merged.connections, unseal);
  if (!SUBTITLE_MODES.includes(merged.subtitles)) merged.subtitles = DEFAULTS.subtitles;
  if (!SOURCES.includes(merged.sources)) merged.sources = DEFAULTS.sources;
  return merged;
}

// API keys are sealed at rest by the desktop app (Electron safeStorage, Windows DPAPI, in main.cjs); the browser build has
// nothing to seal with and keeps them as before.
const seal = (text) => desk?.seal?.(text) ?? null;
const unseal = (text) => desk?.unseal?.(text) ?? null;
const storeSettings = (s) => store(SETTINGS_KEY, JSON.stringify({ ...s, connections: sealKeys(s.connections, seal) }));

function store(key, value) {
  try { localStorage.setItem(key, value); return true; } catch {
    toast('This browser storage is full, so a change was not saved. Delete old meetings in History.', 'error');
    return false;
  }
}

try { migrateStorage(localStorage); } catch { /* storage blocked: nothing to move */ }
let settings = loadSettings();
// Keys saved in plain text (before sealing, or an old settings file) are sealed now.
try {
  const raw = localStorage.getItem(SETTINGS_KEY) || '';
  if (desk?.seal && settings.connections.some((c) => c.key && raw.includes(c.key))) storeSettings(settings);
} catch { /* storage blocked */ }
// The request conf of a role (live, deep, vision, transcribe, web); it throws, saying so, when its connection is gone.
const conf = (role) => ({ ...roleConf(settings, role), token: TOKEN });
const tryConf = (role) => { try { return conf(role); } catch { return null; } };
const shortName = () => { const c = tryConf('live'); return c ? [c.name.replace(/ \(.*?\)/, ''), c.model || c.command].filter(Boolean).join(' ') : 'No assistant'; };
// Where Ollama embeddings run: the first local Ollama connection, or Ollama's usual address. With Live answers on publik
// API, embeddings go to publik instead (libModels.embed).
const ollamaUrl = () => settings.connections.find((c) => c.type === 'ollama' && isLocalConn(c))?.url || PROVIDERS.ollama.fields[0].value;
let deepMissing = false; // set by checkHealth: without it installed, the notes use the answer model
// the first-run publik API offer (renderPublikOffer)
const PUBLIK_OFFER_KEY = 'maverick.publikOffer'; // 'no' once declined
let ollamaDown = false; // checkHealth: an Ollama the roles need did not answer
let publikCard = null; // after Yes: { balance, cost_sentence, claim_url, claim_state, add_credit_url } | { error }
let publikInfo = null; // { disclosure, card, hasToken } from the main process, asked once
// The deep model (the Reasoning role) writes the notes and runs Think harder, with any connection. Null when there is no
// separate deep model. keepAlive 0: Ollama unloads it right after the answer, so the live model gets the GPU back.
function deepConf() {
  const c = settings.roles.deep.model ? tryConf('deep') : null;
  const live = tryConf('live');
  if (!c || (c.conn === live?.conn && c.model === live.model) || (c.id === 'ollama' && deepMissing)) return null;
  return { ...c, keepAlive: 0 };
}
// The deep model's first word must come within 60 s, or the live model takes over: twice the "about 30 s" load the
// app promises, so a model that fits loads and reads its prompt in time, and one that cannot fit (the GPU already
// holds the live model) costs a minute; the notes once waited on one for more than 400 s.
const DEEP_START_MS = 60_000;
async function isLoaded(c) {
  try {
    const res = await fetch(`${c.url.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).models.some((m) => m.name === c.model || m.name === `${c.model}:latest`);
  } catch { return false; }
}
// The deep model pushed the live model out of GPU memory. Load it back before the next transcription runs,
// so the first chunk does not spend its time limit waiting for the reload.
let warming = '';
function rewarm() {
  const c = ['transcribe', 'live'].map(tryConf).find((x) => x?.id === 'ollama');
  if (!c) return renderBusy();
  const r = ollamaWarm(c);
  warming = c.model;
  renderBusy();
  queue = queue
    .then(async () => { countSend(r.url, JSON.stringify(r.body), r.headers); await (await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(120_000) })).text(); })
    .catch(() => {})
    .finally(() => { warming = ''; renderBusy(); });
}

// ---------------------------------------------------------------- state

let meeting = null; // { id, title, startedAt, transcript: [{ who, text, t }], flags: [t], answers: [...] }
let display = null;
let mic = null;
let ac = null;
let sink = null;
const taps = {}; // 'meeting' | 'mic' -> { src, node, chunks, len, level, peak }
let metering = false;
let queue = Promise.resolve();
let pending = 0;
let skipped = 0;
let failures = 0;
let echoes = 0;
let lastHeard = 0;
let aiReady = false;
let hasHistory = false;
const answers = [];
let seq = 0;
let active = null;
let pip = null;
let summaryMeeting = null;
let ending = false;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const docs = () => [document, pip && pip !== window ? pip.document : null].filter(Boolean);

// ---------------------------------------------------------------- feedback

// One polite live region per window. Only changes that matter are announced, never the clock or tokens.
function announce(msg) {
  for (const d of docs()) {
    const sr = $('.sr', d);
    if (!sr) continue;
    sr.textContent = '';
    setTimeout(() => { sr.textContent = msg; }, 50);
  }
}

// Toasts show in the main window and the pop-out, because during a call only the pop-out is visible.
function toast(msg, kind = 'info') {
  for (const d of docs()) {
    let box = $('#toasts', d);
    if (!box) {
      box = Object.assign(d.createElement('div'), { id: 'toasts', className: 'toasts' });
      box.setAttribute('aria-live', 'polite');
      d.body.append(box);
    }
    if ($$('.toast', box).some((t) => t.dataset.msg === msg)) continue;
    const el = d.createElement('div');
    el.className = `toast ${kind}`;
    if (kind === 'error') el.setAttribute('role', 'alert');
    el.dataset.msg = msg;
    el.innerHTML = `<svg class="i"><use href="#i-alert"/></svg><span>${escapeHtml(msg)}</span>`;
    box.append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 6000);
  }
}

// Copy, then flip the button to a check (icon buttons) or "Copied" (text buttons) for a moment.
async function copyText(text, btn) {
  try {
    await btn.ownerDocument.defaultView.navigator.clipboard.writeText(text);
  } catch {
    return toast('Copy failed. Select the text and copy it by hand.', 'error');
  }
  const use = btn.querySelector('use');
  const label = btn.querySelector('span') || (use ? null : btn);
  const before = [use?.getAttribute('href'), label?.textContent, btn.getAttribute('aria-label')];
  use?.setAttribute('href', '#i-check');
  if (label) label.textContent = 'Copied';
  if (before[2]) btn.setAttribute('aria-label', 'Copied');
  btn.classList.add('done');
  announce('Copied.');
  setTimeout(() => {
    if (use) use.setAttribute('href', before[0]);
    if (label) label.textContent = before[1];
    if (before[2]) btn.setAttribute('aria-label', before[2]);
    btn.classList.remove('done');
  }, 1400);
}

// extra: { cmd: a command to show and copy, action: { label, run } }
const banners = new Map();
function banner(key, msg, kind = 'warn', extra = {}) {
  const had = banners.get(key)?.msg;
  if (msg) banners.set(key, { msg, kind, ...extra }); else banners.delete(key);
  if (msg && had !== msg) announce(msg);
  $('#banners').innerHTML = [...banners].map(([k, b]) =>
    `<div class="banner ${b.kind}" data-key="${k}"><svg class="i"><use href="#i-alert"/></svg>` +
    `<span class="msg">${escapeHtml(b.msg)}${b.cmd ? ` <span class="fix">Run <code>${escapeHtml(b.cmd)}</code> in a terminal.</span>` : ''}</span>` +
    '<span class="acts">' +
    (b.cmd ? '<button class="btn sm ghost" data-copy-cmd>Copy</button>' : '') +
    (b.action ? `<button class="btn sm" data-act>${escapeHtml(b.action.label)}</button>` : '') +
    '<button class="btn sm icon ghost" data-dismiss aria-label="Dismiss"><svg class="i sm"><use href="#i-x"/></svg></button></span></div>').join('');
  renderMiniAlert();
}
$('#banners').addEventListener('click', (e) => {
  const el = e.target.closest('.banner');
  const btn = e.target.closest('button');
  const b = el && banners.get(el.dataset.key);
  if (!b || !btn) return;
  if (btn.hasAttribute('data-dismiss')) banner(el.dataset.key);
  else if (btn.hasAttribute('data-act')) b.action.run();
  else if (btn.hasAttribute('data-copy-cmd')) copyText(b.cmd, btn);
});

// The pop-out shows the most important banner as one line under its bar.
function renderMiniAlert() {
  if (!pip) return;
  const row = $('.mini-alert', pip.document);
  const [key, b] = [...banners].sort(([, x], [, y]) => (y.kind === 'bad') - (x.kind === 'bad'))[0] || [];
  row.hidden = !b;
  if (!b) return;
  row.className = `mini-alert ${b.kind}`;
  row.dataset.key = key;
  $('.msg', row).textContent = b.msg;
  const act = $('[data-cmd="alert-act"]', row);
  act.hidden = !b.action;
  act.textContent = b.action?.label || '';
}

function setPill(el, cls, text) {
  el.className = `pill ${cls}${el.classList.contains('mini-rec') ? ' mini-rec' : ''}`;
  el.querySelector('span').textContent = text;
}

function permissionMessage(e, what) {
  const name = what === 'mic' ? 'Microphone access' : 'Screen sharing';
  if (e.name === 'NotAllowedError') return `${name} was blocked or cancelled. Allow it in Chrome’s address bar and try again.`;
  if (e.name === 'NotFoundError') return what === 'mic' ? 'No microphone was found.' : 'Nothing was available to share.';
  if (e.name === 'NotReadableError') return `${name} failed because another app is using the device.`;
  return `${name} failed: ${e.message}`;
}

// ---------------------------------------------------------------- health

async function checkHealth() {
  const [live, tr, vision] = ['live', 'transcribe', 'vision'].map(tryConf);
  const deep = settings.roles.deep.model ? tryConf('deep') : null;
  $('#st-local').hidden = ![live, tr, vision].every(isLocalConn) || !!(deep && !isLocalConn(deep));
  // the installed models of each Ollama, fetched once per check; null when it did not answer
  const tags = {};
  const installed = (c) => (tags[c.url] ??= fetch(`${c.url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) })
    .then(async (res) => (await res.json()).models.map((m) => m.name)).catch(() => null));
  const has = (names, m) => names.includes(m) || names.includes(`${m}:latest`);
  const need = [live, tr].filter((c) => c?.id === 'ollama');
  ollamaDown = false;
  if (need.length) setPill($('#st-ai'), 'busy', 'Checking AI');
  if (deep?.id === 'ollama') { const names = await installed(deep); if (names) deepMissing = !has(names, deep.model); }
  if (!need.length) {
    banner('ollama');
    aiReady = !!live;
    setPill($('#st-ai'), '', shortName()); // not checked: neutral, not green
    return renderChecklist();
  }
  const again = { label: 'Check again', run: checkHealth };
  aiReady = false;
  for (const c of need) {
    const names = await installed(c);
    if (!names) {
      ollamaDown = true;
      setPill($('#st-ai'), 'bad', 'Ollama offline');
      banner('ollama', `Can’t reach Ollama at ${c.url}.`, 'bad', { cmd: 'ollama serve', action: again });
      return renderChecklist();
    }
    if (!has(names, c.model)) {
      setPill($('#st-ai'), 'warn', 'Model missing');
      banner('ollama', `Ollama is running but “${c.model}” is not installed.`, 'warn', { cmd: `ollama pull ${c.model}`, action: again });
      return renderChecklist();
    }
  }
  banner('ollama');
  aiReady = true;
  setPill($('#st-ai'), 'ok', shortName());
  renderChecklist();
}

// ---------------------------------------------------------------- capture

function startMeeting() {
  if (meeting) return;
  const now = new Date();
  meeting = {
    id: crypto.randomUUID(),
    title: `Meeting ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    startedAt: now.getTime(),
    transcript: [],
    flags: [],
    answers: [],
    screens: [], // what the shared screen showed, read each time it changed: [{ t, hash, text }]
    egress: 0, // bytes sent off this PC during the meeting (providers.mjs, countSend)
  };
  echoes = 0;
  slides = SLIDE_START;
  renderTranscript();
  saveLive();
  startRecording(meeting);
}

async function audioGraph() {
  if (!ac) {
    ac = new AudioContext();
    await ac.audioWorklet.addModule('src/pcm-worklet.js');
    sink = ac.createGain();
    sink.gain.value = 0; // keep the graph running without playing the meeting back
    sink.connect(ac.destination);
  }
  if (ac.state === 'suspended') await ac.resume();
}

// One app's sound (desktop/main.cjs, app-audio): the shared or recorded window's own process tree, so YouTube or a game
// on the same PC stays out. { stream, node, exe, stop } or { why, exe } when Windows cannot or the app plays nothing.
const appFeeds = {}; // id -> pcm-in worklet node (src/pcm-worklet.js)
desk?.onAppAudio?.((id, bytes) => appFeeds[id]?.port.postMessage(bytes, [bytes.buffer]));
const APP_AUDIO_WHY = { 'no-session': 'it is not playing any sound yet', unavailable: 'this Windows cannot record one app on its own (Windows 10 2004 or later can)' };
async function appAudioStream(source) {
  const r = await desk?.appAudioStart?.(source);
  if (!r?.id) return { why: r?.error || 'unavailable', exe: r?.exe };
  await audioGraph();
  const node = new AudioWorkletNode(ac, 'pcm-in', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { rate: 48000 } });
  appFeeds[r.id] = node;
  const dest = ac.createMediaStreamDestination();
  node.connect(dest);
  return { stream: dest.stream, node, exe: r.exe, stop: () => { desk.appAudioStop(r.id); delete appFeeds[r.id]; node.disconnect(); } };
}
const appAudioFallback = (app, what) => `${app.exe || 'That app'}: ${APP_AUDIO_WHY[app.why] || APP_AUDIO_WHY.unavailable}, so ${what} all the sound on this PC instead.`;
let shareApp = null; // Share meeting's app sound, when a window is shared

async function attach(key, stream) {
  await audioGraph();
  const src = ac.createMediaStreamSource(stream);
  if (recDest && !(recApp && key === 'meeting')) src.connect(recDest);
  const node = new AudioWorkletNode(ac, 'pcm-tap');
  const tap = { src, node, chunks: [], len: 0, level: 0, peak: 0, floor: 0, vad: VAD_START };
  const vad = { ...VAD, maxMs: settings.chunkSeconds * 1000 };
  node.port.onmessage = (e) => {
    tap.chunks.push(e.data);
    tap.len += e.data.length;
    tap.level = rms(e.data);
    tap.peak = Math.max(tap.peak, tap.level);
    tap.floor = noiseStep(tap.floor, tap.level, (e.data.length / ac.sampleRate) * 1000); // audio.mjs, speechGate
    // Send a chunk when the speaker pauses, not on a clock, so words are not cut in half.
    tap.vad = vadStep(tap.vad, tap.level, (e.data.length / ac.sampleRate) * 1000, vad);
    if (tap.vad.cut) flush(key);
    else if (tap.vad.idle && tap.chunks.length > 6) { tap.chunks = tap.chunks.slice(-6); tap.len = tap.chunks.reduce((n, c) => n + c.length, 0); } // 0.5 s pre-roll
  };
  src.connect(node).connect(sink);
  taps[key] = tap;
  if (key === 'meeting') lastHeard = Date.now();
  if (!metering) { metering = true; requestAnimationFrame(meters); }
}

function meters() {
  for (const key of ['meeting', 'mic']) {
    $(`#lvl-${key}`).style.setProperty('--lvl', Math.min(1, (taps[key]?.level || 0) * 5));
  }
  if (Object.keys(taps).length) requestAnimationFrame(meters); else metering = false;
}

function flushAll() {
  for (const key of Object.keys(taps)) flush(key);
}

function flush(key) {
  const tap = taps[key];
  if (!tap?.len) return;
  const samples = concatFloat32(tap.chunks);
  tap.chunks = [];
  tap.len = 0;
  tap.vad = VAD_START;
  // ponytail: when three chunks already wait, or a live answer is being written (it shares the model), the audio
  // rides along with the next chunk. Past 30 s the oldest audio is dropped and counted; a faster model is the real fix.
  // A deep answer does not hold audio back: its chunks queue, and Ollama runs them once the deep model lets go of the GPU.
  if (pending >= 3 || (active && !active.catching && !active.deep)) {
    const cap = ac.sampleRate * 30;
    const keep = samples.length > cap ? samples.subarray(samples.length - cap) : samples;
    if (keep !== samples) { skipped++; renderBusy(); }
    tap.chunks = [keep];
    tap.len = keep.length;
    tap.vad = { ...VAD_START, voiced: 1, idle: false }; // held audio is speech: cut again at the next pause
    return;
  }
  // Too little speech in it to send: a speech model writes words for a pause (audio.mjs, speechGate).
  const rate = ac.sampleRate;
  const threshold = key === 'mic' ? MIC_RMS : SILENCE_RMS;
  const gate = speechGate(samples, rate, threshold, tap.floor);
  const wav = gate.pass && prepareChunk(samples, rate, threshold);
  if (!wav) return; // silence
  const seconds = samples.length / rate;
  const t = Date.now() - seconds * 1000;
  const target = meeting; // late results still land in the meeting they were heard in
  enqueue(async () => {
    // A model that never stops would block the queue and every answer behind it.
    // While the deep model holds the GPU, a chunk can wait a minute or more for the live model.
    const limit = active?.deep ? 180 : Math.max(16, settings.chunkSeconds * 2);
    const signal = AbortSignal.timeout(limit * 1000);
    let turns;
    try { turns = await transcribeTurns(wav, seconds, signal); } catch (e) {
      throw signal.aborted ? new Error(`a chunk took longer than ${limit} s and was skipped`) : e;
    }
    if (failures) { failures = 0; banner('transcribe'); }
    turns = keepTurns(turns, samples, gate, target?.transcript ?? []); // lines the audio does not back (prompts.mjs)
    if (!turns.length) return;
    if (key === 'mic') {
      const line = addLine('You', turns.map((x) => x.text).join(' '), t, target);
      if (line) sideCheck(line, target, turns.length === 1 ? wav : null);
      return;
    }
    // Meeting audio: each turn gets the voice of its share of the chunk (split by text length, keepTurns) and a speaker label.
    for (const turn of turns) {
      const spk = speakerFor(samples.subarray(turn.start, turn.end), samples, rate, target);
      const text = (turn.overlap ? '[overlap] ' : '') + turn.text;
      const line = addLine(spk?.name ?? 'Meeting', text, t + (turn.start / rate) * 1000, target, spk ? { spk: spk.id } : {});
      if (line) sideCheck(line, target, turns.length === 1 ? wav : null); // listening again needs the chunk to be this one line
    }
  });
}

let fileVocab = []; // names and acronyms found in the library (library.mjs, extractVocab)
const vocabList = () => [...new Set([...settings.vocab.split(/[,\n]/).map((w) => w.trim()).filter(Boolean), ...(settings.fileVocab ? fileVocab : [])])].slice(0, 60);

// The meeting prompt first; after a refusal (fast speech sometimes gets one) the plain prompt once more.
async function transcribeTurns(wav, seconds, signal) {
  const c = conf('transcribe');
  const raw = await transcribe(wav, c, signal, transcribePrompt({ languages: settings.languages, vocab: vocabList() }));
  window.maverickTest?.raw.push(raw); // test/acceptance-fixes-proof.mjs logs what the model wrote
  const turns = parseTurns(raw, seconds);
  if (turns.length || !raw.trim()) return turns;
  return parseTurns(await transcribe(wav, c, signal, TRANSCRIBE_PROMPT), seconds);
}

// Speaker labels are estimates: a voice fingerprint of the turn's audio (or the whole chunk when the turn is too
// short) joins the closest known voice of this meeting, or becomes Speaker N.
function speakerFor(part, whole, rate, target) {
  const v = voiceprint(part, rate) || voiceprint(whole, rate);
  if (!v) return null;
  target.speakers ??= [];
  return assignSpeaker(v, target.speakers);
}

// Off the answer path, one line at a time: listen again to fill [unclear] words, then let the live model fix
// clearly misheard words, then write the line's subtitle. Each step only starts while no chunk waits, no answer is
// being written (Think harder included) and the live model is not reloading, and Answer never waits for it.
// Every change is kept as a fix on the raw line and shown underlined.
let side = Promise.resolve();
const sideBusy = () => pending || active || warming;
async function whenIdle() {
  for (let i = 0; i < 120 && sideBusy(); i++) await sleep(500);
  return !sideBusy();
}
function sideCheck(line, target, wav) {
  if (settings.fixWords) side = side.then(async () => {
    if (!(await whenIdle())) return;
    const c = conf('transcribe');
    const i = target.transcript.indexOf(line);
    const recent = target.transcript.slice(Math.max(0, i - 10), i);
    if (wav && /\[unclear\]/.test(line.text)) {
      const second = await transcribe(wav, c, AbortSignal.timeout(30_000), relistenPrompt(line.text, recent, vocabList()));
      addFixes(line, fillUnclear(line.raw ?? line.text, second), target);
    }
    if (sideBusy()) return;
    let out = '';
    for await (const t of streamChat(buildFixPrompt(line.text, recent, vocabList()), { temperature: 0, maxTokens: 160, signal: AbortSignal.timeout(20_000) }, c)) out += t;
    addFixes(line, parseFixes(out, line.text), target);
  }).catch(() => {});
  // The subtitle goes after the fixes, so it translates the corrected line.
  if (settings.subtitles !== 'off') side = side.then(() => subtitle(line, target)).catch(() => {});
}

// A translation of one finished line, kept on the line ({ lang, text }), so History, the Markdown export and the
// restore after a crash carry it. A text call on the live model, in the idle slot above.
async function subtitle(line, target) {
  const lang = subtitleLanguage(line.text, settings.subtitles);
  if (!lang || line.sub?.lang === lang || !(await whenIdle())) return;
  let out = '';
  for await (const t of streamChat(buildSubtitlePrompt(line.text, lang), { temperature: 0, maxTokens: 300, signal: AbortSignal.timeout(30_000) }, conf('live'))) out += t;
  const text = cleanSubtitle(out, line.text, lang);
  if (!text) return;
  line.sub = { lang, text };
  if (target !== meeting) return;
  const li = trList.children[target.transcript.indexOf(line)];
  if (li) { $('.sub', li)?.remove(); li.insertAdjacentHTML('beforeend', subHtml(line)); }
  saveLive();
}

function addFixes(line, fixes, target) {
  if (!fixes.length) return;
  line.raw ??= line.text;
  line.fixes = [...(line.fixes || []), ...fixes];
  line.text = applyFixes(line.raw, line.fixes).map((p) => p.text).join('');
  if (target !== meeting) return;
  const li = trList.children[target.transcript.indexOf(line)];
  if (li) $('p', li).innerHTML = lineText(line);
  saveLive();
  if (!answers.length) renderPip();
  if (line === meeting.transcript.at(-1)) renderCaption();
}

function enqueue(job) {
  pending++;
  renderBusy();
  queue = queue.then(job)
    .catch(onTranscribeError)
    .finally(() => { pending--; renderBusy(); });
}

// One toast for the first failure, then a single banner instead of a toast every chunk.
function onTranscribeError(e) {
  failures++;
  if (failures === 1) toast(`Transcription failed: ${e.message}`, 'error');
  if (failures === 2) {
    banner('transcribe', `Transcription is failing: ${e.message}`, 'bad', { action: { label: 'Settings', run: openSettings } });
    checkHealth();
  }
}

function stopStream(key) {
  flush(key);
  const tap = taps[key];
  if (tap) {
    tap.node.port.onmessage = null;
    tap.src.disconnect();
    tap.node.disconnect();
    delete taps[key];
  }
  if (key === 'mic') { mic?.getTracks().forEach((t) => t.stop()); mic = null; }
  else {
    display?.getTracks().forEach((t) => t.stop());
    display = null;
    shareApp?.stop();
    shareApp = null;
    trackSlides(false);
    desk?.shareStopped?.();
    $('#preview').srcObject = null;
    banner('noaudio');
    banner('quiet');
  }
  renderControls();
}

async function toggleShare() {
  if (display) return stopStream('meeting');
  if (!desk && !localStorage.getItem('maverick.seenShareTip')) return $('#dlg-share').showModal(); // the desktop app has no picker
  return startShare();
}

async function startShare() {
  try {
    // The Maverick tab itself cannot be picked; system audio is offered for Entire screen (the Teams app case).
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') return toast(permissionMessage(e, 'screen'), 'error');
    $('#denied-msg').textContent = permissionMessage(e, 'screen');
    $('.screen').dataset.state = 'denied';
    return;
  }
  delete $('.screen').dataset.state;
  banner('recover');
  $('#preview').srcObject = display;
  display.getVideoTracks()[0]?.addEventListener('ended', () => display && stopStream('meeting'));
  trackSlides(true);
  let audio = display.getAudioTracks();
  // A shared window is heard on its own: its app's sound replaces the system loopback main.cjs handed over.
  const app = desk ? await appAudioStream('shared') : { why: 'no-window' };
  if (app.stream && display) {
    audio.forEach((t) => t.stop());
    shareApp = app;
    audio = app.stream.getAudioTracks();
  } else {
    app.stop?.();
    if (app.why !== 'no-window') toast(appAudioFallback(app, 'Maverick hears'), 'warn');
  }
  if (!audio.length) {
    banner('noaudio', 'No audio was shared, so Maverick can see the screen but cannot hear the meeting. Share again and turn on “Share tab audio” (Teams in a tab) or “Share system audio” (entire screen).');
  } else {
    await attach('meeting', new MediaStream(audio));
  }
  startMeeting();
  renderControls();
}

async function toggleMic() {
  if (mic) return stopStream('mic');
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    if (e.name !== 'NotAllowedError') return toast(permissionMessage(e, 'mic'), 'error');
    return banner('mic', permissionMessage(e, 'mic'), 'bad', { action: { label: 'Try again', run: toggleMic } });
  }
  banner('mic');
  mic.getAudioTracks()[0]?.addEventListener('ended', () => mic && stopStream('mic'));
  await attach('mic', mic);
  startMeeting();
  renderControls();
  if (!localStorage.getItem('maverick.seenHeadphonesTip')) {
    store('maverick.seenHeadphonesTip', '1');
    toast('Tip: wear headphones, so your mic does not pick up the meeting from your speakers.');
  }
}

// ---------------------------------------------------------------- session recording (desktop app)
// Settings, Record meetings: Off, Audio only or Audio + screen, read when a meeting starts; End & summarize stops it.
// The sound is the meeting's own audio graph (the shared system audio and the mic, mixed in recDest), so nothing is
// captured twice. The picture is a capture of the screen or window picked in Settings. Each one-second chunk goes to
// main.cjs, which writes it to disk at once. The meeting keeps { file, mode, startedAt } for History's player.
// shortcut: a meeting restored after a crash keeps its first file and is not recorded again; parts per meeting are the upgrade.
let recorder = null;
let recStarting = false;
let recDest = null;
let recVideo = null;
let recApp = null; // the recorded window's app sound (appAudioStream), in place of the meeting tap
let recWrites = Promise.resolve();

async function startRecording(target) {
  if (!desk || recorder || recStarting) return;
  recStarting = true;
  let r = null;
  try {
    r = await desk.recStart();
    if (!r) return; // off
    if (r.error) return toast(`Recording did not start: ${r.error}.`, 'error');
    await audioGraph();
    recDest ??= ac.createMediaStreamDestination();
    if (r.mode === 'screen' && r.source.startsWith('window:')) {
      const app = await appAudioStream(r.source);
      if (app.node) {
        recApp = app;
        app.node.connect(recDest);
        try { taps.meeting?.src.disconnect(recDest); } catch { /* not connected */ }
      }
      else toast(appAudioFallback(app, 'the recording takes'), 'warn');
    }
    for (const [key, t] of Object.entries(taps)) if (!(recApp && key === 'meeting')) t.src.connect(recDest);
    const tracks = recDest.stream.getAudioTracks();
    if (r.mode === 'screen') {
      recVideo = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: r.source, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
      });
      tracks.unshift(...recVideo.getVideoTracks());
    }
    if (meeting !== target) throw new Error('the meeting ended before recording began');
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: r.mode === 'screen' ? 'video/webm;codecs=vp8,opus' : 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      recWrites = recWrites.then(async () => {
        const res = await desk.recChunk(new Uint8Array(await e.data.arrayBuffer()));
        if (res?.error && recorder === rec) failRecording(`Recording stopped: ${res.error}. What was recorded until then is saved.`);
      }).catch(() => {}); // one failed hand-over must not stop the chunks after it
    };
    rec.onerror = () => { if (recorder === rec) failRecording('Recording stopped because of an error. What was recorded until then is saved.'); };
    rec.onstart = () => { rec.t0 = Date.now(); target.recording.startedAt = rec.t0; saveLive(); };
    recVideo?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (recorder !== rec) return;
      stopRecording();
      toast('The recorded window was closed, so recording stopped. What was recorded until then is saved.', 'warn');
    });
    target.recording = { file: r.file, mode: r.mode, startedAt: Date.now() };
    rec.meeting = target;
    rec.start(1000);
    recorder = rec;
    saveLive();
  } catch (e) {
    if (r?.file) desk.recStop(0);
    recVideo?.getTracks().forEach((t) => t.stop());
    recVideo = null;
    stopRecApp();
    toast(`Recording did not start: ${e.message}`, 'error');
  } finally {
    recStarting = false;
  }
}

// Stops the recorder; resolves once its last chunk is on disk and the file has its length.
function stopRecording() {
  const rec = recorder;
  if (!rec) return Promise.resolve();
  recorder = null;
  const done = new Promise((resolve) => {
    // no file: nothing was recorded and main.cjs removed the empty file, so History offers no player
    const close = () => { recWrites = recWrites.then(() => desk.recStop(Date.now() - (rec.t0 ?? Date.now()))).then((res) => { if (!res?.file) delete rec.meeting.recording; }).catch(() => {}).then(resolve); };
    if (rec.state === 'inactive') return close();
    rec.onstop = close; // after the last dataavailable, so its write is queued first
    rec.stop();
  });
  recVideo?.getTracks().forEach((t) => t.stop());
  recVideo = null;
  stopRecApp();
  return done;
}

// The meeting tap goes back into recDest at the next recording (startRecording connects every tap).
function stopRecApp() {
  if (!recApp) return;
  recApp.stop();
  recApp = null;
}

// A write failed (disk full, folder gone): main.cjs has closed the file; the meeting goes on without recording.
function failRecording(msg) {
  const rec = recorder;
  recorder = null;
  rec.ondataavailable = null;
  if (rec.state !== 'inactive') rec.stop();
  recVideo?.getTracks().forEach((t) => t.stop());
  recVideo = null;
  stopRecApp();
  desk.recStop(0);
  toast(msg, 'error');
}

function grabFrame() {
  const v = $('#preview');
  if (!display || !v.videoWidth || view.stale) return null;
  const scale = Math.min(1, 1280 / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
}

// ---------------------------------------------------------------- slide tracking and screen reads
// While the meeting screen is shared, a small copy of the picture is hashed every SLIDE_MS (copilot.mjs, dHash and
// slideStep: two frames in a row must agree, so a flicker never counts). Each new screen is read once by the local
// vision model, in the idle slot like the subtitles, and kept in the meeting as { t, hash, text } at the time it appeared.
// Answer, Ask, Follow-ups, Recap, the notes and History use the reads; a line that points at the screen ("this number")
// is linked to the read that was up when it was said (addLine).
const SLIDE_MS = 700;
const HASH_W = 192;
const HASH_H = 108;
let slides = SLIDE_START;
let slideTimer = null;
let screenReads = Promise.resolve();
const readDone = new WeakMap(); // screen entry -> promise of its read
let readFailed = false;
const hashCanvas = Object.assign(document.createElement('canvas'), { width: HASH_W, height: HASH_H });

function sampleSlide() {
  const v = $('#preview');
  if (!display || !meeting || !v.videoWidth || view.stale) return; // a stale picture (or a minimized window's blank one) is no new slide
  const ctx = hashCanvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, 0, 0, HASH_W, HASH_H);
  const before = slides;
  const { state, change } = slideStep(slides, dHash(ctx.getImageData(0, 0, HASH_W, HASH_H).data, HASH_W, HASH_H), Date.now());
  slides = state;
  // asked again first: minimizing the window brings one blank frame at once, before the next timed check. Stale now:
  // the change is not kept, so a still slide is confirmed again once the window is seen (else it is never read).
  return change ? checkView().then(() => { if (view.stale) slides = before; else newScreen(change.t, change.hash); }) : null;
}
function trackSlides(on) {
  clearInterval(slideTimer);
  clearInterval(viewTimer);
  slideTimer = on ? setInterval(sampleSlide, SLIDE_MS) : null;
  viewTimer = on ? setInterval(checkView, VIEW_MS) : null;
  slides = SLIDE_START;
  setView('');
}

// A shared window that is covered, off screen or minimized stops being painted by its app (Chromium-based ones: Teams,
// Edge, Chrome), and the capture repeats its last picture, or a blank one, while the slides move on. Every VIEW_MS the
// desktop app says whether the window can be seen (main.cjs, shareView); a capture track muted by Chromium counts too.
// Covered is stale only while no new frame came since: an app that keeps painting under other windows is still seen.
// While stale: no slide samples or frames are taken, a banner (and the bar's alert line) says so, answers carry a note,
// and their prompt says the screen reads are from before. It clears by itself once the window shows again: its app
// paints, and the next frames reach the tracker (proved in test/screenread-proof.mjs).
const VIEW_MS = 2000;
let viewTimer = null;
let view = { stale: '', since: 0, coveredAt: -1 };
const viewFrames = () => display?.getVideoTracks()[0]?.stats?.totalFrames ?? -1;
async function checkView() {
  const track = display?.getVideoTracks()[0];
  if (!track) return;
  const r = desk?.shareView ? await desk.shareView().catch(() => null) : null;
  if (display?.getVideoTracks()[0] !== track) return; // the share stopped or restarted meanwhile
  if (r?.state !== 'covered') view.coveredAt = -1;
  else if (view.coveredAt < 0) view.coveredAt = viewFrames();
  const why = track.muted ? 'paused by Windows'
    : r?.state === 'minimized' ? 'minimized'
      : r?.state === 'covered' && viewFrames() === view.coveredAt ? 'covered by other windows or off screen' : '';
  setView(why, r?.name);
}
function setView(why, name = '') {
  if (why === view.stale) return;
  view = { ...view, stale: why, since: why ? Date.now() : 0 };
  banner('view', why ? `Maverick cannot see the latest picture of “${name || 'the shared window'}”: it is ${why}, so the capture still shows it as it was at ${new Date(view.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Bring the window back on screen and Maverick picks it up again.` : '');
}
const viewNote = () => (view.stale ? `The shared window is ${view.stale}, so this used the screen as it was before ${new Date(view.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '');

function newScreen(t, hash) {
  const target = meeting;
  const frame = grabFrame();
  if (!target || !frame) return null;
  const entry = { t, hash, text: '' };
  target.screens ??= [];
  target.screens.push(entry);
  saveLive();
  readDone.set(entry, screenReads = screenReads.then(() => readScreen(entry, frame, target)).catch(() => {}));
  return entry;
}

async function readScreen(entry, frame, target) {
  await whenIdle(); // after a minute of waiting it reads anyway: the frame was kept, the GPU only has to be free
  let out = '';
  try {
    for await (const t of streamChat([{ role: 'user', content: SCREEN_READ_PROMPT }], { images: [frame], temperature: 0, maxTokens: 700, signal: AbortSignal.timeout(180_000) }, conf('vision'))) out += t;
  } catch (e) {
    if (!readFailed) toast(`Maverick could not read the shared screen with the vision model: ${e.message}`, 'warn');
    readFailed = true;
    return;
  }
  readFailed = false;
  entry.text = out.trim() || 'blank screen';
  if (target === meeting) saveLive();
}

// The latest screen read, waited for (up to `ms`) when it is still being written. With nothing read yet, the screen
// is read now.
async function latestScreen(ms = 20_000) {
  if (!meeting || !display) return null;
  let entry = meeting.screens?.at(-1);
  if (!entry) { await sampleSlide(); entry = meeting?.screens?.at(-1); }
  if (!entry && slides.cand) { slides = { ...slides, hash: slides.cand, cand: '', n: 0 }; entry = newScreen(slides.candT, slides.hash); } // the first screen, not confirmed yet
  if (entry && !entry.text) await Promise.race([readDone.get(entry), sleep(ms)]);
  return entry;
}

// ---------------------------------------------------------------- smart assist
// One key (Ctrl+Shift+6, Alt 6 in the window) picks the action itself (copilot.mjs, routeAssist): a question from the
// other side not answered yet goes to Answer; a code or math problem on the shared screen to Solve; any other shared
// screen to Explain screen. The card says which it picked and why (the Smart tag), and a toast says it too.
async function smartAssist() {
  const lastAnswer = answers.find((c) => c.action === 'answer');
  const args = () => ({ transcript: meeting?.transcript ?? [], now: Date.now(), answeredAt: lastAnswer?.at ?? 0, screen: view.stale ? '' : meeting?.screens?.at(-1)?.text ?? '', sharing: !!display });
  let r = routeAssist(args());
  if (r.action !== 'answer' || !r.line) { await latestScreen(); r = routeAssist(args()); }
  toast(`Smart assist: ${ACTIONS[r.action]}, because ${r.why}.`);
  return runAction(r.action, r.line?.text.replace(/\[(?:overlap|unclear)\]\s*/gi, '').trim() ?? '', false, { route: r.why });
}

// ---------------------------------------------------------------- bytes sent off this PC
// providers.mjs counts every request that leaves this PC (countSend); during a meeting they add up in meeting.egress,
// shown in the header and kept in History. A meeting on local Ollama reads 0 bytes.
const fmtBytes = (n) => (n < 1000 ? `${n} byte${n === 1 ? '' : 's'}` : n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`);
egress.add((n) => {
  if (!meeting) return;
  meeting.egress = (meeting.egress || 0) + n;
  renderEgress();
  saveLive();
});
// The "Hidden" badge in the header and the bar: what main.cjs found in its last capture of the screen (desk.onShareCheck).
// "Hidden" only when a real capture did not contain the bar; a warning when it did, or hiding is off.
const SHARE_LOOK = { checking: ['i-shield', 'Checking', 'Checking'], hidden: ['i-shield-check', 'Hidden', 'Hidden'], visible: ['i-shield-alert', 'Visible in shares', 'Visible'], unknown: ['i-shield', 'Not checked', 'Not checked'] };
// The count stays off the header line (it ran under the model name): screen readers get #st-egress, everyone else the
// share badge's tooltip (desktop) or the AI pill's (browser).
const egressNote = () => (!meeting ? '' : meeting.egress
  ? `This meeting sent ${fmtBytes(meeting.egress)} to services outside this PC (a cloud provider or Web answers).`
  : 'Nothing from this meeting has left this PC.');
function renderEgress() {
  const el = $('#st-egress');
  el.hidden = !meeting;
  if (!meeting) return;
  $('span', el).textContent = `${fmtBytes(meeting.egress || 0)} sent off this PC`;
  if (desk) renderShare(); else $('#st-ai').dataset.tip = egressNote();
}

// ---------------------------------------------------------------- live meeting safety

let liveTimer = null;
function saveLive() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (!meeting) return;
    try { localStorage.setItem(LIVE_KEY, JSON.stringify(meeting)); } catch { /* full: the meeting still ends and saves normally */ }
  }, 1000);
}

function restoreLive() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch { /* corrupt */ }
  if (!saved?.transcript?.length) { localStorage.removeItem(LIVE_KEY); return; }
  const last = saved.transcript.at(-1).t;
  if (Date.now() - last < 3 * 3600_000) {
    meeting = { flags: [], answers: [], ...saved };
    renderTranscript();
    banner('recover', `Maverick reloaded. Your meeting is back with ${saved.transcript.length} lines. Share again to keep listening.`, 'warn',
      { action: { label: 'Share again', run: toggleShare } });
  } else {
    saved.endedAt = last;
    if (saveMeeting(saved)) toast('Saved an unfinished meeting to history.');
    localStorage.removeItem(LIVE_KEY);
  }
}

// In the desktop app a cancelled unload would block Quit; the live meeting is saved every second and comes back.
addEventListener('beforeunload', (e) => { if (!desk && (display || mic)) e.preventDefault(); });

// ---------------------------------------------------------------- transcript

const clock = (t, start = meeting?.startedAt ?? t) => elapsed(t - start);

// A changed word is never shown as what was said: it is underlined, and its title says what was heard and who changed it.
const FIX_NOTE = {
  fix: 'corrected by the live model',
  relisten: 'unclear in the audio; a guess from listening again with the conversation as context',
  deep: 'unclear in the audio; a guess by the deep model from the whole meeting',
};
const tokens = (html) => html.replace(/\[(unclear|overlap)\]/g, '<span class="tok">[$1]</span>');
function lineText(l) {
  const parts = l.fixes?.length ? applyFixes(l.raw, l.fixes) : [{ text: l.text }];
  return parts.map((p) => (p.from === undefined ? tokens(escapeHtml(p.text))
    : `<span class="fixed" data-tip="Heard: ${escapeHtml(p.from)}, ${FIX_NOTE[p.by] || FIX_NOTE.fix}">${escapeHtml(p.text)}<span class="vh"> (changed, heard: ${escapeHtml(p.from)})</span></span>`)).join('');
}

// Consecutive lines from the same speaker within a minute share one label. Meeting speakers can be renamed.
function lineHtml(l, prev) {
  const cont = prev?.who === l.who && Math.abs(l.t - prev.t) < 60_000;
  const who = l.spk ? `<span class="who" role="button" tabindex="0" data-spk="${escapeHtml(l.spk)}" data-tip="Rename this speaker">${escapeHtml(l.who)}</span>`
    : `<span class="who">${escapeHtml(l.who)}</span>`;
  return `<li class="line ${l.who === 'You' ? 'you' : 'meeting'}${cont ? ' cont' : ''}"><time>${clock(l.t)}</time>` +
    `${who}<p dir="auto">${lineText(l)}</p>${l.sub ? subHtml(l) : ''}</li>`;
}
// The subtitle sits under the line, smaller and quieter; the transcript hides them all while subtitles are off.
// The subtitle sits on the side its line reads from (the line's dir="auto" goes by its first strong letter).
const RTL_FIRST = /^[^A-Za-zÀ-ɏ؀-ۿ]*[؀-ۿ]/;
const subHtml = (l) => `<p class="sub${RTL_FIRST.test(l.text) ? ' rtl-src' : ''}" dir="auto" lang="${l.sub.lang === 'Arabic' ? 'ar' : 'en'}">${escapeHtml(l.sub.text)}</p>`;

// Follow the live edge until the user scrolls up; then count new lines on the jump chip.
const trList = $('#transcript');
let follow = true;
let unseen = 0;
let jumping = false;
const atLiveEdge = () => trList.scrollHeight - trList.scrollTop - trList.clientHeight < 24;

function renderJump() {
  const chip = $('#tr-jump');
  chip.hidden = follow;
  chip.querySelector('span').textContent = unseen ? `Jump to live, ${unseen} new` : 'Jump to live';
}

trList.addEventListener('scroll', () => {
  if (jumping) return;
  follow = atLiveEdge();
  if (follow) unseen = 0;
  renderJump();
});
trList.addEventListener('scrollend', () => { jumping = false; follow = atLiveEdge(); renderJump(); });
new ResizeObserver(() => { if (follow) trList.scrollTop = trList.scrollHeight; }).observe(trList);
$('#tr-jump').addEventListener('click', () => {
  follow = true;
  unseen = 0;
  jumping = !reduceMotion.matches;
  trList.scrollTo({ top: trList.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  renderJump();
  trList.focus({ preventScroll: true });
});

function addLine(who, text, t, target = meeting, extra = {}) {
  if (!target) { startMeeting(); target = meeting; }
  if (who === 'You' && isEcho(text, t, target.transcript)) {
    echoes++;
    if (echoes === 2) banner('echo', 'Your mic is picking up the meeting from your speakers, so those lines were skipped. Use headphones for a clean transcript.');
    return;
  }
  const line = { who, text, t, ...extra };
  // "as you can see, this number": the line means the screen that was up when it was said (copilot.mjs)
  if (isPointing(text)) { const s = screenAt(target.screens, t); if (s) line.screen = s.t; }
  const prev = target.transcript.at(-1);
  target.transcript.push(line);
  if (target !== meeting) return line; // a late line for a meeting that is being summarized
  trList.insertAdjacentHTML('beforeend', lineHtml(line, prev));
  if (meeting.flags?.length) markFlags();
  trList.classList.toggle('long', t - meeting.startedAt >= 3600_000);
  if (follow) trList.scrollTop = trList.scrollHeight;
  else { unseen++; renderJump(); }
  saveLive();
  renderControls();
  if (!answers.length) renderPip();
  if (who !== 'You' && isLikelyQuestion(text)) catchQuestion(line);
  return line;
}

// ---------------------------------------------------------------- live captions and questions from the other side

// The bar shows the latest transcript line under its row while Maverick listens.
function renderCaption() {
  if (!pip) return;
  const el = $('.mini-caption', pip.document);
  const l = (display || mic) ? meeting?.transcript.at(-1) : null;
  el.hidden = !l;
  el.innerHTML = l ? `<li class="${l.who === 'You' ? 'you' : ''}" dir="auto"><b>${escapeHtml(l.who)}</b> ${lineText(l)}</li>` : '';
}

// A question from the other side lands in the ask fields (the bar's and the main window's), never sent on its own:
// Enter answers it (wirePanel). A field the user is typing in is left alone; one still holding the last caught
// question is replaced.
function catchQuestion(line) {
  const q = line.text.replace(/\[(?:overlap|unclear)\]\s*/gi, '').trim();
  for (const d of docs()) {
    const input = $('form.ask input', d);
    if (!input || (input.value.trim() && input.value !== input.dataset.caught)) continue;
    input.value = q;
    input.dataset.caught = q;
  }
  announce(`Question caught in the ask field: ${q}. Press Enter in the field to answer it.`);
}
// The caught question still waiting, unchanged, in an ask field, taken out of the fields: the Answer button answers it too.
function takeCaught() {
  const fields = docs().map((d) => $('form.ask input', d)).filter((i) => i?.value.trim() && i.value === i.dataset.caught);
  const q = fields[0]?.value ?? '';
  for (const i of fields) { i.value = ''; delete i.dataset.caught; }
  return q;
}

// Click (or Enter on) a speaker label to rename that speaker for the whole meeting, past lines and new ones.
function renameSpeaker(spk, name) {
  const s = meeting?.speakers?.find((x) => x.id === spk);
  if (s) s.name = name;
  for (const l of meeting?.transcript ?? []) if (l.spk === spk) l.who = name;
  saveLive();
  renderTranscript();
}
function editSpeaker(label) {
  if (!label || !meeting) return;
  const old = label.textContent;
  const input = Object.assign(document.createElement('input'), { value: old, className: 'who-edit', maxLength: 40 });
  input.setAttribute('aria-label', `New name for ${old}`);
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== old) renameSpeaker(label.dataset.spk, name); else renderTranscript();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
trList.addEventListener('click', (e) => editSpeaker(e.target.closest('.who[data-spk]')));
trList.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.who[data-spk]')) { e.preventDefault(); editSpeaker(e.target); }
});

function renderTranscript() {
  const lines = meeting?.transcript ?? [];
  trList.innerHTML = lines.map((l, i) => lineHtml(l, lines[i - 1])).join('');
  trList.classList.toggle('long', !!meeting && (lines.at(-1)?.t ?? 0) - meeting.startedAt >= 3600_000);
  markFlags();
  follow = true;
  unseen = 0;
  renderJump();
}

// Subtitles: the header toggle switches them off, and back on to the mode they had (Auto when none).
const SUB_LABEL = { auto: 'Arabic lines in English, English lines in Arabic', English: 'every line in English', Arabic: 'every line in Arabic' };
let subsWere = 'auto';
function renderSubs() {
  const on = settings.subtitles !== 'off';
  if (on) subsWere = settings.subtitles;
  trList.classList.toggle('subs-off', !on);
  const b = $('#btn-subs');
  b.setAttribute('aria-pressed', String(on));
  b.dataset.tip = on ? `Subtitles on: ${SUB_LABEL[settings.subtitles]}. Click to hide them.` : 'Subtitles off. Click to show a translation under each line.';
}
function toggleSubs() {
  const next = settings.subtitles === 'off' ? subsWere : 'off';
  if (!storeSettings({ ...settings, subtitles: next })) return;
  settings = loadSettings();
  renderSubs();
}

function renderBusy() {
  const parts = [warming ? `Reloading ${warming}` : active?.deepLocal ? 'Deep model running, new lines wait for the GPU' : '', pending ? `Transcribing${pending > 1 ? `, ${pending} waiting` : ''}` : '', skipped ? `fell behind, skipped audio ${skipped} time${skipped > 1 ? 's' : ''}` : ''];
  $('#tr-status').textContent = parts.filter(Boolean).join(', ');
  $('#tr-status').classList.toggle('busy', !!(pending || warming));
}

// Flag a moment: the line being spoken then (prompts.mjs, flagLine) gets a marker and the notes get a "Flagged moments"
// section. The words at the press are often still being transcribed, so the markers are placed again as lines arrive.
function markFlags() {
  for (const li of $$('.flagged', trList)) { li.classList.remove('flagged'); $('.flag-mark', li)?.remove(); }
  for (const t of meeting?.flags ?? []) {
    const li = trList.children[flagLine(meeting.transcript, t)];
    if (!li || li.classList.contains('flagged')) continue;
    li.classList.add('flagged');
    $('time', li).insertAdjacentHTML('beforeend', '<svg class="i flag-mark" role="img" aria-label="Flagged"><use href="#i-flag"/></svg>');
  }
}

function flagMoment() {
  if (!meeting) return toast('Start a meeting first, then flag moments in it.', 'warn');
  const t = Date.now();
  meeting.flags.push(t);
  markFlags();
  saveLive();
  toast(`Flagged ${clock(t)}. It will be in the meeting notes.`);
}

// Matches by seconds, so "2:30" from a model finds the "02:30" line; the nearest line within 30 s wins.
const secs = (s) => s.split(':').reduce((a, n) => a * 60 + Number(n), 0);
function jumpToTime(stamp) {
  // Solve and Explain cite screen reads: a citation of one shows that read, not the nearest transcript line (acceptance 2, F)
  const off = (x) => Math.abs((x.t - meeting.startedAt) / 1000 - secs(stamp));
  const screen = meeting?.screens?.filter((s) => s.text?.trim() && off(s) <= 3).sort((a, b) => off(a) - off(b))[0];
  if (screen && !meeting.transcript.some((l) => off(l) < off(screen))) {
    return toast(`Screen at ${elapsed(screen.t - meeting.startedAt)}: ${screen.text.trim().replace(/\s*\n+\s*/g, ' / ').slice(0, 300)}`);
  }
  let li = null;
  let best = 31;
  for (const l of trList.children) {
    const d = Math.abs(secs($('time', l).textContent) - secs(stamp));
    if (d < best) { best = d; li = l; }
  }
  if (!li) return toast(`No transcript line near ${stamp}.`, 'warn');
  follow = false;
  renderJump();
  li.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  li.classList.remove('hit');
  void li.offsetWidth; // restart the highlight animation
  li.classList.add('hit');
}

// ---------------------------------------------------------------- copilot

const CATCH_UP = new Set(['answer', 'ask', 'followup', 'recap']);
// Answer, Follow-ups and Recap work from the transcript only; with nothing heard yet they are switched off rather
// than asked to answer from nothing (the model must not invent the meeting).
const FROM_TRANSCRIPT = new Set(['answer', 'followup', 'recap']);
const SEES_SCREEN = new Set(['explain', 'solve']); // the Vision role answers these
// Listening is not enough: until the first line is transcribed there is nothing to work from.
const hasTranscript = () => !!meeting?.transcript.length;

async function runAction(action, question = '', deep = false, extra = {}) {
  if (action === 'ask' && !question.trim()) return;
  if ((action === 'explain' || action === 'solve') && !display) return toast('Share the meeting screen first so Maverick can see it.', 'warn');
  if (FROM_TRANSCRIPT.has(action) && !hasTranscript()) return toast('Nothing to work from yet. Share the meeting or turn on the mic first.', 'warn');
  if (action === 'answer' && !question.trim()) question = takeCaught(); // the same answer as Enter in the field gives
  // Sources: Recap and the notes always work from the meeting. Web has no deep model (Claude Code answers).
  const source = SOURCE_ACTIONS.has(action) ? settings.sources : 'meeting';
  const dc = deep && source !== 'web' ? deepConf() : null;
  if (deep && !dc) return;
  active?.ctrl.abort();
  const card = {
    id: ++seq, action, label: ACTIONS[action], question: action === 'ask' || action === 'answer' ? question.trim() : '', text: '', raw: '', error: '', note: '',
    start: meeting?.startedAt ?? null, // its time is shown as meeting time, like the transcript and the citations
    streaming: true, stopped: false, catching: CATCH_UP.has(action) && Object.keys(taps).length > 0, at: Date.now(), ctrl: new AbortController(),
    deep: dc?.model || '', deepLocal: dc?.id === 'ollama',
    source, chunks: [], notFound: null, phase: '',
    route: extra.route || '', // smart assist: why it picked this action
    earlier: EARLIER_ACTIONS.has(action) ? earlierMeetings(loadMeetings(), meeting?.id) : [], // E1, E2, E3 in its prompt (copilot.mjs)
    firstAt: 0, // when the first word arrived: the speed meter is firstAt - at, from the key press
  };
  active = card;
  answers.unshift(card);
  answers.length = Math.min(answers.length, 30);
  try {
    // inside the try: a throw here must still end the card (as an error) and clear `active`, so Stop and the next press work
    renderAnswers();
    renderBusy();
    // The question someone just asked is still in the audio buffers: transcribe it before answering.
    if (card.catching) {
      flushAll();
      const stopped = new Promise((r) => card.ctrl.signal.addEventListener('abort', r, { once: true }));
      await Promise.race([queue, sleep(CATCH_UP_MS), stopped]);
      card.catching = false;
      scheduleCard(card);
    }
    if (card.ctrl.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    // Explain and Solve read the screen with the Vision model; Solve from Web or My material reads it there first (sourcePrompt)
    const live = conf(SEES_SCREEN.has(action) && card.source === 'meeting' ? 'vision' : 'live');
    const frame = grabFrame();
    const shown = [live, dc].every((c) => !c || c.sees) ? frame : null; // a model that cannot read images gets none
    const transcript = meeting?.transcript ?? [];
    const since = action === 'recap' || action === 'followup' ? coveredSince(transcript, meeting?.startedAt) : null;
    if (since) card.note = `Covers the last ${Math.max(1, Math.round((Date.now() - since) / 60000))} minutes.`;
    if (view.stale) card.note = [card.note, viewNote()].filter(Boolean).join(' ');
    const sourced = card.source === 'meeting' ? null : await sourcePrompt(card, question, frame, transcript);
    if (card.notFound) return;
    const messages = sourced?.messages ?? buildPrompt(action, { transcript, question, hasImage: !!shown, startedAt: meeting?.startedAt, answerLang: settings.answerLang, ...context() });
    if (window.maverickTest) window.maverickTest.lastPrompt = messages;
    const opts = sourced?.opts ?? { images: shown ? [shown] : [] };
    const ask = (c, signal = card.ctrl.signal) => streamChat(messages, { ...opts, signal }, sourced?.conf ?? c);
    // card.raw is what the model wrote, card.text what is shown: its reasoning is never shown (prompts.mjs, stripThinking)
    const add = (t) => { card.raw += t; card.text = dropPlaceholders(stripThinking(card.raw)); if (card.text) card.firstAt ||= Date.now(); scheduleCard(card); };
    const answered = () => { if (!card.text && card.raw.trim()) throw new Error('it wrote only its reasoning, no answer'); };
    try {
      for await (const t of dc ? firstTokenWithin(DEEP_START_MS, (s) => ask(dc, s), card.ctrl.signal) : ask(live)) add(t);
      answered();
    } catch (e) {
      // The deep model failed before writing anything (out of memory, most often): answer with the live model and say so.
      if (!dc || card.text || e.name === 'AbortError') throw e;
      const msg = `The deep model (${dc.model}) failed: ${e.message.slice(0, 160)}. Answered with ${live.model || live.name} instead.`;
      toast(msg, 'warn');
      card.note = [card.note, msg].filter(Boolean).join(' ');
      card.deep = '';
      card.deepLocal = false;
      scheduleCard(card);
      card.raw = '';
      for await (const t of ask(live)) add(t);
      answered();
    }
  } catch (e) {
    if (e.name === 'AbortError') card.stopped = true; else { card.error = e.message; card.topUp = e.topUp ?? null; }
    if (/can[’']t reach/i.test(e.message)) checkHealth();
  } finally {
    card.streaming = false;
    card.catching = false;
    card.phase = '';
    card.text = fixMixedScript(card.text); // a word with Arabic and Latin letters glued together is a slip (prompts.mjs)
    if (card.source === 'material' && card.text && !card.error) groundCheck(card);
    if (active === card) active = null;
    if (dc?.id === 'ollama') rewarm(); else renderBusy();
    const said = card.notFound ? `Not in your material. ${missingLine(card.notFound.missing)}` : card.text;
    if (meeting && said) { meeting.answers.push({ label: card.label, question: card.question, text: said, at: card.at, ...(card.firstAt ? { ttfw: card.firstAt - card.at } : {}) }); saveLive(); }
    renderAnswers();
    announce(card.error ? `${card.label} failed. ${card.error}` : card.stopped ? `${card.label} stopped.`
      : `${card.label} ready. ${said.replace(/[*#`>[\]]/g, '').slice(0, 300)}`);
  }
}

// What every answer prompt carries besides the transcript: what the shared screen showed (read each time it changed),
// the notes of the last three meetings in History, and the style rules from Settings.
const context = () => ({
  prior: meeting?.answers?.at(-1)?.text || '', // the reply language follows this meeting's answers (prompts.mjs, replyLanguage)
  screens: [meeting ? screenReadsText(meeting.screens, meeting.transcript, meeting.startedAt) : '',
    view.stale ? `Maverick cannot see the shared screen right now (the window is ${view.stale}): what it shows now is unknown, so never present a screen read above as what is on the screen now.` : ''].filter(Boolean).join('\n'),
  earlier: earlierMeetingsText(loadMeetings(), meeting?.id),
  style: settings.style,
});

// A citation chip and the punctuation after it stay on one line, so a period never wraps onto a line of its own.
const glueCites = (html) => html.replace(/(<button type="button" class="cite\b[^>]*>[^<]*<\/button>)([.,;:!?\u061F)]+)/g, '<span class="cite-glue">$1$2</span>');

// A finished code block (Solve) gets a Copy button in its corner.
const codeCopy = (html, streaming) => (streaming ? html : html.replaceAll('<pre><code>', '<pre><button type="button" class="tool pre-copy" data-cmd="copypre" aria-label="Copy code" data-tip="Copy code"><svg class="i"><use href="#i-copy"/></svg></button><code>'));

// Error body: what failed and the ways out. When the message already names a command, it is not repeated.
function failHtml(msg, topUp = null) {
  if (isPublikTopUp(topUp)) { // a publik 402: its message plus one link, its top_up_url (providers.mjs, httpError)
    return `<div class="fail" role="alert"><svg class="i"><use href="#i-alert"/></svg><div>
    <p class="title">Maverick couldn’t get an answer</p><p class="msg">${escapeHtml(msg)}</p>
    <div class="acts"><button class="btn sm primary" data-cmd="topup" data-url="${escapeHtml(topUp)}"><span>Add publik balance</span></button></div></div></div>`;
  }
  const cmd = msg.match(/\b(ollama (?:serve|pull [\w.:/-]+)|node serve\.mjs)/)?.[1];
  const fix = cmd ? ''
    : /claude code/i.test(msg) ? '<p class="fix">Sources, Web answers through Claude Code on this PC. Fix it as above, or switch Sources back to Meeting.</p>'
    : /settings|api key|allowed list/i.test(msg) ? '<p class="fix">Open Settings, check this provider, then retry.</p>'
      : '<p class="fix">Check the provider in Settings, or retry in a moment.</p>';
  return `<div class="fail" role="alert"><svg class="i"><use href="#i-alert"/></svg><div>
    <p class="title">Maverick couldn’t get an answer</p><p class="msg">${escapeHtml(msg)}</p>${fix}
    <div class="acts"><button class="btn sm primary" data-cmd="regen"><svg class="i sm"><use href="#i-redo"/></svg><span>Retry</span></button>` +
    (cmd ? `<button class="btn sm" data-cmd="copycmd" data-text="${escapeHtml(cmd)}"><span>Copy command</span></button>` : '') +
    '<button class="btn sm" data-cmd="settings"><span>Settings</span></button></div></div></div>';
}

// My material only, when the files hold no answer: one fixed shape, never an answer from elsewhere.
const missingLine = (m) => {
  const s = String(m || '').trim().replace(/[.。]+$/, '');
  return !s ? 'Your files do not answer this.' : /^(missing|nothing|your|no )/i.test(s) ? `${s}.` : `Missing: ${s}.`;
};
// The card shows its question just above, so "Nothing in your files covers “the question”" is said without it.
const missingShown = (m) => missingLine(String(m || '').replace(/^Nothing in your files covers “[\s\S]*”$/, 'Nothing in your files covers this question'));
// Homework says Add a file once for the worksheet (sheetHtml), not on every question it could not draft: acts = false.
const notFoundHtml = (card, acts = true) => '<div class="not-found" role="status"><svg class="i"><use href="#i-book"/></svg><div>' +
  `<p class="title">Not in your material.</p><p class="msg">${escapeHtml(missingShown(card.notFound.missing))}</p>` +
  (acts ? '<div class="acts"><button class="btn sm" data-cmd="library"><svg class="i sm"><use href="#i-plus"/></svg><span>Add a file</span></button></div>' : '') + '</div></div>';

function cardBody(card) {
  if (card.error) return failHtml(card.error, card.topUp);
  if (card.notFound) return notFoundHtml(card);
  // a "NOT FOUND" reply is still arriving: it becomes the card above, so the raw line never shows
  if (card.streaming && card.source === 'material' && /^\W*not[ _]?f/i.test(card.text)) return '<div class="skel" aria-hidden="true"><i></i><i></i><i></i></div>';
  if (!card.text && card.streaming) {
    // Think harder: a slow model that may first have to load. One line of plain words and one progress bar; the
    // skeleton is only for the ordinary wait.
    const secs = Math.round((Date.now() - card.at) / 1000);
    if (!card.deep) return '<div class="skel" aria-hidden="true"><i></i><i></i><i></i></div>';
    return `<p class="deep-wait">Thinking harder takes about a minute.${card.deepLocal ? ' New transcript lines may wait until it is done, because it uses this computer’s graphics card.' : ''}</p>`
      + `<span class="deep-prog" role="progressbar" aria-valuemin="0" aria-valuemax="75" aria-valuenow="${Math.min(72, secs)}" aria-label="Thinking harder, ${secs} seconds" data-ms="${Date.now() - card.at}"><i></i></span>`;
  }
  const shown = card.streaming && card.source === 'material' ? missingLines(card.text) : card.text; // a raw NOT FOUND line never shows
  const html = renderMarkdown(card.streaming ? holdOpen(shown) : shown, { bidi: true });
  const cites = { here: hereFor(card), earlier: card.earlier };
  return codeCopy(glueCites(linkCites(card.source === 'material' ? sourceChips(html, card.chunks, lib.files) : card.source === 'web' ? urlChips(html) : html, cites)), card.streaming) + (card.stopped ? '<p class="stopped">Stopped.</p>' : '') +
    (card.note && !card.streaming ? `<p class="stopped">${escapeHtml(card.note)}</p>` : '');
}

// While its meeting runs, a card's [mm:ss] is a jump only to a moment of that meeting: a line or a screen read within 3 s.
// A time from an earlier meeting must not land on whatever line of this one is nearest (markdown.mjs, linkCites).
function hereFor(card) {
  const m = meeting && card.start === meeting.startedAt ? meeting : null;
  if (!m) return null;
  return (stamp) => [...m.transcript, ...(m.screens ?? [])].some((x) => Math.abs((x.t - m.startedAt) / 1000 - secs(stamp)) <= 3);
}

const deepModelName = () => deepConf()?.model || '';
const stateText = (card) => (card.catching ? 'Catching up' : card.phase || (card.text ? 'Writing' : '')
  || (card.deep ? `Thinking harder, ${Math.round((Date.now() - card.at) / 1000)} s` : 'Thinking'));
const SOURCE_TAG = { web: 'Web', material: 'My material' };

function cardHtml(card, latest) {
  // One time basis: meeting time (as in the transcript and the citations) while the card belongs to a meeting.
  const time = card.start ? elapsed(card.at - card.start) : new Date(card.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cls = ['answer', latest && 'latest', card.streaming && 'streaming', card.error && 'error'].filter(Boolean).join(' ');
  const tools = card.streaming
    ? '<button class="tool stop" data-cmd="stop" aria-keyshortcuts="Escape" data-tip="Stop (Esc)"><svg class="i"><use href="#i-stop"/></svg><span>Stop</span></button>'
    : card.error ? ''
      : (card.text ? '<button class="tool" data-cmd="copy" aria-label="Copy answer" data-tip="Copy"><svg class="i"><use href="#i-copy"/></svg></button>' : '') +
        '<button class="tool" data-cmd="regen" aria-label="Regenerate" data-tip="Regenerate"><svg class="i"><use href="#i-redo"/></svg></button>' +
        (latest && !card.deep && card.source !== 'web' && !card.notFound && deepModelName() ? `<button class="tool deep" data-cmd="deep" aria-label="Think harder" data-tip="Run this again with ${escapeHtml(deepModelName())}. Slower; loading it takes about 30 s."><svg class="i"><use href="#i-deep"/></svg><span>Think harder</span></button>` : '');
  // the speed meter: from the key press to the first word of the answer, next to the card's time (outside it: the time stays meeting time)
  const speed = card.firstAt ? `<span class="speed" data-tip="Time from the key press to the first word">· ${((card.firstAt - card.at) / 1000).toFixed(1)} s</span>` : '';
  const tip = [card.start && 'Meeting time', card.firstAt && `the first word came ${((card.firstAt - card.at) / 1000).toFixed(1)} s after the key press`].filter(Boolean).join(', ');
  const state = card.streaming ? `<span class="state">${stateText(card)}</span>` : `<time class="when"${tip ? ` data-tip="${tip.charAt(0).toUpperCase()}${tip.slice(1)}"` : ''}>${time}</time>${speed}`;
  return `<article class="${cls}" data-id="${card.id}" data-kind="${card.action}" aria-busy="${card.streaming}">
    <header class="answer-head"><span class="tag">${escapeHtml(card.label)}</span>${SOURCE_TAG[card.source] ? `<span class="tag deep">${SOURCE_TAG[card.source]}</span>` : ''}${card.deep ? `<span class="tag deep" data-tip="${escapeHtml(card.deep)}">Deep</span>` : ''}${card.route ? `<span class="tag deep route" data-tip="Smart assist picked ${escapeHtml(card.label)}: ${escapeHtml(card.route)}">Smart</span>` : ''}<span class="q">${escapeHtml(card.question)}</span>${state}<div class="tools">${tools}</div></header>
    <div class="md${card.streaming && card.text ? ' typing' : ''}">${cardBody(card)}</div></article>`;
}

// The Think harder fill is one long CSS animation; a negative delay equal to the time already waited makes
// every repaint continue it instead of restarting it (inline styles are blocked by the CSP, the CSSOM is not).
// The delay is set as important so it also wins over the reduced-motion rule, which keeps this one fill running.
function syncProg(root) {
  for (const bar of $$('.deep-prog', root)) bar.firstElementChild.style.setProperty('animation-delay', `-${Number(bar.dataset.ms) || 0}ms`, 'important');
}

// Re-render a box of answers, then put keyboard focus back on the same button of the same answer.
function keepFocus(box, html) {
  const focused = box.ownerDocument.activeElement;
  const inBox = box.contains(focused);
  const id = inBox ? focused.closest('.answer')?.dataset.id : null;
  const cmd = inBox ? focused.dataset.cmd : null;
  const scrolls = $$('.answer', box).map((a) => [a.dataset.id, $('.md', a).scrollTop]);
  box.innerHTML = html;
  syncProg(box);
  for (const [sid, top] of scrolls) { const md = $(`.answer[data-id="${sid}"] .md`, box); if (md) md.scrollTop = top; }
  if (!id) return;
  const card = $(`.answer[data-id="${id}"]`, box);
  if (!card) return; // the bar shows only the latest answer: focus was on one it no longer shows
  (cmd && $(`[data-cmd="${cmd}"]`, card) || $(':is(.tools, .fail) button', card))?.focus();
}

function renderAnswers() {
  if (answers.length) keepFocus($('#answers'), answers.map((c, i) => cardHtml(c, i === 0)).join(''));
  renderPip();
}

// Streaming repaint; a reader who stays at the end keeps following the new text.
function paintCard(doc, card) {
  for (const el of $$(`.answer[data-id="${card.id}"]`, doc)) {
    const md = $('.md', el);
    const atEnd = md.scrollHeight - md.scrollTop - md.clientHeight < 24;
    md.innerHTML = cardBody(card);
    syncProg(md);
    md.classList.toggle('typing', !!card.text);
    if (atEnd && card.streaming) md.scrollTop = md.scrollHeight;
    const st = $('.state', el);
    if (st) st.textContent = stateText(card);
  }
}

// One repaint per frame, per window, on that window's own frame clock. The main window gets no frames while Teams
// covers it, so painting the bar from the main window's frames would freeze the bar until the answer ended.
const queued = new Map(); // document -> the card to paint on its next frame
function scheduleCard(card) {
  for (const d of docs()) {
    const had = queued.has(d);
    queued.set(d, card);
    if (!had) d.defaultView.requestAnimationFrame(() => { const c = queued.get(d); queued.delete(d); paintCard(d, c); });
  }
}

// First run: a checklist that ticks itself instead of the plain empty state.
function renderChecklist() {
  if (!$('#first-run')) return; // the first answer replaced the empty states
  // until the first transcript line: then the meeting has started and the one empty state takes over
  const first = !hasHistory && !answers.length && !meeting?.transcript.length;
  $('#first-run').hidden = !first;
  $('#answers-empty').hidden = first;
  if (!first) return;
  const steps = { ai: aiReady, share: !!taps.meeting, mic: !!mic };
  for (const [step, done] of Object.entries(steps)) $(`[data-step="${step}"]`).classList.toggle('done', done);
  $('#fr-ai').textContent = aiReady ? `${shortName()} is ready.`
    : $('#st-ai').classList.contains('busy') ? 'Checking the assistant' : 'Not ready yet. See the message above.';
  renderPublikOffer();
}

// First run with Ollama out of reach and no connection the user added: offer publik API (desktop/publik.cjs, main.cjs).
// The disclosure is the module's, verbatim. Yes provisions in the main process, which keeps the key; the page gets the
// card: the balance line, the cost sentence verbatim, and the sign-in or add-credit link. No keeps the Ollama banner.
// A build without a publik app token (hasToken false) never offers it: provisioning could only fail.
function ownConns() { return settings.connections.some((c) => c.type !== 'ollama' && c.type !== 'claudecode'); }
async function renderPublikOffer() {
  const box = $('#fr-publik');
  let declined = false;
  try { declined = localStorage.getItem(PUBLIK_OFFER_KEY) === 'no'; } catch { /* storage blocked */ }
  if (desk?.publikInfo) publikInfo ||= await desk.publikInfo();
  const show = !!publikInfo?.hasToken && (!!publikCard || (ollamaDown && !ownConns() && !declined));
  box.hidden = !show;
  if (!show) return;
  const btn = (act, label, primary) => `<button type="button" class="btn sm${primary ? ' primary' : ''}" data-publik="${act}">${escapeHtml(label)}</button>`;
  if (publikCard?.error) {
    $('#fr-publik-text').textContent = publikCard.error;
    $('#fr-publik-acts').innerHTML = btn('settings', 'Use your own key', true);
  } else if (publikCard) {
    $('#fr-publik-text').innerHTML = [publikCard.balance, publikCard.cost_sentence].filter(Boolean).map((t) => `<span class="publik-line">${escapeHtml(t)}</span>`).join('<br>');
    const claimed = publikCard.claim_state === 'claimed';
    const link = claimed ? publikCard.add_credit_url : publikCard.claim_url;
    $('#fr-publik-acts').innerHTML = link ? btn(claimed ? 'credit' : 'claim', claimed ? 'Add a plan or pack' : 'Sign in with publik', true) : '';
  } else {
    $('#fr-publik-text').textContent = publikInfo.disclosure || '';
    $('#fr-publik-acts').innerHTML = btn('yes', 'Yes', true) + btn('no', 'No');
  }
}
$('#fr-publik').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-publik]');
  if (!b || b.disabled) return;
  const act = b.dataset.publik;
  if (act === 'no') {
    try { localStorage.setItem(PUBLIK_OFFER_KEY, 'no'); } catch { /* storage blocked: asked again next start */ }
    return renderPublikOffer();
  }
  if (act === 'settings') return openSettings();
  if (act === 'claim' || act === 'credit') {
    desk.publikOpen(act === 'claim' ? publikCard.claim_url : publikCard.add_credit_url);
    // back from the browser: ask again, so a linked computer's card says Add a plan or pack
    if (act === 'claim') window.addEventListener('focus', async () => { const c = await desk.publikProvision(); if (c && !c.error) { publikCard = c; renderPublikOffer(); } }, { once: true });
    return;
  }
  b.disabled = true;
  b.textContent = 'Setting up';
  publikCard = await desk.publikProvision();
  if (publikCard && !publikCard.error) usePublik();
  renderPublikOffer();
});
// Every role but Web moves to the publik connection (added once), with its tier. Saved like a Settings change.
function usePublik() {
  const conns = settings.connections.some((c) => c.id === 'publik') ? settings.connections : [...settings.connections, { id: 'publik', name: PROVIDERS.publik.label, type: 'publik' }];
  const roles = { ...settings.roles };
  for (const r of ['live', 'deep', 'vision', 'transcribe']) roles[r] = { conn: 'publik', model: PUBLIK_MODELS[r] };
  if (!storeSettings({ ...settings, connections: conns, roles })) return;
  settings = loadSettings();
  checkHealth();
}

// ---------------------------------------------------------------- pop-out

function wirePanel(root) {
  for (const b of $$('[data-action]', root)) b.addEventListener('click', () => runAction(b.dataset.action));
  const form = $('form.ask', root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.elements.q;
    const q = input.value;
    const caught = q.trim() && q === input.dataset.caught; // a question the other side asked: answer it for me
    input.value = '';
    delete input.dataset.caught;
    if (caught) runAction('answer', q); else runAction('ask', q);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === 'settings') return openSettings();
    if (cmd === 'copycmd') return copyText(b.dataset.text, b);
    if (cmd === 'copypre') return copyText(b.closest('pre')?.querySelector('code')?.innerText ?? '', b);
    if (cmd === 'cite') return jumpToTime(b.dataset.t);
    if (cmd === 'earlier') return openEarlier(b.dataset.m, b.dataset.t);
    if (cmd === 'mic') return toggleMic();
    if (cmd === 'end') return endMeeting();
    if (cmd === 'think') return thinkHarder();
    if (cmd === 'flag') return flagMoment();
    if (cmd === 'theme') return toggleTheme();
    if (cmd === 'alert-act') return banners.get(b.closest('.mini-alert').dataset.key)?.action?.run();
    if (cmd === 'src-menu') return toggleSourcePick(b);
    if (cmd === 'source') return setSource(b.dataset.source);
    if (cmd === 'library') return openLibraryDialog();
    if (cmd === 'url') return openUrl(b.dataset.url);
    if (cmd === 'topup') return openTopUp(b.dataset.url);
    const card = answers.find((c) => c.id === Number(b.closest('.answer')?.dataset.id));
    if (!card) return;
    if (cmd === 'stop') card.ctrl.abort();
    else if (cmd === 'copy') copyText(card.text, b);
    else if (cmd === 'regen') runAction(card.action, card.question, !!card.deep);
    else if (cmd === 'deep') runAction(card.action, card.question, true);
    else if (cmd === 'src') openViewer(card, b.dataset.file, Number(b.dataset.page), claimOf(b));
  });
}

function renderPip() {
  if (!pip) return;
  const card = answers[0];
  const recent = (meeting?.transcript ?? []).slice(-3);
  const mini = $('.mini', pip.document);
  const from = mini.offsetHeight;
  const opened = card && mini.dataset.card !== String(card.id);
  mini.dataset.card = card ? String(card.id) : '';
  keepFocus($('.mini-answer', pip.document), card
    ? cardHtml(card, true)
    : `<div class="mini-empty"><p>${firstRunKey()}</p>${recent.length
      ? `<ol class="mini-lines">${recent.map((l) => `<li class="${l.who === 'You' ? 'you' : ''}" dir="auto"><b>${escapeHtml(l.who)}</b> ${lineText(l)}</li>`).join('')}</ol>` : ''}</div>`);
  // A new answer: the bar's glass morphs open from its old height (bar.css, .morph).
  if (opened) {
    mini.style.setProperty('--from', `${from}px`);
    mini.classList.remove('morph');
    void mini.offsetWidth;
    mini.classList.add('morph');
  }
  renderRec();
}

// Mount the command bar into a window. For the real pop-out that is the Document PiP window;
// with #mini in the URL it is this tab, which previews the pop-out through the same code path.
function mountMini(win) {
  const d = win.document;
  if (win !== window) {
    const theme = document.documentElement.dataset.theme;
    if (theme) d.documentElement.dataset.theme = theme;
    const link = d.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('styles.css', location.href).href;
    d.head.append(link);
    d.title = 'Maverick';
    d.body.append($('#sprite').cloneNode(true));
    d.addEventListener('keydown', onKey);
  }
  d.body.classList.add('pip');
  d.body.append(d.importNode($('#tpl-mini').content, true));
  wirePanel($('.mini', d));
  if (win !== window) { showScrollbars(d); wireTips(d); }
  syncThemeUI();
  renderSources();
}

// Scrollbars show only while a list scrolls: .scrolling fades the thumb in (CSS), and it fades out 0.9 s after.
// The page itself scrolls on the document, whose class goes on <html>.
function showScrollbars(d) {
  d.addEventListener('scroll', (e) => {
    const el = e.target === d ? d.documentElement : e.target;
    if (!el.classList) return;
    el.classList.add('scrolling');
    clearTimeout(el.scrollIdle);
    el.scrollIdle = setTimeout(() => el.classList.remove('scrolling'), 900);
  }, { capture: true, passive: true });
}

async function popOut() {
  if (desk) return pip ? pip.focus() : openBar();
  if (!('documentPictureInPicture' in window)) {
    return toast('Pop-out needs desktop Chrome or Edge 116 or newer (Document Picture-in-Picture). Keep this tab visible instead.', 'error');
  }
  if (pip) return pip.focus();
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 400, height: 380 }); // the bar and a short answer; it can be resized
  } catch (e) {
    return toast(`Could not open the pop-out: ${e.message}`, 'error');
  }
  mountMini(pip);
  pip.addEventListener('pagehide', () => { pip = null; renderControls(); });
  renderControls();
  renderPip();
  renderMiniAlert();
}

// ---------------------------------------------------------------- end and history

// Parsed again only when History changed: every answer reads the earlier meetings, and History holds up to 4 MB, which
// took a synchronous JSON.parse on each key press. Callers never change the meetings they get.
let histMemo = { raw: null, list: [] };
function loadMeetings() {
  const raw = localStorage.getItem(HISTORY_KEY) || '[]';
  if (raw !== histMemo.raw) { try { histMemo = { raw, list: JSON.parse(raw) }; } catch { histMemo = { raw, list: [] }; } }
  return [...histMemo.list];
}

// Keeps history under the cap by dropping the oldest transcripts (notes stay). If the browser still
// refuses, the meeting is downloaded so it is never lost.
function saveMeeting(m) {
  const all = loadMeetings().filter((x) => x.id !== m.id);
  all.push(m);
  let { list, trimmed } = fitHistory(all, HISTORY_MAX_CHARS);
  for (;;) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      if (trimmed) toast(`History was full, so transcripts of the ${trimmed} oldest meetings were removed. Their notes are kept.`, 'warn');
      if (!hasHistory) navigator.storage?.persist?.().catch(() => {});
      hasHistory = true;
      return true;
    } catch {
      const size = JSON.stringify(list).length;
      ({ list, trimmed } = fitHistory(all, Math.floor(size * 0.8)));
      if (JSON.stringify(list).length >= size) break;
    }
  }
  download(m);
  toast('Browser storage is full, so this meeting was downloaded as a file instead of saved in history.', 'error');
  return false;
}

function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileBase = (m) => m.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'meeting';
const download = (m) => downloadText(`${fileBase(m)}.md`, meetingToMarkdown(m));
const downloadActions = (m) => downloadText(`${fileBase(m)}-action-items.md`, actionItemsMarkdown(m));

const SKELETON = '<div class="skel" aria-hidden="true"><i></i><i></i><i></i></div>';

// Stops the notes while they are written; the meeting is saved in History before they start.
const NOTES_STOP = '<p><button class="btn sm" data-cmd="stop"><svg class="i sm"><use href="#i-stop"/></svg><span>Stop</span></button></p>';
let notesCtrl = null;

// Streams into the notes dialog, one repaint per frame.
// What the notes keep of a model's output: never its reasoning (prompts.mjs, stripThinking). Reasoning and nothing else
// throws, so a deep model that did that gives way to the live model, as when it fails (endMeeting, deepFailed).
function notesText(raw) {
  const s = stripThinking(raw);
  if (!s.trim() && raw.trim()) throw new Error('it wrote only its reasoning, no notes');
  return s;
}

async function streamInto(el, stream) {
  let raw = '';
  let text = '';
  let queued = false;
  for await (const t of stream) {
    raw += t;
    text = stripThinking(raw);
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; if (notesCtrl) el.innerHTML = linkCites(renderMarkdown(text, { bidi: true })) + NOTES_STOP; }); }
  }
  text = fixMixedScript(notesText(raw));
  el.innerHTML = linkCites(renderMarkdown(text, { bidi: true }));
  return text;
}

// The live transcript is cleared when a meeting ends, so a citation in the notes shows its line in place.
$('#sum-body').addEventListener('click', (e) => {
  if (e.target.closest('[data-cmd=stop]')) return notesCtrl?.abort();
  const b = e.target.closest('.cite');
  if (!b) return;
  if (b.nextElementSibling?.matches('.cite-line')) return b.nextElementSibling.remove();
  const m = summaryMeeting || { transcript: [], startedAt: 0 };
  let best = null;
  for (const l of m.transcript) {
    const d = Math.abs((l.t - m.startedAt) / 1000 - secs(b.dataset.t));
    if (d <= 30 && (!best || d < best.d)) best = { d, l };
  }
  b.insertAdjacentHTML('afterend', `<span class="cite-line">${best ? `${escapeHtml(best.l.who)}: ${escapeHtml(best.l.text)}` : 'No transcript line near this time.'}</span>`);
});

async function endMeeting() {
  if (!meeting || ending) return;
  ending = true;
  if (display) stopStream('meeting');
  if (mic) stopStream('mic');
  const recorded = stopRecording();
  const m = meeting;
  meeting = null; // new lines and a second End cannot touch the meeting being summarized
  const count = (n) => { m.egress = (m.egress || 0) + n; }; // the last transcriptions and the notes still count for it
  egress.add(count);
  for (const k of ['recover', 'echo', 'quiet']) banner(k);
  renderControls();
  const body = $('#sum-body');
  summaryMeeting = m; // the buttons stay disabled until the notes are written; citations can show lines already
  for (const b of ['#sum-download', '#sum-copy', '#sum-actions']) $(b).disabled = true;
  $('#sum-title').textContent = m.title;
  body.innerHTML = `<p class="muted">Finishing the last transcription</p>${SKELETON}`;
  $('#dlg-summary').showModal();
  // Saved to History before any model work, so a model that hangs or fails never costs the meeting; saved again with
  // its last lines, then with its notes. null: nothing to save yet; false: storage full, it was downloaded instead.
  const keep = () => (m.transcript.length || m.recording ? saveMeeting(m) : null);
  m.endedAt = Date.now();
  let saved = keep();
  if (saved) { toast('Meeting saved to history.'); localStorage.removeItem(LIVE_KEY); }
  try {
    await queue;
    await recorded;
    await Promise.race([screenReads, sleep(90_000)]); // the last screen's read goes into the notes
    m.endedAt = Date.now();
    if (!m.transcript.length) {
      body.innerHTML = '<p>Nothing was transcribed in this meeting, so there is nothing to summarize.</p>';
      if (m.recording && keep()) toast('The recording is saved in History.'); // the file stays reachable from the app
      else if (saved) store(HISTORY_KEY, JSON.stringify(loadMeetings().filter((x) => x.id !== m.id))); // saved for a recording that never got a byte
      localStorage.removeItem(LIVE_KEY);
      return;
    }
    if (saved !== false && keep() && !saved) { saved = true; toast('Meeting saved to history.'); }
    let text = '';
    const dc = deepConf();
    const live = conf('live');
    const liveName = live.model || live.name;
    // The notes say when the live model wrote them in place of the deep model the user picked, and why.
    const want = settings.roles.deep;
    const wanted = want.model && !(want.conn === live.conn && want.model === live.model) ? want.model : '';
    let fellBack = !dc && wanted ? `Written with ${liveName}, because the deep model (${wanted}) is not installed.` : '';
    const ctrl = new AbortController();
    notesCtrl = ctrl;
    // The deep model must start writing within DEEP_START_MS; Stop ends either model.
    const run = (messages, opts, c) => (c.conn === dc?.conn && c.model === dc?.model ? firstTokenWithin(DEEP_START_MS, (signal) => streamChat(messages, { ...opts, signal }, c), ctrl.signal)
      : streamChat(messages, { ...opts, signal: ctrl.signal }, c));
    // The first request of a deep summary says the model is loading; later ones say what they write.
    let loadNote = dc?.id === 'ollama' && !(await isLoaded(dc)) ? `Thinking harder: loading the deep model (${escapeHtml(dc.model)}), about 30 s, then writing the notes, about 1 min` : '';
    const status = (msg) => { body.innerHTML = `<p class="muted">${loadNote || msg}</p>${SKELETON}${NOTES_STOP}`; loadNote = ''; };
    const write = async (c, by) => {
      const parts = splitTranscript(m.transcript);
      let partNotes = '';
      if (parts.length > 1) {
        const notes = [];
        for (const [i, part] of parts.entries()) {
          status(`Writing the notes${by}, part ${i + 1} of ${parts.length}`);
          let n = '';
          for await (const t of run(buildPartPrompt(part, i, parts.length, m.startedAt), {}, c)) n += t;
          notes.push(`### Part ${i + 1}\n${notesText(n).trim()}`);
        }
        partNotes = notes.join('\n\n');
      }
      status(`Writing the notes${by}`);
      return streamInto(body, run(buildPrompt('summary', { transcript: m.transcript, startedAt: m.startedAt, flags: m.flags, partNotes, answerLang: settings.answerLang, screens: screenReadsText(m.screens, m.transcript, m.startedAt) }), {}, c));
    };
    // The deep model failed (out of memory, not installed, did not start in time): the live model writes the notes.
    let deep = dc;
    const deepFailed = (e) => {
      if (e.name === 'AbortError') throw e;
      deep = null;
      loadNote = '';
      fellBack = `Written with ${liveName}, because the deep model (${dc.model}) failed: ${e.message.slice(0, 160).replace(/\.$/, '')}.`;
      toast(`The deep model (${dc.model}) failed: ${e.message.slice(0, 120)}. Writing the notes with ${liveName} instead.`, 'warn');
    };
    try {
      // The deep model fills [unclear] words still open, from the whole meeting, and stays loaded for the notes.
      await Promise.race([side, sleep(15_000)]);
      if (deep && m.transcript.some((l) => /\[unclear\]/.test(l.text))) {
        status(`Filling unclear words from the whole meeting with ${escapeHtml(dc.model)}`);
        try {
          let out = '';
          for await (const t of run(buildUnclearPrompt(m.transcript, m.startedAt), { temperature: 0, maxTokens: 800 }, { ...dc, keepAlive: '5m' })) out += t;
          for (const [n, fixes] of Object.entries(parseFills(notesText(out), m.transcript))) addFixes(m.transcript[n], fixes, m);
        } catch (e) { deepFailed(e); } // the transcript keeps its [unclear] spots, and the notes do not wait for it again
      }
      if (deep) { try { text = await write(deep, ` with ${escapeHtml(dc.model)}`); } catch (e) { deepFailed(e); } }
      if (!deep) text = await write(live, dc ? ` with ${escapeHtml(liveName)}, because the deep model failed` : '');
    } catch (e) {
      text = '';
      body.innerHTML = e.name === 'AbortError' ? '<p class="muted">Stopped. The meeting is saved in History without notes.</p>'
        : `<p class="err">Summary failed: ${escapeHtml(e.message)}. The transcript is still saved.</p>`;
    } finally { notesCtrl = null; }
    // Decisions and action items no transcript line backs are taken out (meetings.mjs, groundNotes), and the notes say so.
    if (text) {
      const g = groundNotes(text, m.transcript, m.startedAt);
      if (g.dropped.length) {
        // the count only: repeating an invented item would put it back in the notes
        text = `${g.text.trim()}\n\nMaverick removed ${g.dropped.length} decision${g.dropped.length > 1 ? 's or action items' : ' or action item'} that no transcript line backs.`;
      }
      text = withFlagSection(text, m); // written from the transcript (meetings.mjs)
      if (fellBack) text = `${fellBack}\n\n${text}`;
      body.innerHTML = linkCites(renderMarkdown(text, { bidi: true }));
    }
    m.summary = text;
    if (keep() && !saved) toast('Meeting saved to history.');
    localStorage.removeItem(LIVE_KEY); // saved, or downloaded as a file when storage is full
    if (desk) rememberMeeting(m).catch(memoryFailed); // its note in Memory; the sheet does not wait for it
    summaryMeeting = m;
    for (const b of ['#sum-download', '#sum-copy']) $(b).disabled = false;
    $('#sum-actions').disabled = !extractActionItems(text).length;
    announce('Meeting notes ready.');
    if (dc?.id === 'ollama') rewarm();
  } finally {
    egress.delete(count);
    ending = false;
    if (!meeting) renderTranscript();
    renderControls();
  }
}

let histSelected = null;
let histCache = [];
let histTimer = null;
function openHistory() {
  histCache = loadMeetings();
  const raw = localStorage.getItem(HISTORY_KEY) || '';
  $('#hist-usage').textContent = histCache.length ? `${histCache.length} meeting${histCache.length === 1 ? '' : 's'}, ${(raw.length / 1e6).toFixed(1)} MB of about 5 MB` : '';
  // opens on the newest meeting, unless one is already picked
  if (!histCache.some((m) => m.id === histSelected)) histSelected = histCache.reduce((a, m) => (!a || m.startedAt > a.startedAt ? m : a), null)?.id ?? null;
  renderHistory();
  $('#dlg-history').showModal();
  (histCache.length ? $('#hist-q') : $('#hist-title')).focus();
}

function renderHistory() {
  // No meetings at all: one empty state across the whole sheet instead of an empty list and an empty pane.
  $('.history').classList.toggle('none', !histCache.length);
  const list = searchMeetings(histCache, $('#hist-q').value);
  $('#hist-list').innerHTML = list.length
    ? list.map((m) => `<li><button data-id="${escapeHtml(m.id)}" aria-current="${m.id === histSelected}">
        <strong>${escapeHtml(m.title)}</strong>
        <small>${m.transcript.length} lines, ${Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000))} min</small></button></li>`).join('')
    : `<li class="muted small">${$('#hist-q').value ? 'No meetings match.' : 'No saved meetings yet. End a meeting to save it here.'}</li>`;
  const m = list.find((x) => x.id === histSelected);
  $('#hist-detail').innerHTML = m
    ? `<div class="hist-tools"><button class="btn" data-dl><svg class="i"><use href="#i-download"/></svg><span>Download .md</span></button>
       ${extractActionItems(m.summary).length ? '<button class="btn" data-actions><svg class="i"><use href="#i-check-list"/></svg><span>Action items</span></button>' : ''}
       <button class="btn danger" data-del><svg class="i"><use href="#i-trash"/></svg><span>Delete</span></button></div>${m.recording ? playerHtml(m.recording) : ''}${histBody(m)}`
    : '<p class="muted">Pick a meeting to read its notes and transcript.</p>';
  $('#hist-detail :is(video, audio)')?.addEventListener('error', (e) => {
    e.target.insertAdjacentHTML('afterend', `<p class="muted small">The recording could not be played. Was it moved or deleted? ${escapeHtml(m.recording.file)}</p>`);
  }, { once: true });
}

// The meeting's recording above its notes. A transcript time ("03:12 Speaker 1:") and a flagged moment become buttons
// that play the recording from there (the click handler below).
const recordingUrl = (file) => `recording?t=${encodeURIComponent(TOKEN)}&f=${encodeURIComponent(file)}`;
const playerHtml = (r) => (r.mode === 'screen'
  ? `<div class="screen has-video"><video controls preload="metadata" src="${escapeHtml(recordingUrl(r.file))}"></video></div>`
  : `<audio controls preload="metadata" src="${escapeHtml(recordingUrl(r.file))}"></audio>`);
// The notes, the answers and the transcript: a [mm:ss] citation becomes a chip that shows that moment of the transcript
// below (and plays the recording from there, when there is one); a [file p.N] label opens that file at that page.
const histBody = (m) => {
  const html = sourceChips(linkCites(renderMarkdown(meetingToMarkdown(m), { bidi: true })), [], lib.files); // Arabic lines read right to left
  return m.recording ? seekStamps(html) : html;
};
const seekStamps = (html) => html.replace(new RegExp(String.raw`<li><strong>(${TIME})(?=[\s<])`, 'g'),
  '<li><strong><button type="button" class="cite" data-t="$1" data-tip="Play the recording from here">$1</button>');

$('#hist-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) { histSelected = b.dataset.id; renderHistory(); $(`#hist-list button[data-id="${CSS.escape(histSelected)}"]`)?.focus(); }
});
$('#hist-detail').addEventListener('click', (e) => {
  const m = histCache.find((x) => x.id === histSelected);
  if (!m) return;
  const src = e.target.closest('.cite.src[data-file]');
  if (src) return openViewer(null, src.dataset.file, Number(src.dataset.page));
  const stamp = e.target.closest('.cite[data-t]');
  const player = $('#hist-detail :is(video, audio)');
  if (stamp && stamp.dataset.cmd === 'cite') histJump(stamp.dataset.t);
  if (stamp && player) {
    // transcript times count from the meeting's start, the recording from its own (a moment later)
    player.currentTime = Math.max(0, secs(stamp.dataset.t) - (m.recording.startedAt - m.startedAt) / 1000);
    player.play().catch(() => {});
    return;
  }
  if (e.target.closest('[data-dl]')) download(m);
  if (e.target.closest('[data-actions]')) downloadActions(m);
  // Delete asks twice in the page (a native confirm box is its own window, and screen shares would show it):
  // the first click turns the button into "Delete for good", the second deletes; it resets after 4 s.
  const del = e.target.closest('[data-del]');
  if (del && del.dataset.armed !== '1') {
    del.dataset.armed = '1';
    $('span', del).textContent = 'Delete for good';
    announce(`Press Delete again to delete ${m.title}. This cannot be undone.`);
    setTimeout(() => { if (del.isConnected) { del.dataset.armed = ''; $('span', del).textContent = 'Delete'; } }, 4000);
    return;
  }
  if (del) {
    histCache = histCache.filter((x) => x.id !== m.id);
    store(HISTORY_KEY, JSON.stringify(histCache));
    hasHistory = histCache.length > 0;
    histSelected = null;
    renderHistory();
    (histCache.length ? $('#hist-q') : $('#hist-title')).focus();
  }
});
// A citation of an earlier meeting in an answer: that meeting in History, at that moment of its transcript.
function openEarlier(id, stamp) {
  if (desk) desk.showMain(document.hasFocus());
  histSelected = id;
  openHistory();
  if (histCache.some((m) => m.id === id)) histJump(stamp); else toast('That meeting is no longer in History.', 'warn');
}

// ---------------------------------------------------------------- Memory (desktop app)

// The vault (desktop/main.cjs keeps it in <userData>/memory): a note for each finished meeting and each homework run,
// linked with [[Name]] to a page for each person, subject and decision in it (memory.mjs). The pages are appended to,
// never rewritten. The Memory sheet lists and searches the notes, shows one with clickable links and what links to it,
// draws the links as a graph, and answers a question from all notes the way My material only answers from the Library:
// ranked chunks, the grounded prompt, the citation check, and "Not in your notes" when they do not hold the answer.
let memNotes = [];
let memSel = null;
let memView = 'note'; // 'note' | 'graph' | 'ask'
let memAsk = null; // { question, text, notFound, error, chunks, streaming }
let memCtrl = null;
const memVecs = new Map(); // a chunk's text -> its embedding, so each chunk is embedded once a run
function memFind(name) { const k = noteKey(name); return memNotes.find((n) => n.key === k) ?? null; }
async function loadMemory() {
  memNotes = desk?.memoryList ? (await desk.memoryList()).map((n) => parseNote(n.name, n.text, n.mtime)).sort((a, b) => b.mtime - a.mtime) : [];
  return memNotes;
}
const memoryFailed = (e) => toast(`Memory could not save this note: ${e.message}`, 'warn');

// The notes (of one type) as chunks with their embeddings, for rankChunks (library.mjs).
async function memoryChunks(type = '') {
  await loadMemory();
  const chunks = noteChunks(memNotes.filter((n) => !type || n.type === type));
  const key = (c) => `${c.name}\n${c.text}`;
  const todo = chunks.filter((c) => !memVecs.has(key(c)));
  for (let i = 0; i < todo.length; i += 16) {
    const part = todo.slice(i, i + 16);
    const vecs = await libModels.embed(part.map((c) => EMBED_DOC(c.name, c.text)));
    part.forEach((c, k) => memVecs.set(key(c), Float32Array.from(vecs[k])));
  }
  return chunks.map((c) => ({ ...c, vec: memVecs.get(key(c)) }));
}

// People and subjects, from the model on this PC; with no local model, or when it fails, none (the caller has its own).
async function entitiesOf(text) {
  try {
    let out = '';
    for await (const t of streamChat(buildEntityPrompt(text), { temperature: 0, maxTokens: 300, signal: AbortSignal.timeout(90_000) }, localConf())) out += t;
    return parseEntities(stripThinking(out));
  } catch { return { people: [], subjects: [] }; }
}
// Each entity page gets a line for the note; a name that is already a meeting or homework note is not made a page.
async function linkEntities(source, date, ents) {
  for (const [type, names] of [['person', ents.people], ['subject', ents.subjects], ['decision', ents.decisions ?? []]]) {
    for (const name of names) {
      const n = memFind(name);
      if (n && n.type !== type) continue;
      const r = await desk.memoryWrite(name, entityLine(source, date), 'add', entityPage(name, type));
      if (r?.error) throw new Error(r.error);
    }
  }
}
async function refreshMemory() { await loadMemory(); if ($('#dlg-memory').open) renderMemory(); }

async function rememberMeeting(m) {
  if (!m.transcript.length) return;
  await loadMemory();
  const text = `${m.title}\n${m.summary || ''}\n${m.transcript.map((l) => `${l.who}: ${l.text}`).join('\n')}`;
  const ents = meetingEntities(m, await entitiesOf(text));
  const r = await desk.memoryWrite(noteName(m.title), meetingNote(m, ents), 'new');
  if (r?.error) throw new Error(r.error);
  await linkEntities(r.name, dateOf(m.startedAt), ents);
  await refreshMemory();
}
// One note per worksheet, written again after each run: its questions and drafts, linked to the meetings cited.
async function rememberHomework(ws) {
  await loadMemory();
  const uses = [...new Set(ws.items.flatMap((it) => (it.chunks ?? []).filter((c) => !c.fileId && memFind(c.name) && it.a?.includes(`[${c.name} p.`)).map((c) => memFind(c.name).name)))];
  const ai = await entitiesOf(ws.items.map((it) => `${it.q}\n${it.a || ''}`).join('\n\n'));
  const ents = { people: ai.people, subjects: ai.subjects };
  const date = dateOf(Date.now());
  const r = await desk.memoryWrite(noteName(`Homework ${ws.name.replace(/\.\w+$/, '')}`), homeworkNote(ws, ents, uses), 'put');
  if (r?.error) throw new Error(r.error);
  await linkEntities(r.name, date, ents);
  await refreshMemory();
}

async function openMemory(name = null) {
  if (desk) desk.showMain(document.hasFocus());
  try { await loadMemory(); } catch (e) { return toast(`Memory could not be opened: ${e.message}`, 'error'); }
  if (name) { memSel = memFind(name)?.name ?? memSel; memView = 'note'; }
  if (!memFind(memSel)) memSel = memNotes.find((n) => n.type === 'meeting' || n.type === 'homework')?.name ?? memNotes[0]?.name ?? null;
  renderMemory();
  if (!$('#dlg-memory').open) $('#dlg-memory').showModal();
}

const MEM_TYPES = { meeting: 'Meeting', homework: 'Homework', person: 'Person', subject: 'Subject', decision: 'Decision' };
function renderMemory() {
  const q = $('#mem-q').value.trim().toLowerCase();
  const list = q ? memNotes.filter((n) => n.name.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)) : memNotes;
  $('#mem-usage').textContent = memNotes.length ? `${memNotes.length} note${memNotes.length === 1 ? '' : 's'}` : '';
  $('#mem-list').innerHTML = list.length
    ? list.map((n) => `<li><button type="button" data-note="${escapeHtml(n.name)}" aria-current="${memView === 'note' && n.name === memSel}"><strong dir="auto">${escapeHtml(n.name)}</strong>` +
      `<small>${escapeHtml([MEM_TYPES[n.type] ?? 'Note', n.date].filter(Boolean).join(' · '))}</small></button></li>`).join('')
    : `<li class="muted small">${q ? 'No notes match.' : 'No notes yet. End a meeting or draft homework, and its note lands here.'}</li>`;
  for (const t of $$('[data-mem-tab]')) t.setAttribute('aria-selected', String(t.dataset.memTab === memView));
  $('#mem-detail').innerHTML = memView === 'graph' ? graphHtml() : memView === 'ask' && memAsk ? askHtml() : noteHtml(memFind(memSel));
}

function noteHtml(n) {
  if (!n) return '<div class="empty"><svg class="i glyph"><use href="#i-memory"/></svg><p><strong>Your memory is empty</strong></p><p>Each meeting you end and each homework you draft becomes a note here, linked to the people, subjects and decisions in it.</p></div>';
  const body = n.body.replace(/^\s*# .*\n/, ''); // the name is the heading above
  const back = backlinkIndex(memNotes).get(n.key) ?? [];
  return `<header class="hw-sheet-head"><h3 dir="auto">${escapeHtml(n.name)}</h3><p>${escapeHtml([MEM_TYPES[n.type] ?? 'Note', n.date, n.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · '))}</p></header>` +
    `<div class="md mem-body">${wikiHtml(renderMarkdown(body, { bidi: true }), memFind)}</div>` +
    `<section class="mem-back" aria-label="Linked from"><p class="section-title">Linked from</p>${back.length
      ? `<ul>${back.map((b) => `<li><button type="button" class="wikilink" data-note="${escapeHtml(b)}">${escapeHtml(b)}</button><small>${escapeHtml(MEM_TYPES[memFind(b)?.type] ?? '')}</small></li>`).join('')}</ul>`
      : '<p class="muted small">No note links here yet.</p>'}</section>`;
}

const GRAPH = { w: 680, h: 500 };
function graphHtml() {
  if (!memNotes.length) return noteHtml(null);
  const { nodes, edges } = graphOf(memNotes);
  const p = forceLayout(nodes.length, edges, GRAPH);
  const legend = Object.entries(MEM_TYPES).map(([t, label]) => `<span><i data-type="${t}"></i>${label}</span>`).join('');
  return `<div class="mem-legend">${legend}</div><svg class="mem-graph" viewBox="0 0 ${GRAPH.w} ${GRAPH.h}" role="group" aria-label="Graph of ${nodes.length} notes and ${edges.length} links">` +
    edges.map(([a, b]) => `<line class="g-edge" x1="${p[a].x.toFixed(1)}" y1="${p[a].y.toFixed(1)}" x2="${p[b].x.toFixed(1)}" y2="${p[b].y.toFixed(1)}"/>`).join('') +
    nodes.map((n, i) => `<g class="g-node" data-note="${escapeHtml(n.name)}" data-type="${escapeHtml(n.type)}" role="button" tabindex="0" aria-label="${escapeHtml(n.name)}, ${MEM_TYPES[n.type] ?? 'note'}" transform="translate(${p[i].x.toFixed(1)} ${p[i].y.toFixed(1)})">` +
      `<circle r="${(5 + 2 * Math.sqrt(n.degree)).toFixed(1)}"/><text y="${(-9 - 2 * Math.sqrt(n.degree)).toFixed(1)}" text-anchor="middle">${escapeHtml(n.name.length > 28 ? `${n.name.slice(0, 27)}…` : n.name)}</text></g>`).join('') +
    '</svg>';
}

function askBody() {
  const a = memAsk;
  if (a.error) return `<p class="err">Maverick couldn’t answer from your memory: ${escapeHtml(a.error)}</p>${topUpButton(a.topUp)}`;
  if (a.notFound) return `<div class="not-found" role="status"><svg class="i"><use href="#i-memory"/></svg><div><p class="title">Not in your notes.</p><p class="msg">${escapeHtml(a.notFound.missing)}</p></div></div>`;
  if (!a.text || (a.streaming && /^\W*not[ _]?f/i.test(a.text))) return SKELETON;
  return glueCites(memChips(renderMarkdown(a.streaming ? holdOpen(missingLines(a.text)) : a.text, { bidi: true }), memFind));
}
const askHtml = () => `<div class="answer latest mem-answer" aria-busy="${!!memAsk.streaming}"><header class="answer-head"><span class="tag">Ask Memory</span><span class="q" dir="auto">${escapeHtml(memAsk.question)}</span>` +
  `${memAsk.streaming ? '<span class="state">Searching your notes</span>' : ''}</header><div class="md">${askBody()}</div></div>`;

// Ask Memory: the question against every note, on this PC (localConf), like Homework's My material drafts.
async function askMemory(question) {
  memCtrl?.abort();
  const ctrl = memCtrl = new AbortController();
  const a = memAsk = { question, text: '', streaming: true, chunks: [] };
  memView = 'ask';
  renderMemory();
  let queued = false;
  const paint = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; if (memAsk === a && memView === 'ask') $('#mem-detail .md').innerHTML = askBody(); }); };
  try {
    const pool = await memoryChunks();
    if (!pool.length) { a.notFound = { missing: 'Your memory has no notes yet.' }; return; }
    const hits = rankChunks(question, Float32Array.from((await libModels.embed([EMBED_QUERY(question)]))[0]), pool);
    a.chunks = hits.map(({ vec, tokens, ...x }) => x);
    if (!enough(hits)) { a.notFound = { missing: 'Nothing in your notes covers this question.' }; return; }
    let raw = '';
    const messages = buildGroundedPrompt({ task: GROUNDED_TASKS.ask, question, chunks: hits, answerLang: settings.answerLang, style: settings.style });
    for await (const t of streamChat(messages, { temperature: 0.2, signal: ctrl.signal }, localConf())) {
      raw += t;
      a.text = dropPlaceholders(stripThinking(raw));
      paint();
    }
    const g = checkGrounded(fixMixedScript(a.text), hits, question); // every citation must be a note it was given
    if (g.notFound) a.notFound = { missing: g.notFound.missing.replace(/^Nothing in your files/, 'Nothing in your notes') };
    else a.text = g.text;
  } catch (e) {
    if (e.name !== 'AbortError') { a.error = e.message; a.topUp = e.topUp ?? null; }
  } finally {
    a.streaming = false;
    if (memCtrl === ctrl) memCtrl = null;
    if (memAsk === a && $('#dlg-memory').open) renderMemory();
  }
}

$('#mem-q').addEventListener('input', renderMemory);
$('#mem-ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#mem-ask-q').value.trim();
  if (q) askMemory(q);
});
$('#dlg-memory').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-mem-tab]');
  if (tab) { memView = tab.dataset.memTab; return renderMemory(); }
  const b = e.target.closest('[data-note]');
  if (!b) return;
  memSel = memFind(b.dataset.note)?.name ?? memSel;
  memView = 'note';
  renderMemory();
  $('#mem-detail').scrollTop = 0;
});
$('#dlg-memory').addEventListener('keydown', (e) => {
  const g = e.target.closest?.('.g-node');
  if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); g.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
$('#dlg-memory').addEventListener('close', () => memCtrl?.abort());

// A citation in the notes shows its line in the transcript under them: the nearest line within 30 s, highlighted.
function histJump(stamp) {
  let li = null;
  let best = 31;
  for (const l of $$('#hist-detail li')) {
    const t = l.querySelector(':scope > strong')?.textContent.match(new RegExp(String.raw`^(${TIME})\s`))?.[1];
    const d = t ? Math.abs(secs(t) - secs(stamp)) : Infinity;
    if (d < best) { best = d; li = l; }
  }
  if (!li) return toast(`No transcript line near ${stamp}.`, 'warn');
  li.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  li.classList.remove('hit');
  void li.offsetWidth;
  li.classList.add('hit');
}
$('#hist-q').addEventListener('input', () => { clearTimeout(histTimer); histTimer = setTimeout(renderHistory, 150); });

// ---------------------------------------------------------------- settings dialog

const form = $('#settings-form');
// Each role's row: what it does, and its model field
const ROLE_ROWS = {
  live: ['Answer, Ask, Recap, Follow-ups, Smart assist and subtitles.', 'Live model'],
  deep: ['Think harder and the meeting notes. If it has not started writing within a minute, the live model takes over.', 'Reasoning model (blank = none)'],
  vision: ['Explain screen, Solve, the screen reads, and images and scans in the Library and Homework.', 'Vision model'],
  transcribe: ['Only connections that accept audio. It also fixes misheard words.', 'Transcription model'],
  web: ['Sources, Web. Only Claude Code searches the web.', 'Web model (blank = the CLI default)'],
};
const REVEAL = '<button type="button" class="btn sm icon ghost reveal" data-reveal aria-label="Show key" aria-pressed="false"><svg class="i sm"><use href="#i-eye"/></svg></button>';
let cliAllow = [];

// The connections as the form holds them, saved or not.
function readConns() {
  return $$('#provider-fields .prov').map((d) => {
    const { conn: id, type } = d.dataset;
    const val = (k) => form.elements[`${id}.${k}`].value.trim();
    return { id, name: val('name') || PROVIDERS[type].label, type, ...(type === 'openai' ? { preset: val('preset') } : {}), ...Object.fromEntries(connFields(type).map((f) => [f.key, val(f.key)])) };
  });
}
const formConn = (id) => readConns().find((c) => c.id === id) ?? null;
const readRoles = () => Object.fromEntries(Object.keys(ROLES).map((r) => [r, { conn: form.elements[`role.${r}`].value, model: form.elements[`role.${r}.model`].value.trim() }]));
// The connections the roles use; a Reasoning role with no model uses none.
const inUse = () => new Set(Object.entries(readRoles()).filter(([r, x]) => r !== 'deep' || x.model).map(([, x]) => x.conn));
const connBox = (id) => $(`#provider-fields .prov[data-conn="${CSS.escape(id)}"]`);

// One card per role: what it does, its connection and its model side by side. The model is typed, or picked from the
// models the connection has installed (Ollama lists them); the menu is an in-page list, like every Settings dropdown.
// data-name keeps the field's name for the "Not saved yet" line (formProblem): "Vision model: Enter a model name."
function buildSettingsForm() {
  $('#role-cards').innerHTML = Object.entries(ROLES).map(([r, x]) => `
    <div class="group role-card" data-role="${r}">
      <p class="role-head"><b>${escapeHtml(x.label)}</b><small>${escapeHtml(ROLE_ROWS[r][0])}</small></p>
      <div class="role-row">
        <label><span data-name="${escapeHtml(x.label)}">Connection</span><select name="role.${r}" aria-describedby="err-role.${r}"></select></label>
        <label><span data-name="${escapeHtml(ROLE_ROWS[r][1])}">Model${r === 'deep' || r === 'web' ? '<em> optional</em>' : ''}</span><span class="field model-pick"><input name="role.${r}.model" autocomplete="off" spellcheck="false" placeholder="${r === 'deep' ? 'None' : r === 'web' ? 'The CLI default' : ''}" aria-describedby="err-role.${r}.model"><select class="model-menu" data-model-menu="${r}" aria-label="Installed models for ${escapeHtml(x.label)}" hidden></select></span></label>
      </div>
      <small id="err-role.${r}" class="field-msg"></small><small id="err-role.${r}.model" class="field-msg"></small>
    </div>`).join('');
  // Help text under a row goes to the row's tooltip (hover the row, or focus its control); screen readers keep it in the label.
  for (const s of $$('#dlg-settings .group > label > small:not([id])')) { s.closest('label').dataset.tip = s.textContent; s.classList.add('vh'); }
  $('#conn-add').innerHTML = '<option value="">Choose a type</option>' + Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${escapeHtml(p.label)}</option>`).join('');
}

function connHtml(c) {
  const p = PROVIDERS[c.type];
  const id = escapeHtml(c.id);
  const row = (key, label, control) => `<label><span>${escapeHtml(label)}</span>${control}<small id="err-${id}.${key}" class="field-msg"></small></label>`;
  const input = (f) => `<span class="field${f.type === 'password' ? ' secret' : ''}"><input name="${id}.${f.key}" type="${f.type || 'text'}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(f.placeholder || f.value)}" aria-describedby="err-${id}.${f.key}">${f.type === 'password' ? REVEAL : ''}</span>`;
  return `
    <details class="prov" data-conn="${id}" data-type="${c.type}">
      <summary><span class="name">${escapeHtml(c.name)}</span><span class="roles"></span><i class="summary-dot" data-dot></i><svg class="i sm chev"><use href="#i-chev"/></svg></summary>
      <div class="prov-body">
        <p class="hint">${escapeHtml(p.note)}${c.type === 'openai' ? ' Key stays in this browser and goes straight to <span data-host></span>.' : ''}</p>
        ${c.type === 'cli' ? '<p class="hint allowed" data-cli-allowed>Loading the allowed commands</p>' : ''}
        ${c.type === 'publik' ? '<p class="hint" data-publik-setup></p>' : ''}
        ${row('name', 'Name', input({ key: 'name', value: p.label }))}
        ${c.type === 'openai' ? row('preset', 'Preset', `<select name="${id}.preset" aria-describedby="err-${id}.preset">${Object.entries(PRESETS).map(([k, x]) => `<option value="${k}">${escapeHtml(x.label)}</option>`).join('')}</select>`) : ''}
        ${connFields(c.type).map((f) => row(f.key, f.label, input(f))).join('')}
        <div class="prov-foot"><button type="button" class="btn sm" data-test="${id}">Test connection</button><span class="test-result" data-result="${id}" role="status"></span><button type="button" class="link danger" data-remove="${id}">Remove</button></div>
      </div>
    </details>`;
}
function fillConn(c) {
  for (const k of ['name', ...(c.type === 'openai' ? ['preset'] : []), ...connFields(c.type).map((f) => f.key)]) form.elements[`${c.id}.${k}`].value = c[k] ?? '';
  syncHost(c.id);
}
// OpenAI-compatible: the note names the host the key goes to
function syncHost(id) {
  const el = $('[data-host]', connBox(id));
  if (!el) return;
  try { el.textContent = new URL(form.elements[`${id}.baseUrl`].value.trim()).host; } catch { el.textContent = 'the server above'; }
}
// The role pickers list the connections by name; a role whose connection is gone shows None, which is an error.
function fillRoleSelects(values = Object.fromEntries(Object.keys(ROLES).map((r) => [r, form.elements[`role.${r}`].value]))) {
  const conns = readConns();
  for (const r of Object.keys(ROLES)) {
    const sel = form.elements[`role.${r}`];
    const has = conns.some((c) => c.id === values[r]);
    sel.innerHTML = conns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('') + (has ? '' : '<option value="">None</option>');
    sel.value = has ? values[r] : '';
    sel.dataset.last = sel.value;
  }
  for (const d of $$('#provider-fields .prov')) $('summary .name', d).textContent = form.elements[`${d.dataset.conn}.name`].value.trim() || PROVIDERS[d.dataset.type].label;
}

// Settings, a publik API connection: the balance once this computer is set up; before that the disclosure, verbatim, and
// a Yes that provisions in the main process (renderPublikOffer does the same on first run).
async function fillPublikSetup() {
  const notes = $$('[data-publik-setup]');
  if (!notes.length) return;
  const info = desk?.publikInfo ? await desk.publikInfo() : null;
  for (const n of notes) {
    if (!info) n.textContent = 'In a browser, the Maverick server uses PUBLIK_API_KEY or the credential file the desktop app saved.';
    else if (info.card) n.textContent = info.card.balance || 'This computer is set up for publik API.';
    else if (info.hasToken) n.innerHTML = `${escapeHtml(info.disclosure)} <button type="button" class="btn sm" data-publik-setup-yes>Yes, set it up</button>`;
    else n.textContent = 'This build cannot set up publik API. It works with PUBLIK_API_KEY set, or on a computer already set up for it.';
  }
}
form.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-publik-setup-yes]');
  if (!b || b.disabled) return;
  b.disabled = true;
  const c = await desk.publikProvision();
  if (c?.error) b.closest('[data-publik-setup]').textContent = c.error;
  else { publikCard = c; fillPublikSetup(); }
});

// The server keeps the CLI allowlist; the page only shows it.
async function loadCliAllow() {
  const notes = $$('[data-cli-allowed]');
  try {
    const res = await fetch('/bridge/allowed', { headers: { 'x-cue-token': TOKEN } });
    cliAllow = (await res.json()).cli;
    for (const n of notes) {
      n.innerHTML = `Allowed commands: ${cliAllow.map((c) => `<code>${escapeHtml(c)}</code>`).join(' ')}. ` +
        'Their arguments are set in <code>maverick.config.json</code> next to serve.mjs, where the model fills <code>{model}</code>. The page cannot change them.';
    }
  } catch {
    for (const n of notes) n.textContent = 'Could not load the allowed commands. Is “node serve.mjs” running?';
  }
}

function modelError(type, v, optional) {
  if (type === 'claudecode') return /^[\w.\-[\]]*$/.test(v) ? '' : 'Use letters, numbers, dots and dashes only.';
  if (type === 'cli') return /^(?:[A-Za-z0-9][\w.:-]{0,99})?$/.test(v) ? '' : 'Start with a letter or number; then letters, numbers, dots, colons and dashes.';
  return v || optional ? '' : 'Enter a model name.';
}

// Inline rules; the command and model patterns match what serve.mjs accepts. A role on a connection that cannot do it
// (no images for Vision, no audio for Transcription, no web search for Web) is an error, so Settings do not save.
function fieldError(name, value, forTest) {
  const v = value.trim();
  if (name === 'chunkSeconds') {
    const n = Number(v);
    return v && Number.isInteger(n) && n >= 4 && n <= 30 ? '' : 'Use a whole number from 4 to 30.';
  }
  const [id, key, sub] = name.split('.');
  if (id === 'hk') {
    if (/^(ctrl|control|commandorcontrol)\+enter$/i.test(v)) return 'Teams sends messages with Ctrl+Enter. Pick another key.';
    return !v || /^(?:(?:Ctrl|Control|CommandOrControl|Alt|Shift|Super)\+)+[^+\s]+$|^F\d{1,2}$/i.test(v) ? '' : 'Use modifiers and one key, like Ctrl+Shift+1.';
  }
  if (id === 'role') {
    const c = formConn(form.elements[`role.${key}`].value);
    if (!sub) return roleError(key, c);
    return c ? modelError(c.type, v, key === 'deep' || key === 'web') : '';
  }
  if (key === 'url' || key === 'baseUrl') return /^https?:\/\/[^\s/]+/i.test(v) ? '' : 'Enter a full URL that starts with http:// or https://.';
  const type = connBox(id)?.dataset.type;
  if (key === 'key' && !v && type !== 'openai' && (forTest || inUse().has(id))) return `Add an API key to use ${formConn(id)?.name || PROVIDERS[type]?.label}.`;
  if (key === 'command') {
    if (!/^[\w-]+$/.test(v)) return 'Enter a program name, like gemini or codex.';
    if (cliAllow.length && !cliAllow.includes(v.toLowerCase())) return `“${v}” is not on the allowed list. Add it to maverick.config.json first.`;
  }
  return '';
}

function validateField(input, forTest = false) {
  const msg = fieldError(input.name, input.value, forTest);
  input.setAttribute('aria-invalid', String(!!msg));
  document.getElementById(input.getAttribute('aria-describedby')).textContent = msg;
  return !msg;
}

const validateProvider = (id, forTest = false) =>
  $$('input', connBox(id)).map((i) => validateField(i, forTest)).every(Boolean);
const validateRoles = () => $$('[name^="role."]', form).map((i) => validateField(i)).every(Boolean);

// Each connection's summary names the roles that use it.
function syncProviders() {
  const roles = readRoles();
  for (const d of $$('#provider-fields .prov')) {
    $('.roles', d).innerHTML = Object.entries(roles).filter(([r, x]) => x.conn === d.dataset.conn && (r !== 'deep' || x.model))
      .map(([r]) => `<span class="badge">${escapeHtml(ROLES[r].label)}</span>`).join('');
  }
}

// A tiny real request with the values in the form, saved or not: time to the first streamed text. The model is the
// first role's on this connection, or the type's usual one.
async function testProvider(id, btn) {
  if (btn.dataset.busy) return;
  const out = $('[data-result]', connBox(id));
  const dot = $('[data-dot]', connBox(id));
  const done = (cls, html) => { out.className = `test-result ${cls}`; out.innerHTML = html; dot.className = `summary-dot ${cls}`; };
  if (!validateProvider(id, true)) return done('fail', 'Fix the fields above first.');
  const { id: _, type, preset, ...fields } = formConn(id);
  const model = Object.values(readRoles()).find((x) => x.conn === id && x.model)?.model ?? PROVIDERS[type].fields.find((f) => f.key === 'model').value;
  const c = { ...fields, id: type, model, token: TOKEN };
  btn.dataset.busy = '1';
  out.className = 'test-result busy';
  out.textContent = 'Testing';
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TEST_TIMEOUT_MS);
  const t0 = performance.now();
  const ms = () => `<b>${Math.round(performance.now() - t0)} ms</b>`;
  try {
    let got = false;
    for await (const _ of streamChat([{ role: 'user', content: 'Reply with the single word OK.' }], { signal: ctrl.signal }, c)) { got = true; break; }
    done('ok', got ? `Connected, first reply in ${ms()}` : `Connected in ${ms()}, but the model sent no text`);
  } catch (e) {
    done('fail', timedOut ? `No reply within ${TEST_TIMEOUT_MS / 1000} s.` : `Failed after ${ms()}: ${escapeHtml(e.message)}`);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    delete btn.dataset.busy;
  }
}

function openSettings() {
  $('#provider-fields').innerHTML = settings.connections.map(connHtml).join('');
  for (const c of settings.connections) fillConn(c);
  fillRoleSelects(Object.fromEntries(Object.entries(settings.roles).map(([r, x]) => [r, x.conn])));
  for (const [r, x] of Object.entries(settings.roles)) form.elements[`role.${r}.model`].value = x.model ?? '';
  form.elements.chunkSeconds.value = settings.chunkSeconds;
  form.elements.languages.value = settings.languages;
  form.elements.answerLang.value = settings.answerLang;
  form.elements.vocab.value = settings.vocab;
  form.elements.fixWords.checked = settings.fixWords;
  form.elements.subtitles.value = settings.subtitles;
  form.elements.fileVocab.checked = settings.fileVocab;
  form.elements.style.value = settings.style;
  renderFileVocab();
  for (const i of $$('input, select[name^="role."]', form)) { i.removeAttribute('aria-invalid'); document.getElementById(i.getAttribute('aria-describedby')).textContent = ''; }
  sayUnsaved('');
  syncProviders();
  const open = new Set(['live', 'deep', 'vision', 'transcribe'].filter((r) => r !== 'deep' || settings.roles.deep.model).map((r) => settings.roles[r].conn));
  for (const d of $$('#provider-fields .prov')) d.open = open.has(d.dataset.conn);
  loadCliAllow();
  fillPublikSetup();
  if (desk) fillDeskSettings();
  showPane('general');
  fillModelMenus();
  $('#dlg-settings').showModal();
}

// Settings sections: one pane at a time, picked in the sidebar (arrow keys move between the tabs).
function showPane(name) {
  for (const t of $$('[data-pane-tab]')) {
    const on = t.dataset.paneTab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('.set-pane')) p.hidden = p.dataset.pane !== name;
  $('#dlg-settings .set-body').scrollTop = 0;
}
$('.set-nav').addEventListener('click', (e) => { const t = e.target.closest('[data-pane-tab]'); if (t) showPane(t.dataset.paneTab); });
$('.set-nav').addEventListener('keydown', (e) => {
  const tabs = $$('[data-pane-tab]').filter((t) => !t.hidden);
  const i = tabs.indexOf(document.activeElement);
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (i < 0 || next === undefined) return;
  e.preventDefault();
  const t = tabs[(next + tabs.length) % tabs.length];
  showPane(t.dataset.paneTab);
  t.focus();
});
// The pane that holds a field, shown before the field takes focus (a save refused for a field on another pane).
const revealField = (el) => { const p = el?.closest('.set-pane'); if (p?.hidden) showPane(p.dataset.pane); return el; };

// The installed models of each role's connection, in the menu beside its model field. Ollama answers /api/tags; other
// connection types have no list, so their menu stays hidden and the name is typed.
const tagLists = new Map();
async function fillModelMenus() {
  for (const r of Object.keys(ROLES)) {
    const menu = $(`[data-model-menu="${r}"]`);
    const c = formConn(form.elements[`role.${r}`].value);
    const url = c?.type === 'ollama' && /^https?:\/\//i.test(c.url || '') ? c.url.replace(/\/+$/, '') : '';
    if (url && !tagLists.has(url)) {
      tagLists.set(url, fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) }).then(async (res) => (await res.json()).models.map((m) => m.name).sort()).catch(() => null));
    }
    const names = url ? await tagLists.get(url) : null;
    menu.hidden = !names?.length;
    menu.innerHTML = '<option value="">Installed models</option>' + (names ?? []).map((n) => `<option>${escapeHtml(n)}</option>`).join('');
    menu.value = '';
  }
}
// A model picked from the menu goes into the field, which saves and validates as if it were typed.
form.addEventListener('change', (e) => {
  const menu = e.target.closest?.('[data-model-menu]');
  if (!menu) return;
  e.stopImmediatePropagation();
  const input = form.elements[`role.${menu.dataset.modelMenu}.model`];
  if (menu.value) input.value = menu.value;
  menu.value = '';
  for (const t of ['input', 'change']) input.dispatchEvent(new Event(t, { bubbles: true }));
  input.focus();
}, true);
form.addEventListener('change', (e) => { if (e.target.matches('select[name^="role."]')) fillModelMenus(); });

function saveSettings(quiet = false) {
  const was = JSON.stringify([settings.connections, settings.roles]);
  const next = {
    chunkSeconds: Math.min(30, Math.max(4, Math.round(Number(form.elements.chunkSeconds.value) || 12))),
    languages: form.elements.languages.value.trim().slice(0, 200),
    answerLang: form.elements.answerLang.value,
    vocab: form.elements.vocab.value.slice(0, 4000),
    fixWords: form.elements.fixWords.checked,
    subtitles: form.elements.subtitles.value,
    sources: settings.sources,
    fileVocab: form.elements.fileVocab.checked,
    style: form.elements.style.value.trim().slice(0, 1000),
    connections: readConns(),
    roles: readRoles(),
  };
  if (!storeSettings(next)) return;
  settings = loadSettings();
  renderSubs();
  if (desk) saveDeskSettings();
  if (JSON.stringify([settings.connections, settings.roles]) !== was) checkHealth();
  if (!quiet) toast('Settings saved.');
}

// Settings apply as they are made, like iOS: each change is saved once the whole form is valid, and Done closes.
// What keeps the form from saving: the first field with an error, named ("Vision: ..."), or ''.
function formProblem() {
  const fields = [form.elements.chunkSeconds, ...$$('[name^="role."]', form),
    ...[...inUse()].flatMap((id) => { const c = formConn(id); return c ? connFields(c.type).map((f) => form.elements[`${id}.${f.key}`]) : []; }),
    ...$$('[data-hotkey]', form)];
  for (const i of fields) {
    const msg = fieldError(i.name, i.value);
    if (!msg) continue;
    const box = i.closest('.prov');
    const lab = i.closest('label')?.querySelector('span');
    return `${box ? `${$('summary .name', box).textContent}, ` : ''}${lab?.dataset.name || lab?.textContent || i.name}: ${msg}`;
  }
  return '';
}
const formValid = () => !formProblem();
// Nothing is dropped without a word: while the form cannot save, the footer says what to fix.
const sayUnsaved = (problem = formProblem()) => { $('#set-unsaved').textContent = problem ? `Not saved yet. ${problem}` : ''; };
let applyTimer = null;
function autoApply() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    if (!$('#dlg-settings').open) return;
    const problem = formProblem();
    sayUnsaved(problem);
    if (!problem) saveSettings(true);
  }, 250);
}
form.addEventListener('change', autoApply);

// A new connection of the picked type, with that type's usual values, opened for its key.
$('#conn-add').addEventListener('change', (e) => {
  const type = e.target.value;
  e.target.value = '';
  if (!PROVIDERS[type]) return;
  const c = { id: `c${crypto.randomUUID().slice(0, 8)}`, name: type === 'openai' ? PRESETS.openai.label : PROVIDERS[type].label, type,
    ...(type === 'openai' ? { preset: 'openai' } : {}), ...Object.fromEntries(connFields(type).map((f) => [f.key, f.value])) };
  $('#provider-fields').insertAdjacentHTML('beforeend', connHtml(c));
  fillConn(c);
  fillRoleSelects();
  syncProviders();
  connBox(c.id).open = true;
  form.elements[`${c.id}.name`].focus();
  if (type === 'cli') loadCliAllow();
  if (type === 'publik') fillPublikSetup();
});
form.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('select[name^="role."]')) {
    const refused = roleError(t.name.slice(5), formConn(t.value));
    const back = formConn(t.dataset.last);
    // A connection that cannot do the role (DeepSeek for Vision): the picker goes back to the last one, and says why.
    if (refused && back) {
      t.value = back.id;
      validateField(t);
      $(`#err-${CSS.escape(t.name)}`).textContent = `${refused} Kept ${back.name}.`;
    } else if (t.value !== t.dataset.last) {
      // another connection: the model its type or preset starts with (DeepSeek: deepseek-reasoner for Reasoning)
      const model = form.elements[`${t.name}.model`];
      const c = formConn(t.value);
      const key = t.name === 'role.deep' ? 'deepModel' : 'model';
      model.value = defaultModel(c, t.name.slice(5));
      model.placeholder = PROVIDERS[c?.type]?.fields.find((f) => f.key === key)?.placeholder || '';
      t.dataset.last = t.value;
      validateField(t);
    }
    validateField(form.elements[`${t.name}.model`]);
    syncProviders();
  }
  // a preset fills the base URL, and the name while it is still a preset's
  if (t.matches('select[name$=".preset"]')) {
    const id = t.name.slice(0, -'.preset'.length);
    const p = PRESETS[t.value];
    const name = form.elements[`${id}.name`];
    if (p.baseUrl) form.elements[`${id}.baseUrl`].value = p.baseUrl;
    if ([PROVIDERS.openai.label, ...Object.values(PRESETS).map((x) => x.label)].includes(name.value.trim())) name.value = t.value === 'custom' ? PROVIDERS.openai.label : p.label;
    syncHost(id);
    fillRoleSelects();
    validateField(form.elements[`${id}.baseUrl`]);
    validateRoles(); // a preset can take images or audio away from a role on it
  }
});
form.addEventListener('input', (e) => {
  if (/\.name$/.test(e.target.name) && !e.target.name.startsWith('role.')) fillRoleSelects();
  if (/\.baseUrl$/.test(e.target.name)) syncHost(e.target.name.slice(0, -'.baseUrl'.length));
});
form.addEventListener('change', (e) => { if (e.target.matches('input')) validateField(e.target); });
form.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') validateField(e.target); });
form.addEventListener('click', (e) => {
  const t = e.target.closest('[data-test]');
  if (t) return testProvider(t.dataset.test, t);
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const id = rm.dataset.remove;
    const users = Object.entries(readRoles()).filter(([, x]) => x.conn === id).map(([r]) => ROLES[r].label);
    if (users.length) { // said inside the dialog, next to the button: a toast would sit behind the modal
      const out = $('[data-result]', connBox(id));
      out.className = 'test-result fail';
      out.setAttribute('role', 'alert');
      out.textContent = `${formConn(id).name} is used for ${users.join(', ')}. Pick another connection there first.`;
      return;
    }
    rm.closest('.prov').remove();
    fillRoleSelects();
    return autoApply();
  }
  const r = e.target.closest('[data-reveal]');
  if (!r) return;
  const input = r.previousElementSibling;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  r.setAttribute('aria-pressed', String(show));
  r.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
});
form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  let ok = validateField(form.elements.chunkSeconds);
  if (!validateRoles()) ok = false;
  sayUnsaved();
  for (const id of inUse()) {
    if (connBox(id) && !validateProvider(id)) { ok = false; connBox(id).open = true; }
  }
  if (!ok) { e.preventDefault(); revealField($('[aria-invalid="true"]', form))?.focus(); }
});
$('#dlg-settings').addEventListener('close', () => { if ($('#dlg-settings').returnValue === 'save' && formValid()) saveSettings(true); $('#dlg-settings').returnValue = ''; });

// ---------------------------------------------------------------- chrome

let lastRecLabel = '';
let quiet = false;
function renderRec() {
  if (active?.deep && !active.text) scheduleCard(active); // the Think harder clock and progress bar
  const hearing = !!(taps.meeting || mic);
  const on = [taps.meeting && 'Meeting', mic && 'You'].filter(Boolean);
  const [cls, label] = hearing ? ['live', 'Live'] : display ? ['warn', 'Screen only'] : meeting ? ['warn', 'Paused'] : ['', 'Idle'];
  const time = meeting ? clock(Date.now()) : '';
  for (const el of [$('#st-rec'), pip && $('.mini-rec', pip.document)]) {
    if (!el) continue;
    setPill(el, cls, label);
    el.dataset.tip = label;
    $('.clock', el).textContent = time;
    $('.src', el).textContent = on.join(' + ');
  }
  if (label !== lastRecLabel) { if (lastRecLabel) announce(`Maverick is ${label.toLowerCase()}.`); lastRecLabel = label; }
  // Shared audio that stays silent: Teams muted, or its sound going to another device.
  const tap = taps.meeting;
  if (tap) {
    if (tap.peak > 0.004) lastHeard = Date.now();
    tap.peak = 0;
    const silent = Date.now() - lastHeard > QUIET_MS;
    if (silent !== quiet) {
      quiet = silent;
      banner('quiet', silent ? 'Maverick hasn’t heard the meeting for 30 seconds. Check that Teams isn’t muted and that tab or system audio was shared.' : '');
    }
  }
}

function renderControls() {
  const share = $('#btn-share');
  share.classList.toggle('on', !!display);
  share.classList.toggle('primary', !display);
  share.querySelector('span').textContent = display ? 'Stop sharing' : 'Share meeting';
  share.querySelector('use').setAttribute('href', display ? '#i-stop' : '#i-screen');
  for (const [b, on] of [[$('#btn-mic'), !!mic], ...(pip ? [[$('[data-cmd="mic"]', pip.document), !!mic]] : [])]) {
    b.classList.toggle('on', on);
    const span = b.querySelector('span');
    if (span) span.textContent = on ? 'Stop mic' : 'Mic';
    if (b.classList.contains('ib')) b.setAttribute('aria-label', on ? 'Stop mic' : 'Mic');
  }
  if (pip) $('[data-cmd="end"]', pip.document).disabled = !meeting;
  const pipBtn = $('#btn-pip');
  pipBtn.classList.toggle('on', !!pip);
  pipBtn.querySelector('span').textContent = desk ? 'Show bar' : pip ? 'Show pop-out' : 'Pop out';
  pipBtn.setAttribute('aria-pressed', String(!!pip));
  $('#btn-end').disabled = !meeting || ending;
  $('#btn-flag').disabled = !meeting;
  $('.screen').classList.toggle('has-video', !!display);
  $('.transcript-card').dataset.live = String(!!(display || mic));
  // Before a meeting the page is one centred column (styles.css, .grid.solo); level meters only for live sources.
  $('.grid').classList.toggle('solo', !display && !meeting);
  $('#lvl-meeting').parentElement.hidden = !taps.meeting;
  $('#lvl-mic').parentElement.hidden = !mic;
  const can = hasTranscript();
  for (const d of docs()) {
    for (const b of $$('[data-action="answer"], [data-action="followup"], [data-action="recap"]', d)) b.disabled = !can;
    for (const b of $$('[data-action="explain"], [data-action="solve"]', d)) b.disabled = !display;
  }
  renderRec();
  renderChecklist();
  renderCaption();
  renderEgress();
}

// Theme: no data-theme means follow the OS. The toggle pins the other theme, or unpins when it matches the OS.
// In the desktop app a pinned theme is also sent to Electron (nativeTheme.themeSource), so the Mica material and the
// caption buttons follow it; that also changes this media query, so the OS theme is remembered while unpinned.
const sysDark = matchMedia('(prefers-color-scheme: dark)');
const systemTheme = () => (sysDark.matches ? 'dark' : 'light');
// At start the main process says what Windows uses; the media query may still carry a theme pinned before a reload.
let osTheme = desk?.osTheme() || systemTheme();
let deskTheme = null;
const pinnedTheme = () => { try { return localStorage.getItem('maverick.theme') || ''; } catch { return ''; } };

// '' follows Windows (Automatic), 'light' or 'dark' pins one. fade: crossfade each window (View Transitions).
function applyTheme(theme, fade = false) {
  for (const d of docs()) {
    const set = () => { if (theme) d.documentElement.dataset.theme = theme; else delete d.documentElement.dataset.theme; };
    // A crossfade that cannot run (a hidden window, or a newer one) is skipped; the theme still changes.
    if (fade && d.startViewTransition && !reduceMotion.matches && d.visibilityState === 'visible') d.startViewTransition(set).ready.catch(() => {}); else set();
  }
  try { if (theme) localStorage.setItem('maverick.theme', theme); else localStorage.removeItem('maverick.theme'); } catch { /* storage full: theme still applies */ }
  if (desk && theme !== deskTheme) { deskTheme = theme; desk.theme(theme); }
  syncThemeUI(theme); // with a crossfade the attribute changes a frame later, so pass the theme along
}

// Windows switched light or dark while Maverick follows it. By the time this runs the page would already paint the
// new theme, so the old one is pinned for one more frame and the crossfade then goes from old to new.
function onSystemTheme() {
  const was = osTheme;
  // Pinned: nothing to show. In the desktop app this is our own themeSource change, so the OS theme is not read.
  if (pinnedTheme()) { if (!desk) osTheme = systemTheme(); return; }
  osTheme = systemTheme(); // unpinned, so this media query is Windows' setting again
  if (was === osTheme) return;
  for (const d of docs()) d.documentElement.dataset.theme = was;
  applyTheme('', true);
}

function syncThemeUI(pinned = document.documentElement.dataset.theme || '') {
  const dark = (pinned || osTheme) === 'dark';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  for (const b of [$('#btn-theme'), pip && $('[data-cmd="theme"]', pip.document)].filter(Boolean)) {
    $('use', b).setAttribute('href', dark ? '#i-sun' : '#i-moon');
    b.setAttribute('aria-label', label);
  }
  for (const r of $$('input[name="appearance"]')) r.checked = r.value === pinned;
}

// The header and bar buttons flip light and dark; picking the one Windows uses goes back to Automatic.
function toggleTheme() {
  const next = (pinnedTheme() || osTheme) === 'dark' ? 'light' : 'dark';
  applyTheme(next === osTheme ? '' : next, true);
}

const HOTKEYS = {
  Digit1: 'answer', Numpad1: 'answer', Digit2: 'explain', Numpad2: 'explain',
  Digit3: 'followup', Numpad3: 'followup', Digit4: 'recap', Numpad4: 'recap', Digit5: 'flag', Numpad5: 'flag', Digit6: 'assist', Numpad6: 'assist',
};
const trigger = (action) => (action === 'flag' ? flagMoment() : action === 'assist' ? smartAssist() : runAction(action));

function onKey(e) {
  const doc = e.target.ownerDocument || document;
  const dialogOpen = !!document.querySelector('dialog[open]');
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const action = HOTKEYS[e.code];
    if (!action) return;
    e.preventDefault();
    if (!e.repeat && !dialogOpen) trigger(action);
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape') {
    if (dialogOpen || e.isComposing) return; // Esc closes the dialog and nothing else
    if (e.target.matches?.('form.ask input') && e.target.value) { e.target.value = ''; return; } // first Esc clears the question
    active?.ctrl.abort();
  } else if (e.key === '/' && !typing && !e.target.closest?.('dialog')) {
    e.preventDefault();
    ($('.mini form.ask input', doc) || $('form.ask input', doc))?.focus();
  }
}

// ---------------------------------------------------------------- boot

const probe = Object.assign(document.createElement('div'), { className: 'sb-probe' });
document.body.append(probe);
document.documentElement.style.setProperty('--sbw', `${probe.offsetWidth - probe.clientWidth}px`);
probe.remove();

if (/mac/i.test(navigator.userAgentData?.platform || navigator.platform)) {
  for (const k of [...$$('kbd'), ...$$('kbd', $('#tpl-mini').content)]) k.textContent = k.textContent.replace('Alt', 'Option');
}

wirePanel($('.copilot'));
buildSettingsForm();

// In-page tooltips. A title attribute makes Windows draw a native tooltip: its own window, which screen shares show
// even while Maverick hides. So nothing here uses title; elements carry data-tip, and one tip per document shows it,
// inside the page, where content protection covers it. It is a popover so it sits above open dialogs. A stray title
// (from a library or a later edit) is moved to data-tip on first hover or focus, before Windows would show it.
// Buttons with their own .tip child (the bar's icons) keep theirs.
function wireTips(doc) {
  const tip = doc.createElement('div');
  tip.className = 'float-tip';
  tip.popover = 'manual';
  tip.setAttribute('aria-hidden', 'true');
  doc.body.append(tip);
  let timer = 0;
  let on = null;
  const hide = () => { clearTimeout(timer); on = null; if (tip.matches(':popover-open')) tip.hidePopover(); };
  const show = (el) => {
    if (!el.isConnected) return;
    tip.textContent = el.dataset.tip;
    tip.showPopover();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    const below = r.bottom + 8 + h <= doc.documentElement.clientHeight;
    tip.style.setProperty('--x', `${Math.round(Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2)))}px`);
    tip.style.setProperty('--y', `${Math.round(below ? r.bottom + 8 : Math.max(8, r.top - 8 - h))}px`);
  };
  const enter = (e) => {
    const el = e.target.closest?.('[title], [data-tip]');
    if (!el || el === on) return;
    if (el.hasAttribute('title')) { if (el.title) el.dataset.tip = el.title; el.removeAttribute('title'); }
    if (!el.dataset.tip || el.querySelector(':scope > .tip')) return;
    hide();
    on = el;
    timer = setTimeout(() => show(el), e.type === 'focusin' ? 150 : 450);
  };
  doc.addEventListener('pointerover', enter);
  doc.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible')) enter(e); });
  doc.addEventListener('pointerout', (e) => { if (on && !on.contains(e.relatedTarget)) hide(); });
  for (const t of ['focusout', 'pointerdown', 'scroll']) doc.addEventListener(t, hide, true);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
wireTips(document);

$('#btn-share').addEventListener('click', toggleShare);
for (const b of $$('[data-share]')) b.addEventListener('click', toggleShare);
for (const b of $$('[data-mic]')) b.addEventListener('click', toggleMic);
$('#share-go').addEventListener('click', () => { store('maverick.seenShareTip', '1'); $('#dlg-share').close(); startShare(); });
$('#btn-mic').addEventListener('click', toggleMic);
$('#btn-pip').addEventListener('click', popOut);
$('#btn-end').addEventListener('click', endMeeting);
$('#btn-flag').addEventListener('click', flagMoment);
$('#btn-subs').addEventListener('click', toggleSubs);
$('#btn-library').addEventListener('click', openLibraryDialog);
for (const r of $$('input[name="sources"]')) r.addEventListener('change', () => setSource(r.value));
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-history').addEventListener('click', openHistory);
$('#btn-theme').addEventListener('click', toggleTheme);
for (const r of $$('input[name="appearance"]')) r.addEventListener('change', () => applyTheme(r.value, true));
sysDark.addEventListener('change', onSystemTheme);
showScrollbars(document);
$('#sum-download').addEventListener('click', () => summaryMeeting && download(summaryMeeting));
$('#sum-actions').addEventListener('click', () => summaryMeeting && downloadActions(summaryMeeting));
$('#sum-copy').addEventListener('click', (e) => summaryMeeting && copyText(summaryMeeting.summary || '', e.currentTarget));
$('.skip').addEventListener('click', (e) => { e.preventDefault(); $('#ask-input').focus(); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) e.target.closest('dialog').close(); });
document.addEventListener('keydown', onKey);
// Global shortcuts from the Maverick hotkeys extension (extension/) arrive as this event.
addEventListener('cue-action', (e) => { if (Object.values(HOTKEYS).includes(e.detail)) trigger(e.detail); });
setInterval(renderRec, 1000);

if (!navigator.mediaDevices?.getDisplayMedia) banner('support', 'This browser cannot share screens. Use desktop Chrome or Edge.', 'bad');
applyTheme(localStorage.getItem('maverick.theme') || '');
hasHistory = loadMeetings().length > 0;
renderSubs();
renderSources();
openLibrary().catch((e) => toast(`The library could not be opened: ${e.message}`, 'error'));
restoreLive();
if (location.hash === '#mini') { pip = window; mountMini(window); }
renderControls();
renderPip();
checkHealth();

// ---------------------------------------------------------------- Sources: Meeting, Web, My material only

// Web or My material only: the messages, request options and provider for this card. In My material only, when the
// library has nothing close enough to the question, card.notFound is set instead and nothing is sent.
// Solve first has the live model write the problem on the screen as text: the library search needs words, and Web
// gets no screenshot.
async function sourcePrompt(card, question, frame, transcript) {
  const { action } = card;
  const recent = transcript.filter((l) => l.t >= (transcript.at(-1)?.t ?? 0) - RECENT_MS);
  let problem = '';
  if (action === 'solve') {
    if (!frame) throw new Error('There is no screen frame yet. Wait a moment after sharing, then try again.');
    setPhase(card, 'Reading the screen');
    for await (const t of streamChat([{ role: 'user', content: SCREEN_PROBLEM }], { images: [frame], temperature: 0, maxTokens: 400, signal: card.ctrl.signal }, conf('vision'))) problem += t;
    problem = problem.trim();
  }
  if (card.source === 'web') {
    setPhase(card, 'Searching the web');
    const q = action === 'solve' ? `Solve this problem from my screen: the answer first, then the short working; for code, the full code and its time and space complexity.\n\n${problem}` : question;
    const messages = withWeb(buildPrompt(action === 'solve' ? 'ask' : action, { transcript, question: q, startedAt: meeting?.startedAt, answerLang: settings.answerLang, ...context() }));
    return { messages, opts: { web: true }, conf: conf('web') };
  }
  setPhase(card, 'Searching your files');
  const query = action === 'ask' ? question : action === 'solve' ? problem : recent.slice(-4).map((l) => l.text).join(' ');
  const hits = lib.chunks.length && query.trim() ? await searchLibrary(query, libModels.embed) : [];
  card.chunks = hits.map(({ vec, tokens, ...c }) => c);
  card.query = query;
  if (!enough(hits)) {
    card.notFound = { missing: lib.chunks.length ? notCovered(query) : 'Your library is empty' };
    return null;
  }
  setPhase(card, '');
  const q = action === 'ask' ? `My question: ${question.trim()}` : action === 'solve' ? `The problem on the screen:\n${problem}`
    : `The conversation, last 2 minutes:\n${formatTranscript(recent, 0, meeting?.startedAt)}`;
  return { messages: buildGroundedPrompt({ task: GROUNDED_TASKS[action], question: q, chunks: hits, answerLang: settings.answerLang, style: settings.style }), opts: { temperature: 0.2 } };
}
function setPhase(card, text) { card.phase = text; scheduleCard(card); }

// After a My material only answer (library.mjs, checkGrounded): every citation must be one of the chunks the prompt gave;
// others are removed and the card says so. A reply with no valid citation is not shown as an answer: nothing in the files
// backs it, and the not-found card names what is missing (the model's words, or else the question). A cited half-answer
// stays, with a "Missing:" line for the rest; simple arithmetic is recomputed and a wrong result corrected in the open.
function groundCheck(card) {
  const g = checkGrounded(card.text, card.chunks, card.query || card.question);
  if (g.notFound) {
    card.notFound = g.notFound;
    card.text = '';
    return;
  }
  card.text = g.text;
  if (g.removed) card.note = [card.note, `Removed ${g.removed} citation${g.removed > 1 ? 's' : ''} that did not match your files.`].filter(Boolean).join(' ');
}

const SOURCE_LOOK = {
  meeting: ['i-wave', 'Meeting', 'Answers from the meeting and the shared screen'],
  web: ['i-globe', 'Web', 'Answers from the web through Claude Code, with links'],
  material: ['i-book', 'My material only', 'Answers only from your Library, with page citations'],
};
function renderSources() {
  const s = settings.sources;
  for (const r of $$('input[name="sources"]')) r.checked = r.value === s;
  for (const d of docs()) {
    const btn = $('.src-btn', d);
    if (!btn) continue;
    $('use', btn).setAttribute('href', `#${SOURCE_LOOK[s][0]}`);
    btn.setAttribute('aria-label', `Sources: ${SOURCE_LOOK[s][1]}`);
    $('.tip', btn).textContent = `Sources: ${SOURCE_LOOK[s][1]}`;
    btn.classList.toggle('set', s !== 'meeting');
    for (const o of $$('.src-pick [data-source]', d)) { o.setAttribute('aria-checked', String(o.dataset.source === s)); o.dataset.tip = SOURCE_LOOK[o.dataset.source][2]; }
  }
}
function setSource(s) {
  if (!SOURCES.includes(s)) return;
  if (s !== settings.sources && storeSettings({ ...settings, sources: s })) settings = loadSettings();
  for (const d of docs()) { const row = $('.src-pick', d); if (row) row.hidden = true; $('.src-btn', d)?.setAttribute('aria-expanded', 'false'); }
  renderSources();
  announce(`Sources: ${SOURCE_LOOK[settings.sources][1]}.`);
}
// The bar's Sources button opens a row of the three choices under the bar, inside the bar window.
function toggleSourcePick(btn) {
  const row = $('.src-pick', btn.ownerDocument);
  row.hidden = !row.hidden;
  btn.setAttribute('aria-expanded', String(!row.hidden));
  if (!row.hidden) $('[aria-checked="true"]', row)?.focus();
}
function openUrl(u) {
  if (desk) desk.openUrl(u); else window.open(u, '_blank', 'noopener,noreferrer');
}
// A publik 402's one link: https publikhq.com only, opened through the main process's publik check (main.cjs, publik-open).
function openTopUp(u) {
  if (!isPublikTopUp(u)) return;
  if (desk?.publikOpen) desk.publikOpen(u); else window.open(u, '_blank', 'noopener,noreferrer');
}
// Memory and Homework errors: the same one link, as a button, only when it passes.
const topUpButton = (u) => (isPublikTopUp(u) ? `<button type="button" class="btn sm primary" data-topup="${escapeHtml(u)}"><span>Add publik balance</span></button>` : '');
document.addEventListener('click', (e) => { const b = e.target.closest('[data-topup]'); if (b) openTopUp(b.dataset.topup); });

// ---------------------------------------------------------------- the library (main window)

// The models the library uses: the Vision role reads scans and images (local gemma4 unless Settings say otherwise), and
// the embedding model runs on this PC, through Ollama's /api/embed, unless Live answers come from publik API: then
// publik makes the vectors too (embedPublik), so a computer without Ollama still has a searchable Library.
// shortcut: the found / not found thresholds (library.mjs, COS_FOUND) were measured with embeddinggemma only.
const EMBED_MODEL = 'embeddinggemma';
const libModels = {
  async read(prompt, jpeg) {
    let out = '';
    for await (const t of streamChat([{ role: 'user', content: prompt }], { images: [jpeg], temperature: 0, maxTokens: 2000, signal: AbortSignal.timeout(240_000) }, conf('vision'))) out += t;
    return out.trim();
  },
  async embed(texts) {
    const live = tryConf('live');
    if (live?.id === 'publik') return embedPublik(texts, live, AbortSignal.timeout(120_000));
    const url = `${ollamaUrl().replace(/\/+$/, '')}/api/embed`;
    let res;
    try {
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '1h' }) };
      countSend(url, req.body, req.headers); // 0 unless the Ollama URL points off this PC
      res = await fetch(url, { ...req, signal: AbortSignal.timeout(120_000) });
    } catch { throw new Error(`Can’t reach Ollama at ${ollamaUrl()}. Start it with “ollama serve”`); }
    if (res.status === 404) throw new Error(`The embedding model is not installed. Run: ollama pull ${EMBED_MODEL}`);
    if (!res.ok) throw new Error(`Ollama could not embed the text (HTTP ${res.status})`);
    return (await res.json()).embeddings;
  },
};

// The Library and Homework notes say where files go for the current roles: they stay on this PC, or Vision reads images
// and scans with a connection off this PC, and Live gets the passages of My material answers.
function renderDataNotes() {
  const v = tryConf('vision');
  const off = (c) => (c && !isLocalConn(c) ? c : null);
  const [vision, live] = [off(v), off(tryConf('live'))];
  $('#lib-note').textContent = `PDF, PNG, JPG, WebP, .docx, .txt and .md. ${!vision && !live ? 'They stay on this PC.'
    : ['The files stay on this PC.', vision && `Images and scanned pages are read by ${vision.name}, off this PC.`, live && `Passages used in answers go to ${live.name}.`,
      live?.id === 'publik' && 'Search runs on publik API too, so the full text of each file goes there.'].filter(Boolean).join(' ')}`;
  $('#lib-read-note').textContent = v ? `Scanned pages and images are read by ${v.name}${v.model ? `, ${v.model}` : ''}, ${vision ? 'off' : 'on'} this PC.`
    : 'Scanned pages and images need a Vision connection in Settings.';
  $('#hw-note').textContent = `PDF, photo, .docx, .txt or .md. ${vision ? `Photos and scanned pages are read by ${vision.name}, off this PC.` : 'It stays on this PC.'}${live?.id === 'publik' ? ' Its questions go to publik API to search your Library.' : ''}`;
}

const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const FILE_ICON = { pdf: 'i-notes', image: 'i-image', docx: 'i-notes', text: 'i-notes' };
function fileStatus(f) {
  const read = f.read?.length ? (f.kind === 'image' ? ', read from the image' : `, ${f.read.length} scanned page${f.read.length > 1 ? 's' : ''} read from the image`) : '';
  if (f.status === 'ready') return `Ready, ${f.chunks} passage${f.chunks === 1 ? '' : 's'}${read}`;
  if (f.status === 'failed') return `Failed: ${f.error}`;
  if (f.status === 'indexing') return 'Indexing';
  return f.read?.length ? `Reading page ${f.read.at(-1)} from its image` : 'Reading';
}
function renderLibrary() {
  const files = lib.files;
  $('#lib-usage').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}, ${size(totalBytes())}` : '';
  $('.library').classList.toggle('none', !files.length);
  $('#lib-list').innerHTML = files.map((f) => `<li class="lib-row" data-id="${escapeHtml(f.id)}" data-status="${f.status}">
    <svg class="i"><use href="#${FILE_ICON[f.kind] || 'i-notes'}"/></svg>
    <span class="name"><b dir="auto">${escapeHtml(f.name)}</b><small class="status">${escapeHtml(fileStatus(f))}</small></span>
    <span class="size">${size(f.size)}</span>
    <button type="button" class="btn sm ghost" data-remove aria-label="Remove ${escapeHtml(f.name)}"><svg class="i sm"><use href="#i-trash"/></svg><span>Remove</span></button></li>`).join('');
  fileVocab = extractVocab(files.filter((f) => f.status === 'ready').flatMap((f) => f.pages), 30);
  renderFileVocab();
}
function renderFileVocab() {
  const n = fileVocab.length;
  $('#file-vocab-note').textContent = n
    ? `Names and acronyms from your Library go to transcription as spellings: ${fileVocab.slice(0, 10).join(', ')}${n > 10 ? `, and ${n - 10} more` : ''}.`
    : 'Names and acronyms found in your Library go to transcription as spellings. None yet.';
}
// From the bar the main window comes up without the keyboard (main.cjs, showMain): the meeting app keeps typing.
function openLibraryDialog() {
  if (desk) desk.showMain(document.hasFocus());
  renderDataNotes();
  renderLibrary();
  if (!$('#dlg-library').open) $('#dlg-library').showModal();
}
const importFiles = (list) => addFiles(list, libModels).catch((e) => toast(`Adding files failed: ${e.message}`, 'error'));
onLibrary(renderLibrary);
$('#lib-input').accept = ACCEPT;
$('#lib-input').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
// Files dropped anywhere on the main window go to the library (and Electron does not open them as a page).
document.addEventListener('dragover', (e) => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); $('#lib-drop').classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#lib-drop').classList.remove('over'); });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  $('#lib-drop').classList.remove('over');
  if (e.target.closest?.('#dlg-homework')) return addWorksheet(e.dataTransfer.files[0]); // a worksheet, not a Library file
  openLibraryDialog();
  importFiles([...e.dataTransfer.files]);
});
// Remove asks twice, like Delete in History: the first click arms it for 4 s.
$('#lib-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const id = b.closest('.lib-row').dataset.id;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    $('span', b).textContent = 'Remove for good';
    announce(`Press Remove again to remove ${fileById(id)?.name}.`);
    setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; $('span', b).textContent = 'Remove'; } }, 4000);
    return;
  }
  await removeFile(id);
});

// ---------------------------------------------------------------- the viewer: a citation opens its page with the passage marked

let viewUrl = '';
// The claim a citation backs: its sentence, from the start of its paragraph or list item up to the chip.
function claimOf(btn) {
  const block = btn.closest('p, li, blockquote, td') || btn.parentElement;
  const r = btn.ownerDocument.createRange();
  r.setStart(block, 0);
  r.setEndBefore(btn);
  return r.toString().split(/(?<=[.!?\u061F])\s+/).map((s) => s.trim()).filter(Boolean).at(-1) || '';
}
// Inside the cited passages, the one sentence that shares the most words with the claim (at least two), so the viewer
// marks that sentence and not the whole passage; null when none does, and the passage is marked as before.
function citedSentence(text, ranges, claim) {
  const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const want = words(claim);
  let best = null;
  for (const r of want.size ? ranges : []) {
    for (const m of text.slice(r.start, r.end).matchAll(/[^.!?\u061F\n]+[.!?\u061F]?/g)) {
      const w = words(m[0]);
      const hit = [...w].filter((x) => want.has(x)).length;
      const score = hit / Math.sqrt(w.size || 1);
      if (hit >= 2 && (!best || score > best.score)) {
        const start = r.start + m.index + (m[0].length - m[0].trimStart().length);
        best = { score, start, end: r.start + m.index + m[0].trimEnd().length };
      }
    }
  }
  return best && { start: best.start, end: best.end };
}
let viewAt = null; // what the viewer shows, for its previous and next page buttons
async function openViewer(card, fileId, page, claim = '') {
  const f = fileById(fileId);
  if (!f) return toast('That file is no longer in your Library.', 'warn');
  if (desk) desk.showMain(document.hasFocus());
  viewAt = { card, fileId, page, claim };
  const all = (card?.chunks ?? []).filter((c) => c.fileId === fileId && Number(c.page) === page);
  const one = claim && citedSentence(f.pages[page - 1] ?? '', all, claim);
  const ranges = one ? [one] : all;
  const scan = f.kind === 'image' || f.read?.includes(page);
  $('#view-title').textContent = f.name;
  $('#view-page').textContent = f.pages.length > 1 ? `Page ${page} of ${f.pages.length}` : '';
  $('.view-nav').hidden = f.pages.length < 2;
  $('[data-view="prev"]').disabled = page <= 1;
  $('[data-view="next"]').disabled = page >= f.pages.length;
  const body = $('#view-body');
  const marked = `<div class="view-text" dir="auto">${markRanges(f.pages[page - 1] ?? '', ranges)}</div>`;
  const note = scan ? `<p class="view-note">Maverick read this ${f.kind === 'image' ? 'image' : 'scanned page'} with the live model. The cited passage is marked in what it read, below.</p>` : '';
  if (f.kind === 'pdf') body.innerHTML = `<div class="view-page"><canvas></canvas><div class="hl"></div></div>${note}${scan ? marked : ''}`;
  else if (f.kind === 'image') body.innerHTML = `<div class="view-page"><img alt="${escapeHtml(f.name)}"></div>${note}${marked}`;
  else body.innerHTML = marked;
  const dlg = $('#dlg-viewer');
  if (!dlg.open) dlg.showModal();
  try {
    if (f.kind === 'pdf') {
      const span = !scan && ranges.length ? { start: Math.min(...ranges.map((r) => r.start)), end: Math.max(...ranges.map((r) => r.end)) } : null;
      const { boxes } = await renderPdfPage(fileId, page, $('canvas', body), Math.min(820, body.clientWidth - 48), span);
      // boxes are placed through the CSSOM: the page's CSP blocks style attributes in markup
      for (const bx of boxes) {
        const i = document.createElement('i');
        for (const [k, v] of Object.entries({ left: bx.x, top: bx.y, width: bx.w, height: bx.h })) i.style.setProperty(k, `${Math.round(v)}px`);
        $('.hl', body).append(i);
      }
    } else if (f.kind === 'image') {
      const { bytes, mime } = await blobOf(fileId);
      URL.revokeObjectURL(viewUrl);
      viewUrl = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));
      $('img', body).src = viewUrl;
    }
  } catch (e) {
    body.insertAdjacentHTML('afterbegin', `<p class="err">This page could not be shown: ${escapeHtml(e.message)}</p>`);
  }
  $(':is(.hl i, mark)', body)?.scrollIntoView({ block: 'center' });
}

$('.view-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b && viewAt) openViewer(viewAt.card, viewAt.fileId, viewAt.page + (b.dataset.view === 'next' ? 1 : -1), viewAt.claim);
});

// ---------------------------------------------------------------- Homework: a worksheet's questions, each with a draft

// Homework is open book: the drafts are for the student to rewrite in their own words. A worksheet (a file read the way
// the Library reads one, or pasted text) is split into its questions (homework.mjs); each gets a draft from My material
// (the Library, page citations, "Not in your material" when the files do not cover it) or the Web (Claude Code, links).
// Worksheets and drafts stay in IndexedDB ("maverick-homework"). My material drafts run on this PC (localConf), so only Web
// and a Vision model off this PC send bytes; each worksheet counts them (ws.egress) and the dialog shows the count.
const HW_SOURCE_KEY = 'maverick.homework.source';
let hwDb = null;
function hwTx(mode, fn) {
  hwDb ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('maverick-homework', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sheets', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return hwDb.then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('sheets', mode);
    const req = fn(t.objectStore('sheets'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}
let hwSheets = null; // loaded once, newest first
let hwSel = null;
let hwCtrl = null; // the drafts (or form answers) being written: Stop aborts it
let hwForm = null; // Fill a form: what was read, picked, filled and submitted
let hwTab = 'sheet'; // the right pane: the picked worksheet, or Fill a form (desktop app)
let hwSource = (() => { try { return localStorage.getItem(HW_SOURCE_KEY) === 'web' ? 'web' : 'material'; } catch { return 'material'; } })();
const hwSheet = () => hwSheets?.find((w) => w.id === hwSel) ?? null;
async function loadSheets() {
  hwSheets ??= (await hwTx('readonly', (s) => s.getAll())).sort((a, b) => b.createdAt - a.createdAt);
  hwSel ??= hwSheets[0]?.id ?? null;
}
// What is kept: not the parts that only live while a draft is written or edited.
const saveSheet = (ws) => hwTx('readwrite', (s) => s.put({ ...ws, reading: false, items: ws.items.map(({ raw, streaming, editing, phase, ...it }) => it) }))
  .catch((e) => toast(`The worksheet could not be saved: ${e.message}`, 'error'));
// My material drafts and form answers stay on this PC: the Live model when it runs here, else the Vision model.
function localConf() {
  const c = ['live', 'vision'].map(tryConf).find(isLocalConn);
  if (!c) throw new Error('Homework from My material runs on this PC. Pick a local connection (Ollama or LM Studio) for Live answers in Settings');
  return c;
}
const newSheet = (name) => ({ id: crypto.randomUUID(), name, createdAt: Date.now(), text: '', lang: 'English', items: [], egress: 0, error: '' });
// The questions of the text. A question whose words did not change keeps its draft.
function setText(ws, text) {
  const old = new Map(ws.items.map((it) => [it.q, it]));
  ws.text = text;
  ws.lang = worksheetLang(text);
  ws.items = splitQuestions(text).map(({ n, text: q }) => ({ ...(old.get(q) ?? { a: '' }), n, q }));
}

async function openHomework() {
  if (desk) desk.showMain(document.hasFocus());
  try { await loadSheets(); } catch (e) { return toast(`Homework could not be opened: ${e.message}`, 'error'); }
  renderDataNotes();
  renderHomework();
  if (!$('#dlg-homework').open) $('#dlg-homework').showModal();
}

async function addWorksheet(file) {
  if (!file) return;
  const kind = kindOf(file.name);
  if (!kind) return toast('Maverick reads worksheets as PDF, PNG, JPG, WebP, .docx, .txt or .md files.', 'warn');
  if (file.size > MAX_BYTES) return toast(`That worksheet is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 'warn');
  await loadSheets();
  const ws = newSheet(file.name);
  ws.reading = true;
  hwSheets.unshift(ws);
  hwSel = ws.id;
  hwTab = 'sheet';
  renderHomework();
  const count = (n) => { ws.egress = (ws.egress || 0) + n; }; // 0 while the Vision model is on this PC
  egress.add(count);
  try {
    // the same reading as the Library: the text layer, or the Vision model for scans and photos (copied as written, never translated)
    const models = { ...libModels, read: (prompt, jpeg) => libModels.read(WORKSHEET_READ_PROMPT, jpeg) };
    const pages = await readPages({ name: file.name, kind, mime: file.type, read: [] }, new Uint8Array(await file.arrayBuffer()), models, async () => {});
    const text = pages.join('\n\n').trim();
    if (!text) throw new Error('No text was found in it');
    setText(ws, text);
  } catch (e) {
    ws.error = `Reading it failed: ${String(e?.message || e).replace(/\.$/, '')}.`;
  } finally { egress.delete(count); }
  ws.reading = false;
  await saveSheet(ws);
  renderHomework();
}

// One question's draft, streamed into it. A calculation gets the Solve prompt (Numbers, Working, Answer; the
// arithmetic is checked after). My material runs on this PC; the Web goes through the Web role (Claude Code).
async function draftItem(ws, it, signal) {
  Object.assign(it, { a: '', raw: '', notFound: null, error: '', note: '', chunks: [], stopped: false, source: hwSource, streaming: true, phase: '' });
  let messages;
  let opts;
  let c;
  if (it.source === 'web') {
    it.phase = 'Searching the web';
    messages = withWeb(buildPrompt('ask', { question: webQuestion(it.q), answerLang: ws.lang, style: settings.style }));
    opts = { web: true };
    c = conf('web');
  } else {
    it.phase = 'Searching your files';
    paintHwItem(ws, it);
    // the Library and the notes of past meetings (Memory), ranked together; a note is cited [its name p.1]
    const pool = [...lib.chunks, ...(desk ? await memoryChunks('meeting') : [])];
    const hits = pool.length ? rankChunks(it.q, Float32Array.from((await libModels.embed([EMBED_QUERY(it.q)]))[0]), pool) : [];
    it.chunks = hits.map(({ vec, tokens, ...x }) => x);
    if (!enoughForHomework(hits)) { it.notFound = { missing: pool.length ? notCovered(it.q) : 'Your library is empty' }; return; }
    it.phase = '';
    messages = buildGroundedPrompt({ task: isMath(it.q) ? GROUNDED_TASKS.solve : HOMEWORK_TASK, question: `Homework question ${it.n}: ${it.q}`, chunks: hits, answerLang: ws.lang, style: settings.style });
    opts = { temperature: 0.2 };
    c = localConf();
  }
  paintHwItem(ws, it);
  for await (const t of streamChat(messages, { ...opts, signal }, c)) {
    it.raw += t;
    it.a = dropPlaceholders(stripThinking(it.raw));
    if (it.a) it.phase = '';
    paintHwItem(ws, it);
  }
  if (!it.a && it.raw.trim()) throw new Error('it wrote only its reasoning, no answer');
}
// As a card ends (runAction, groundCheck): the citations checked against the chunks given, or "Not in your material".
function finishItem(it) {
  it.streaming = false;
  it.phase = '';
  it.a = fixMixedScript(it.a || '');
  // stopped: the part written stays as it is (its citations may not have come yet), marked Stopped
  if (it.stopped) it.a = missingLines(it.a);
  if (it.source !== 'material' || !it.a.trim() || it.error || it.stopped) return;
  const g = checkGrounded(it.a, it.chunks, it.q);
  if (g.notFound) { it.notFound = g.notFound; it.a = ''; return; }
  it.a = g.text;
  if (g.removed) it.note = `Removed ${g.removed} citation${g.removed > 1 ? 's' : ''} that did not match your files.`;
}

// Drafts one question, or every question that has none, one after another.
async function draftAll(ws, only = null) {
  if (hwCtrl) return toast('Maverick is still working on your homework. Stop it first.', 'warn');
  const todo = only ? [only] : ws.items.filter((it) => !it.a?.trim() && !it.notFound);
  if (!todo.length) return;
  const ctrl = hwCtrl = new AbortController();
  // shortcut: a meeting answer sent at the same moment is counted here too (and in the meeting); tagging each request is the upgrade
  const count = (n) => { ws.egress = (ws.egress || 0) + n; };
  egress.add(count);
  renderHomework();
  try {
    for (const it of todo) {
      if (ctrl.signal.aborted) break;
      try {
        await draftItem(ws, it, ctrl.signal);
      } catch (e) {
        if (e.name === 'AbortError') it.stopped = true; else { it.error = e.message; it.topUp = e.topUp ?? null; }
        if (/can[’']t reach/i.test(e.message)) checkHealth();
      } finally {
        finishItem(it);
        await saveSheet(ws);
        paintHwItem(ws, it, true);
      }
    }
  } finally {
    egress.delete(count);
    hwCtrl = null;
    await saveSheet(ws);
    renderHomework();
    announce(ctrl.signal.aborted ? 'Drafting stopped.' : 'Drafts ready.');
    if (desk && todo.some((it) => it.a?.trim() || it.notFound)) rememberHomework(ws).catch(memoryFailed);
  }
}

const hwState = (it) => (it.streaming ? `<span class="state">${escapeHtml(it.phase || (it.a ? 'Writing' : 'Thinking'))}</span>`
  : `<span class="when">${it.source === 'web' ? 'Web' : it.a || it.notFound ? 'My material' : ''}</span>`);
function hwBody(it) {
  if (it.error) return `<p class="err">Maverick couldn’t draft this: ${escapeHtml(it.error)}</p>${topUpButton(it.topUp)}`;
  if (it.notFound) return notFoundHtml(it, false);
  if (it.editing) return `<textarea class="hw-edit" rows="7" dir="auto" aria-label="Edit the draft of question ${escapeHtml(it.n)}">${escapeHtml(it.a)}</textarea>`;
  if (!it.a) return it.streaming ? SKELETON : '';
  if (it.streaming && it.source === 'material' && /^\W*not[ _]?f/i.test(it.a)) return SKELETON; // a NOT FOUND reply on its way
  const shown = it.streaming && it.source === 'material' ? missingLines(it.a) : it.a;
  const html = renderMarkdown(it.streaming ? holdOpen(shown) : shown, { bidi: true });
  return glueCites(it.source === 'material' ? sourceChips(memChips(html, memFind), it.chunks ?? [], lib.files) : urlChips(html)) + (it.stopped ? '<p class="stopped">Stopped.</p>' : '')
    + (it.note && !it.streaming ? `<p class="stopped">${escapeHtml(it.note)}</p>` : '');
}
function hwItemHtml(it, i) {
  const again = it.a || it.notFound;
  const tools = it.streaming ? '<button class="tool stop" data-hw="stop" data-tip="Stop"><svg class="i"><use href="#i-stop"/></svg><span>Stop</span></button>'
    : (it.a ? `<button class="tool" data-hw="copy" aria-label="Copy the draft of question ${escapeHtml(it.n)}" data-tip="Copy"><svg class="i"><use href="#i-copy"/></svg></button>` +
      `<button class="tool" data-hw="edit" aria-pressed="${!!it.editing}"><span>${it.editing ? 'Done' : 'Edit'}</span></button>` : '') +
      (hwCtrl ? '' : `<button class="tool" data-hw="redo" aria-label="Draft question ${escapeHtml(it.n)}${again ? ' again' : ''}" data-tip="${again ? 'Draft again' : 'Draft this one'}"><svg class="i"><use href="#i-redo"/></svg></button>`);
  return `<li class="answer${it.streaming ? ' streaming' : ''}" data-i="${i}" aria-busy="${!!it.streaming}"><header class="answer-head"><span class="tag">${escapeHtml(it.n)}</span>` +
    `<span class="q" dir="auto">${escapeHtml(it.q)}</span>${hwState(it)}<div class="tools">${tools}</div></header><div class="md">${hwBody(it)}</div></li>`;
}
// A worksheet's line in the sidebar, and its count: the questions drafted, and those the files do not cover.
function sheetCount(w) {
  if (w.reading) return 'Reading';
  const n = w.items.length;
  const drafted = w.items.filter((x) => x.a?.trim()).length;
  const missing = w.items.filter((x) => x.notFound).length;
  return [`${n} question${n === 1 ? '' : 's'}`, drafted && `${drafted} drafted`, missing && `${missing} not in your files`].filter(Boolean).join(' · ');
}
function renderHwList() {
  $('#hw-list').innerHTML = hwSheets.map((w) => `<li><button type="button" data-hw="pick" data-id="${escapeHtml(w.id)}" aria-current="${w.id === hwSel && hwTab === 'sheet'}">` +
    `<strong dir="auto">${escapeHtml(w.name)}</strong><small>${escapeHtml(sheetCount(w))}</small></button></li>`).join('');
}
function sheetHtml(ws) {
  const n = ws.items.length;
  const todo = ws.items.filter((it) => !it.a?.trim() && !it.notFound).length;
  const missing = ws.items.filter((it) => it.notFound).length;
  return `<header class="hw-sheet-head"><h3 dir="auto">${escapeHtml(ws.name)}</h3><p>${escapeHtml(n ? `${sheetCount(ws)} · answers in ${ws.lang}` : ws.reading ? 'Reading the worksheet' : 'No questions yet')}</p></header>` +
    `<div class="hist-tools">${hwCtrl ? '<button class="btn" data-hw="stop"><svg class="i"><use href="#i-stop"/></svg><span>Stop</span></button>'
    : `<button class="btn primary" data-hw="draft"${todo ? '' : ' disabled'}><svg class="i"><use href="#i-solve"/></svg><span>Draft answers</span></button>`}` +
    `<button class="btn" data-hw="export"${n ? '' : ' disabled'}><svg class="i"><use href="#i-download"/></svg><span>Export .md</span></button>` +
    `<button class="btn ghost danger hw-del" data-hw="del"${hwCtrl ? ' disabled' : ''}><svg class="i"><use href="#i-trash"/></svg><span>Delete</span></button></div>` +
    (ws.reading ? '<div class="skel hw-reading" aria-hidden="true"><i></i><i></i><i></i></div><p class="muted">Reading the worksheet…</p>' : '') + (ws.error ? `<p class="err">${escapeHtml(ws.error)}</p>` : '') +
    (missing && !hwCtrl ? `<p class="hw-missing"><svg class="i sm"><use href="#i-book"/></svg><span>${missing === n ? 'Your files do not cover these questions.' : `Your files do not cover ${missing} of these questions.`} Add the chapter or notes they come from, then draft again.</span><button type="button" class="btn sm" data-hw="library"><svg class="i sm"><use href="#i-plus"/></svg><span>Add a file</span></button></p>` : '') +
    `<details class="hw-text"${n || ws.reading ? '' : ' open'}><summary>Worksheet text${n ? `: ${n} question${n === 1 ? '' : 's'}, answers in ${ws.lang}` : ''}</summary>` +
    `<textarea id="hw-text" rows="8" dir="auto" spellcheck="false" aria-label="Worksheet text" placeholder="Paste the questions here, each starting with its number, like 1. or Q2 or ١.">${escapeHtml(ws.text)}</textarea>` +
    `<p class="hw-row"><button type="button" class="btn sm" data-hw="split"${hwCtrl ? ' disabled' : ''}>Split into questions</button>` +
    '<small class="muted">Split wrong? Fix the numbers in the text and split again. Questions that did not change keep their drafts.</small></p></details>' +
    `<ol class="hw-items">${ws.items.map(hwItemHtml).join('')}</ol>`;
}
function renderHomework() {
  if (!hwSheets) return;
  const ws = hwSheet();
  for (const r of $$('input[name="hw-source"]')) r.checked = r.value === hwSource;
  $('#hw-form-open').hidden = !desk;
  const formTab = !!desk && hwTab === 'form';
  for (const t of $$('[data-hw-tab]')) t.setAttribute('aria-selected', String((t.dataset.hwTab === 'form') === formTab));
  $('#hw-form-panel').hidden = !formTab;
  $('.homework').classList.toggle('none', !hwSheets.length && !formTab);
  renderHwList();
  const sent = (ws?.egress || 0) + (hwForm?.egress || 0);
  $('#hw-usage').textContent = ws || hwForm ? `${fmtBytes(sent)} sent off this PC` : '';
  $('#hw-usage').dataset.tip = 'Bytes this homework sent to services outside this PC: Web answers, and worksheet reads when the Vision model is not on this PC. My material drafts run on this PC. Counted at each request as it leaves.';
  $('#hw-detail').innerHTML = formTab ? (hwForm ? formHtml() : '<div class="empty"><svg class="i glyph"><use href="#i-check-list"/></svg><p><strong>Fill a form from your worksheet</strong></p><p>Paste the link above. Maverick reads the questions, answers them from your material or the web, fills them in where you can watch, and waits for your yes before it submits.</p></div>')
    : ws ? sheetHtml(ws)
      : '<div class="empty"><svg class="i glyph"><use href="#i-check-list"/></svg><p><strong>Add a worksheet to start</strong></p><p>Drop a file on the left, or paste its text. Maverick finds the questions and drafts an answer to each, for you to rewrite in your own words.</p></div>';
}
// Streaming repaint of one question, at most once a frame; `now` paints at once (a draft just ended).
const hwQueued = new Set();
function paintHwItem(ws, it, now = false) {
  if (ws !== hwSheet()) return;
  const paint = () => {
    hwQueued.delete(it);
    const i = ws.items.indexOf(it);
    const li = $(`#hw-detail .hw-items > [data-i="${i}"]`);
    if (!li) return;
    // while it streams only the text and the state change, so the Stop button under the pointer stays the same element
    if (!now && it.streaming && li.getAttribute('aria-busy') === 'true') {
      $('.md', li).innerHTML = hwBody(it);
      $('.answer-head > .state', li).textContent = it.phase || (it.a ? 'Writing' : 'Thinking');
    } else li.outerHTML = hwItemHtml(it, i);
    if (now) renderHwList(); // the sidebar's count follows each finished draft
  };
  if (now) return paint();
  if (hwQueued.has(it)) return;
  hwQueued.add(it);
  requestAnimationFrame(paint);
}

// ---------------------------------------------------------------- Homework, Fill a form (desktop app)

// A form (a Microsoft Forms homework opened from Teams, say) in a normal window the user sees (desktop/main.cjs).
// Maverick reads its questions, answers each the way a draft is written (My material with a page citation, or the Web
// with links; a calculation shows its working), selects the picks and types the text answers in the page with a visible
// Maverick cursor, and leaves a question it is not sure of blank. An upload it never fills: it says what to put in the
// photo or file. Then it shows what the form holds and waits: only a typed "yes", or the Submit button of the review,
// clicks the form's Submit, once, and not while a required upload or question is still empty (homework.mjs, formNeeds).
// A sign-in or a captcha stops it.
const FORM_BUSY = { reading: 'Reading the form', answering: 'Answering', filling: 'Filling in the form', submitting: 'Submitting' };
const formBlocked = (r) => (r?.signin ? 'The form wants you to sign in. Sign in in the form window yourself, then press Read and fill again.'
  : r?.captcha ? 'The form shows a check (a captcha). Do it in the form window yourself, then press Read and fill again.' : '');

async function openForm() {
  const u = $('#hw-url').value.trim();
  if (!u) return toast('Paste the form link first.', 'warn');
  const r = await desk.formOpen(u);
  if (r?.error) toast(r.error, 'warn');
}

// What the form holds now, hand edits included: the checked options, the typed text and the attached files of each
// question. A sign-in or a captcha returns its message instead.
async function rereadForm() {
  const r = await desk.formRead();
  if (r?.error) throw new Error(r.error);
  const blocked = formBlocked(r);
  if (blocked) return blocked;
  for (const q of hwForm.questions) {
    const now = r.questions[q.i];
    if (now && now.text === q.text && now.kind === q.kind) Object.assign(q, { options: now.options, value: now.value, files: now.files });
  }
  return '';
}

// One form question through the draft path: My material (the grounded prompt, on this PC) or the Web. { text }, the
// reply with its citations checked, or { notSure, reason } when the material does not cover it.
async function askForm(q, task, webTask, question, lang, signal) {
  let messages;
  let opts;
  let c;
  if (q.source === 'web') {
    messages = withWeb(buildPrompt('ask', { question: `${webTask}\n\n${question}`, answerLang: lang, style: settings.style }));
    opts = { web: true };
    c = conf('web');
  } else {
    const hits = lib.chunks.length ? await searchLibrary(`${q.text} ${(q.options ?? []).map((o) => o.label).join(' ')}`, libModels.embed) : [];
    q.chunks = hits.map(({ vec, tokens, ...x }) => x);
    if (!enoughForHomework(hits)) return { notSure: true, reason: lib.chunks.length ? 'Not in your material.' : 'Your library is empty.' };
    messages = buildGroundedPrompt({ task, question, chunks: hits, answerLang: lang, style: settings.style });
    opts = { temperature: 0 };
    c = localConf();
  }
  let raw = '';
  for await (const t of streamChat(messages, { ...opts, signal }, c)) raw += t;
  const text = fixMixedScript(stripThinking(raw));
  if (q.source !== 'material') return { text };
  const g = checkGrounded(text, q.chunks, q.text);
  if (g.notFound) return { notSure: true, reason: `Not in your material. ${missingLine(g.notFound.missing)}` };
  // a corrected sum means the answer may rest on the slip: the question is left for the student
  if (g.sums.length) return { notSure: true, work: g.text, reason: 'The working had an arithmetic slip, so this one is left for you.' };
  return { text: g.text };
}
const withDraft = (q, question) => question + (q.match?.a ? `\n\nMy worksheet's draft answer to this question: ${q.match.a}` : '');

// A choice question: the letter of the pick (or Not sure) and a one-line reason.
async function answerChoice(q, lang, signal) {
  const r = await askForm(q, CHOICE_TASK, WEB_CHOICE_TASK, choiceQuestion(q, q.match?.a || ''), lang, signal);
  if (r.notSure) return Object.assign(q, { notSure: true, picks: [], reason: r.reason, work: r.work || '' });
  const { picks, reason } = parseChoice(r.text, q.options.length);
  const sure = picks.length && (q.multi || picks.length === 1);
  Object.assign(q, { work: r.text, notSure: !sure, picks: sure ? picks : [], reason: reason || (sure ? '' : 'Maverick was not sure.') });
}
// A text question: what to type (one line for a short answer, a short paragraph for a long one), or Not sure. A box the
// student already typed in is left as it is.
async function answerText(q, lang, signal) {
  if (String(q.value ?? '').trim()) return Object.assign(q, { kept: true, reason: 'You had already typed an answer here, so Maverick left it.' });
  const r = await askForm(q, textTask(q.long), webTextTask(q.long), withDraft(q, q.text), lang, signal);
  if (r.notSure) return Object.assign(q, { notSure: true, typed: '', reason: r.reason, work: r.work || '' });
  const { value, reason } = parseTyped(r.text);
  const typed = q.max ? value.slice(0, q.max) : value;
  Object.assign(q, { work: r.text, typed, notSure: !typed, reason: [reason || (typed ? '' : 'Maverick was not sure.'), typed !== value ? `Cut to the box’s ${q.max} characters.` : ''].filter(Boolean).join(' ') });
}
// An upload: what to put in the photo or file, when the material covers it. The file itself is the student's to add.
async function answerUpload(q, lang, signal) {
  const r = await askForm(q, UPLOAD_TASK, WEB_UPLOAD_TASK, q.text, lang, signal);
  Object.assign(q, { guide: r.notSure ? '' : r.text, reason: r.notSure ? r.reason : '' });
}
const ANSWER = { choice: answerChoice, text: answerText, upload: answerUpload };

async function fillForm() {
  if (!desk) return;
  if (hwCtrl) return toast('Maverick is still working on your homework. Stop it first.', 'warn');
  await loadSheets();
  const ws = hwSheet();
  const ctrl = hwCtrl = new AbortController();
  const f = hwForm = { state: 'reading', msg: '', note: '', page: '', questions: [], egress: 0 };
  const count = (n) => { f.egress += n; };
  egress.add(count);
  renderHomework();
  const stopped = () => { if (ctrl.signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
  try {
    const r = await desk.formRead();
    if (r?.error) throw new Error(r.error);
    if (formBlocked(r)) { f.state = 'blocked'; f.msg = formBlocked(r); return; }
    if (!r.questions.length) throw new Error('No questions were found on this page');
    f.page = r.title || '';
    f.questions = r.questions.map((q) => ({ ...q, picks: [], typed: '', guide: '', reason: '', work: '', notSure: false, chunks: [], source: hwSource, match: ws ? matchQuestion(q.text, ws.items) : null }));
    f.state = 'answering';
    renderHomework();
    const lang = worksheetLang(r.questions.map((q) => q.text).join('\n'));
    for (const q of f.questions) {
      stopped();
      q.busy = true;
      renderHomework();
      try {
        await ANSWER[q.kind](q, lang, ctrl.signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        Object.assign(q, { notSure: q.kind !== 'upload', picks: [], typed: '', reason: `It could not be answered: ${e.message}` });
      } finally { q.busy = false; }
      renderHomework();
    }
    f.state = 'filling';
    renderHomework();
    for (const q of f.questions) {
      for (const j of q.picks) {
        stopped();
        const done = await desk.formFill(q.i, j);
        if (!done?.checked) q.reason = `${q.reason} Maverick could not select ${LETTERS[j]}: ${done?.error || 'the page did not take the click'}.`.trim();
      }
      if (q.kind === 'text' && q.typed && !q.kept) {
        stopped();
        const done = await desk.formType(q.i, q.typed);
        if (done?.value !== q.typed) q.reason = `${q.reason} Maverick could not type it in: ${done?.error || 'the box did not take the text'}.`.trim();
      }
    }
    const blocked = await rereadForm();
    if (blocked) { f.state = 'blocked'; f.msg = blocked; return; }
    f.state = 'review';
  } catch (e) {
    f.state = 'failed';
    f.msg = e.name === 'AbortError' ? 'Stopped. Maverick fills no more of the form and submits nothing.' : `${String(e.message).replace(/\.$/, '')}.`;
  } finally {
    egress.delete(count);
    hwCtrl = null;
    renderHomework();
    if (f.state === 'review') { $('#hw-yes')?.focus(); announce('Check the answers in the form. Type yes to submit.'); }
  }
}

// The only way to the form's Submit: a typed yes or the review's Submit button. The form is read again first, so the
// list shows the final answers (hand edits included) and a required upload or question still empty is caught; then
// one click, never a second.
async function submitForm() {
  const f = hwForm;
  if (!f || f.state !== 'review' || !desk) return;
  f.state = 'submitting';
  f.note = '';
  renderHomework();
  try {
    const blocked = await rereadForm();
    if (blocked) { f.state = 'blocked'; f.msg = blocked; return; }
    const needs = formNeeds(f.questions);
    if (needs) { f.state = 'review'; f.note = needs; return; }
    renderHomework();
    const s = await desk.formSubmit();
    f.msg = s?.clicked ? 'Submitted once, with the answers above. Maverick does not submit this form again.'
      : `Nothing was submitted: ${s?.error || 'Maverick found no Submit button'}. Submit it in the form window yourself.`;
  } catch (e) {
    f.msg = `Submitting failed: ${e.message}. Maverick does not try again; check the form window.`;
  } finally {
    if (f.state === 'submitting') f.state = 'submitted';
    renderHomework();
    if (f.state === 'review') $('#hw-yes')?.focus();
    announce(f.state === 'review' ? f.note : f.msg);
  }
}

// One question of the review: what the form holds (or, while filling, what Maverick will put there), the reason with
// its citations, and the working of a calculation. A text answer stays editable here.
function formRowHtml(f, q) {
  const plan = f.state === 'answering' || f.state === 'filling';
  let head = '';
  if (q.kind === 'choice') {
    const picked = plan ? q.picks : q.options.filter((o) => o.checked).map((o) => o.j);
    head = escapeHtml(picked.map((j) => `${LETTERS[j]}) ${q.options[j]?.label ?? ''}`).join(', '));
  } else if (q.kind === 'text' && !plan && f.state !== 'submitted' && f.state !== 'submitting') {
    head = `<textarea class="hw-typed" rows="${q.long ? 4 : 1}" dir="auto" aria-label="The answer typed in for question ${q.i + 1}">${escapeHtml(q.value ?? '')}</textarea>`;
  } else if (q.kind === 'text') head = escapeHtml(plan && !q.kept ? q.typed : q.value ?? '');
  else head = q.files?.length ? `Attached: ${escapeHtml(q.files.join(', '))}` : 'You need to add this photo or file yourself.';
  if (!head && q.kind !== 'upload') head = q.notSure ? 'Not sure: left blank' : f.state === 'answering' ? '' : 'Blank';
  const chips = (md) => { const html = md ? renderMarkdown(md, { bidi: true }) : ''; return q.source === 'material' ? sourceChips(html, q.chunks, lib.files) : urlChips(html); };
  const tags = (q.notSure ? '<span class="tag deep">Not sure</span>' : '') + (q.kind === 'upload' && !q.files?.length ? '<span class="tag deep">You need to add this</span>' : '')
    + (q.required ? '<span class="tag deep">Required</span>' : '') + (q.match ? `<span class="tag deep">Worksheet ${escapeHtml(q.match.n)}</span>` : '');
  return `<li class="answer${q.busy ? ' streaming' : ''}" data-q="${q.i}" aria-busy="${!!q.busy}"><header class="answer-head"><span class="tag">${q.i + 1}</span>${tags}` +
    `<span class="q" dir="auto">${escapeHtml(q.text)}</span>${q.busy ? '<span class="state">Answering</span>' : ''}</header>` +
    `<div class="md">${head ? `<p dir="auto">${q.kind === 'text' && head.startsWith('<textarea') ? head : `<strong>${head}</strong>`}</p>` : q.busy ? SKELETON : ''}` +
    (q.guide ? `<p class="stopped">What to put in it:</p>${chips(q.guide)}` : '') + chips(q.reason) +
    (q.work && isMath(q.text) ? `<details><summary>Working</summary>${renderMarkdown(q.work, { bidi: true })}</details>` : '') + '</div></li>';
}

function formHtml() {
  const f = hwForm;
  const busy = FORM_BUSY[f.state];
  // before yes, what still blocks the submit is said as a heads-up; after a refused yes, as the refusal
  const note = f.note || (f.state === 'review' ? formNeeds(f.questions).replace('Can’t submit yet:', 'Before you submit:') : '');
  const foot = busy ? `<p class="hw-row"><span class="muted">${busy}</span>${f.state === 'submitting' ? '' : '<button type="button" class="btn sm" data-hw="stop"><svg class="i sm"><use href="#i-stop"/></svg><span>Stop</span></button>'}</p>`
    : f.state === 'review' ? '<p class="hw-confirm"><strong>Check the answers in the form. Type yes to submit.</strong></p>' +
      '<p class="hw-row"><input id="hw-yes" autocomplete="off" placeholder="Type yes to submit" aria-label="Type yes to submit the form">' +
      '<button type="button" class="btn primary" data-hw="submit">Submit</button><button type="button" class="btn" data-hw="close-form">Not now</button></p>' +
      (note ? `<p class="stopped hw-note">${escapeHtml(note)}</p>` : '')
      : `<p class="stopped">${escapeHtml(f.msg)}</p><p class="hw-row"><button type="button" class="btn sm" data-hw="close-form">Close</button></p>`;
  return `<section class="hw-form" aria-label="The form"><p class="section-title">Form${f.page ? `: ${escapeHtml(f.page)}` : ''}</p>` +
    `<ol class="hw-items">${f.questions.map((q) => formRowHtml(f, q)).join('')}</ol>${foot}</section>`;
}

const hwBase = (name) => String(name).replace(/\.\w+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'homework';
let hwSaveTimer = null;
$('#btn-homework').addEventListener('click', openHomework);
$('#hw-input').accept = ACCEPT;
$('#hw-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; addWorksheet(f); });
for (const r of $$('input[name="hw-source"]')) {
  r.addEventListener('change', () => { hwSource = r.value === 'web' ? 'web' : 'material'; store(HW_SOURCE_KEY, hwSource); });
}
// A draft edited in place is kept as typed.
$('#dlg-homework').addEventListener('input', (e) => {
  if (!e.target.matches('.hw-edit')) return;
  const ws = hwSheet();
  const it = ws?.items[Number(e.target.closest('[data-i]').dataset.i)];
  if (!it) return;
  it.a = e.target.value;
  clearTimeout(hwSaveTimer);
  hwSaveTimer = setTimeout(() => saveSheet(ws), 400);
});
// A text answer edited in the review goes into the form's box, and the form is read again.
$('#dlg-homework').addEventListener('change', async (e) => {
  if (!e.target.matches('.hw-typed') || hwForm?.state !== 'review' || !desk) return;
  const q = hwForm.questions.find((x) => x.i === Number(e.target.closest('[data-q]').dataset.q));
  if (!q) return;
  const done = await desk.formType(q.i, e.target.value);
  if (done?.error) toast(`Maverick could not type it into the form: ${done.error}`, 'warn');
  await rereadForm().catch((err) => toast(err.message, 'warn'));
  renderHomework();
});
// The review's yes: Enter in its field submits only when the field says yes; anything else submits nothing.
$('#dlg-homework').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('#hw-yes') || !hwForm) return;
  e.preventDefault();
  if (e.target.value.trim().toLowerCase() === 'yes') return submitForm();
  hwForm.note = 'Not submitted. Type yes to submit, or change the answers in the form first.';
  renderHomework();
  $('#hw-yes')?.focus();
});
$('#dlg-homework').addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-hw-tab]');
  if (tab) { hwTab = tab.dataset.hwTab; return renderHomework(); }
  const b = e.target.closest('[data-hw], [data-cmd]');
  if (!b || b.disabled) return;
  const cmd = b.dataset.hw || b.dataset.cmd;
  if (cmd === 'pick' || cmd === 'new') hwTab = 'sheet';
  if (cmd === 'open-form' || cmd === 'fill-form') { hwTab = 'form'; renderHomework(); }
  const ws = hwSheet();
  const it = ws?.items[Number(b.closest('.hw-items > [data-i]')?.dataset.i)];
  if (cmd === 'pick') { hwSel = b.dataset.id; return renderHomework(); }
  if (cmd === 'new') {
    const w = newSheet(`Pasted text, ${new Date().toLocaleDateString()}`);
    hwSheets.unshift(w);
    hwSel = w.id;
    await saveSheet(w);
    renderHomework();
    return $('#hw-text').focus();
  }
  if (cmd === 'stop') return hwCtrl?.abort();
  if (cmd === 'library') return openLibraryDialog();
  if (cmd === 'url') return openUrl(b.dataset.url);
  if (cmd === 'note') return openMemory(b.dataset.note);
  if (cmd === 'src') {
    const q = hwForm?.questions.find((x) => x.i === Number(b.closest('[data-q]')?.dataset.q));
    return openViewer({ chunks: (it ?? q)?.chunks ?? [] }, b.dataset.file, Number(b.dataset.page), claimOf(b));
  }
  if (cmd === 'open-form') return openForm();
  if (cmd === 'fill-form') return fillForm();
  if (cmd === 'submit') return submitForm();
  if (cmd === 'close-form') { if (!hwCtrl) hwForm = null; return renderHomework(); }
  if (!ws) return;
  if (cmd === 'draft') return draftAll(ws);
  if (cmd === 'export') return downloadText(`${hwBase(ws.name)}-answers.md`, homeworkMarkdown(ws));
  if (cmd === 'split') {
    setText(ws, $('#hw-text').value);
    ws.error = ws.items.length ? '' : 'No questions were found. Start each question with its number, like 1. or Q2 or ١.';
    await saveSheet(ws);
    return renderHomework();
  }
  if (cmd === 'del') {
    // asks twice, like Remove in the Library
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      $('span', b).textContent = 'Delete for good';
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; $('span', b).textContent = 'Delete'; } }, 4000);
      return;
    }
    await hwTx('readwrite', (s) => s.delete(ws.id));
    hwSheets = hwSheets.filter((w) => w !== ws);
    hwSel = hwSheets[0]?.id ?? null;
    return renderHomework();
  }
  if (!it) return;
  if (cmd === 'copy') return copyText(it.a, b);
  if (cmd === 'redo') return draftAll(ws, it);
  if (cmd === 'edit') {
    it.editing = !it.editing;
    paintHwItem(ws, it, true); // shown in the click itself; the write follows (it went first and the card lagged behind it)
    if (it.editing) $(`#hw-detail .hw-items > [data-i="${ws.items.indexOf(it)}"] .hw-edit`)?.focus();
    else { clearTimeout(hwSaveTimer); await saveSheet(ws); }
  }
});

// ---------------------------------------------------------------- desktop app (Electron, desktop/preload.cjs)

// Think harder on the latest card, or on a fresh Answer when there is none.
function thinkHarder() {
  if (!deepConf()) return toast('Add a Deep model in Settings to use Think harder.', 'warn');
  const card = answers[0];
  return runAction(card?.action || 'answer', card?.question || '', true);
}

// Start listening: the meeting (screen plus system audio, no picker in the desktop app) and the mic. Stop: both.
async function toggleListen() {
  if (display || mic) {
    if (display) stopStream('meeting');
    if (mic) stopStream('mic');
    return;
  }
  await startShare();
  if (!mic) await toggleMic();
}

const HOTKEY_LABELS = {
  answer: 'Answer', answer2: 'Answer (second key)', explain: 'Explain screen', solve: 'Solve what is on screen', assist: 'Smart assist (Answer, Explain or Solve)', followup: 'Follow-ups', recap: 'Recap',
  deep: 'Think harder', flag: 'Flag this moment', ask: 'Focus the ask field', bar: 'Show or hide the bar', main: 'Open the main window',
};
const BAR_KEYS = { answer: 'answer', explain: 'explain', solve: 'solve', followup: 'followup', recap: 'recap', think: 'deep', flag: 'flag' };
const keyLabel = (accel) => accel.replaceAll('+', ' ');
let deskKeys = {};

// The bar: the pop-out markup in a frameless, transparent, always-on-top window that sizes itself to its content.
function openBar() {
  if (pip) return;
  pip = window.open('about:blank', 'maverick-bar');
  if (!pip) return toast('Could not open the Maverick bar.', 'error');
  mountMini(pip);
  const d = pip.document;
  d.body.classList.add('bar-win');
  if (desk.barMaterial() === 'acrylic') d.body.classList.add('acrylic'); // the window is the slab; see bar.css
  $('.canary', d).innerHTML = CANARY.map((bit) => `<i${bit ? ' class="on"' : ''}></i>`).join(''); // the share check looks for it (main.cjs)
  d.head.append(Object.assign(d.createElement('link'), { rel: 'stylesheet', href: new URL('bar.css', location.href).href }));
  // The bar never takes focus on its own, so a click on a button leaves Teams focused. The ask field asks for it.
  d.addEventListener('pointerdown', (e) => {
    const input = e.target.closest('form.ask')?.querySelector('input');
    if (input) { desk.barFocus(); setTimeout(() => input.focus(), 60); }
  });
  // The body holds the bar and any toasts; the window follows its height (main.cjs caps it).
  new pip.ResizeObserver(() => desk.barSize(d.body.getBoundingClientRect().height)).observe(d.body);
  // Arrow keys nudge the bar, only while the bar itself has the keyboard: 8 px, or 40 px with Shift.
  // In the ask field they still move the caret once there is text. Nothing is registered globally.
  d.addEventListener('keydown', (e) => {
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!dir || e.altKey || e.metaKey || (e.target.tagName === 'INPUT' && e.target.value)) return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 8;
    desk.barMove(dir[0] * step, dir[1] * step);
  });
  pip.addEventListener('pagehide', () => { pip = null; renderControls(); });
  barKeyTips();
  renderControls();
  renderPip();
  renderMiniAlert();
  renderShare();
}

// In a Remote Desktop session the person at the other end sees what the RDP client draws, which hiding on this PC does
// not govern: the badge and a banner say so. A warning only (main.cjs, readRemoteSession).
const REMOTE_NOTE = 'This is a Remote Desktop session: hiding from screen shares is not guaranteed here, because the remote viewer sees this session through the Remote Desktop client.';
function shareTip(r) {
  return [shareTipCheck(r), r?.remote ? REMOTE_NOTE : ''].filter(Boolean).join(' ');
}
function shareTipCheck(r) {
  if (!r) return 'Checking that screen shares cannot see Maverick.';
  const when = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const capture = `a capture of this screen${r.display ? ` (${r.display})` : ''}`;
  if (r.state === 'unknown') return `Not checked at ${when}: ${r.reason}.`;
  if (r.state === 'hidden') return `Hidden from screen shares. At ${when}, ${capture} did not contain the Maverick bar. Checked every 10 seconds.`;
  if (!r.hiding) return `Visible in screen shares: hiding is off. At ${when}, ${r.found ? `${capture} contained the Maverick bar` : 'the bar was checked'}. Turn on “Hide Maverick when I share my screen” in Settings.`;
  if (r.blackBox) return `Visible in screen shares. At ${when}, the bar showed as a black box in ${capture}. This version of Windows cannot hide it.`;
  return `Visible in screen shares. At ${when}, ${capture} contained the Maverick bar, although hiding is on.`;
}
function renderShare() {
  if (!desk) return;
  const state = shareCheck?.state || 'checking';
  for (const [el, short] of [[$('#st-share'), false], [pip && pip !== window && $('.share-badge', pip.document), true]]) {
    if (!el) continue;
    const [icon, label, shortLabel] = SHARE_LOOK[state] || SHARE_LOOK.unknown;
    el.hidden = false;
    el.dataset.state = state;
    $('use', el).setAttribute('href', `#${short && state === 'visible' ? 'i-shield-alert-fill' : icon}`); // the bar's badge is the icon alone (bar.css)
    $('span', el).textContent = short ? shortLabel : label;
    el.dataset.tip = [shareTip(shareCheck), egressNote()].filter(Boolean).join(' ');
  }
}
function onShareCheck(r) {
  if (!r) return;
  if (!!r.remote !== !!shareCheck?.remote) banner('remote', r.remote ? REMOTE_NOTE : ''); // once per change, so a dismissed banner stays dismissed
  const was = shareCheck?.state;
  shareCheck = r;
  renderShare();
  if (was && was !== r.state) announce(r.state === 'hidden' ? 'Maverick is hidden from screen shares.' : r.state === 'visible' ? 'Warning: screen shares can see Maverick.' : 'Maverick could not check screen shares.');
}

// Which key the copy names. The desktop app has global keys (Settings, default Ctrl+Shift+...) that work from any app,
// and Alt 1 to Alt 5 that work only while a Maverick window has focus; the browser has only the Alt keys.
function firstRunKey() {
  const alt = /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? 'Option' : 'Alt';
  return deskKeys.answer
    ? `Press <kbd>${escapeHtml(keyLabel(deskKeys.answer))}</kbd> from any app when someone asks you something, or type a question.`
    : `Press <kbd>${alt} 1</kbd> in this window when someone asks you something, or type a question.`;
}

// In the main window, say which keys are global and which work only in the window.
function mainKeyCopy() {
  const keys = $('.keys');
  if (!keys || !deskKeys.answer) return;
  // one line in the gutter: the global answer key first, then the in-window keys (all global keys are in Settings)
  keys.innerHTML = `<kbd>${escapeHtml(keyLabel(deskKeys.answer))}</kbd> answers from any app. `
    + 'Here: <kbd>Alt 1</kbd> to <kbd>Alt 4</kbd> run actions, <kbd>Esc</kbd> stops.';
  for (const b of $$('.actions .act')) {
    const n = { answer: 1, explain: 2, followup: 3, recap: 4 }[b.dataset.action];
    const accel = deskKeys[b.dataset.action];
    b.dataset.tip = `${b.textContent.trim()} (Alt ${n} in this window${accel ? `, ${keyLabel(accel)} from any app` : ''})`;
  }
}

// The bar's tooltips show the global hotkeys instead of the in-window Alt keys.
function barKeyTips() {
  mainKeyCopy();
  if (!pip || pip === window) return;
  for (const b of $$('.bar-acts .ib', pip.document)) {
    const tip = $('.tip', b);
    const accel = deskKeys[BAR_KEYS[b.dataset.action || b.dataset.cmd]];
    // aria-keyshortcuts: the in-window Alt key from the markup, if any, then the global hotkey
    b.dataset.altKeys ??= b.getAttribute('aria-keyshortcuts') || '';
    const keys = [b.dataset.altKeys, accel?.replace(/\bCtrl\b/, 'Control')].filter(Boolean).join(' ');
    if (keys) b.setAttribute('aria-keyshortcuts', keys);
    else b.removeAttribute('aria-keyshortcuts');
    if (!tip) continue;
    let kbd = $('kbd', tip);
    if (!accel) kbd?.remove();
    else {
      if (!kbd) { kbd = pip.document.createElement('kbd'); tip.append(kbd); }
      kbd.textContent = keyLabel(accel);
    }
  }
}

function hotkeyBanner(failed) {
  banner('hotkeys', failed.length
    ? `These hotkeys could not be registered, probably because another app uses them: ${failed.map((f) => `${HOTKEY_LABELS[f.name] || f.name} (${keyLabel(f.accel)})`).join(', ')}. Pick other keys in Settings.`
    : '', 'warn', { action: { label: 'Settings', run: openSettings } });
}

// A pressed combination becomes an Electron accelerator, like Ctrl+Shift+1. Keys already taken by
// Maverick fire their action instead of reaching the field; type those by hand.
function accelFrom(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
  const key = named[e.key] || (e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Key') ? e.code.slice(3) : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d{1,2}$/.test(key)) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
}

async function fillDeskSettings() {
  const s = await desk.settings();
  $('#hotkey-fields').innerHTML = Object.keys(s.defaults).map((name) => `<label><span>${escapeHtml(HOTKEY_LABELS[name] || name)}</span>
    <span class="field keycap"><input name="hk.${name}" data-hotkey autocomplete="off" spellcheck="false" placeholder="${escapeHtml(s.defaults[name])}" aria-describedby="err-hk.${name}"><span class="caps" aria-hidden="true"></span></span>
    <small id="err-hk.${name}" class="field-msg">${s.failed.some((f) => f.name === name) ? 'Not registered: another app may use it.' : ''}</small></label>`).join('');
  for (const [name, accel] of Object.entries(s.keys)) form.elements[`hk.${name}`].value = accel;
  for (const i of $$('[data-hotkey]', form)) paintCaps(i);
  const sel = $('#set-source');
  const names = await desk.sources().catch(() => []);
  if (s.source && !names.includes(s.source)) names.unshift(s.source);
  sel.innerHTML = '<option value="">Primary screen</option>' + names.map((n) => `<option>${escapeHtml(n)}</option>`).join('');
  sel.value = s.source;
  $('#set-hide-share').checked = s.hideFromShare;
  $('#set-hide-tray').checked = s.hideTray;
  syncHideTray();
  // Recording: the picture can come from any screen or window, chosen here rather than in a system picker.
  $('#set-record').value = s.recordMode;
  const all = await desk.sources(true).catch(() => []);
  if (s.recordSource && !all.includes(s.recordSource)) all.unshift(s.recordSource);
  $('#set-record-source').innerHTML = '<option value="">Primary screen</option>' + all.map((n) => `<option>${escapeHtml(n)}</option>`).join('');
  $('#set-record-source').value = s.recordSource;
  $('#record-dir-note').textContent = s.recordDir;
  $('#vault-note').textContent = s.vault;
  syncRecord();
}
// A hotkey shows as key caps over its field; focused, the field shows the plain text it holds.
function paintCaps(input) {
  const caps = input.nextElementSibling;
  if (caps?.classList.contains('caps')) caps.innerHTML = input.value ? input.value.split('+').map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('') : '';
}
const syncRecord = () => { $('#set-record-source').disabled = $('#set-record').value !== 'screen'; };

// The tray option only matters while Maverick hides; its note names the keys that bring Maverick back without the icon.
function syncHideTray() {
  $('#set-hide-tray').disabled = !$('#set-hide-share').checked;
  const k = (name) => keyLabel($(`[name="hk.${name}"]`, form)?.value || deskKeys[name] || '');
  $('#hide-tray-note').textContent = `Without it, ${k('answer')} brings the bar back and ${k('main')} opens this window.`;
}

async function saveDeskSettings() {
  const keys = Object.fromEntries($$('[data-hotkey]', form).map((i) => [i.name.slice(3), i.value.trim()]));
  const { failed } = await desk.saveSettings({
    keys, source: $('#set-source').value, hideFromShare: $('#set-hide-share').checked, hideTray: $('#set-hide-tray').checked,
    recordMode: $('#set-record').value, recordSource: $('#set-record-source').value,
  });
  syncHideTray();
  deskKeys = keys;
  hotkeyBanner(failed);
  barKeyTips();
}

if (desk) {
  document.documentElement.classList.add('desktop');
  for (const t of $$('#tab-desktop, #tab-hotkeys')) t.hidden = false;
  $('#web-share-note').hidden = true;
  $('#set-hide-share').addEventListener('change', syncHideTray);
  $('#set-record').addEventListener('change', syncRecord);
  $('#set-record-dir').addEventListener('click', async () => {
    const dir = await desk.pickRecordDir();
    if (dir) $('#record-dir-note').textContent = dir;
  });
  $('#set-vault').addEventListener('click', async () => {
    const err = await desk.memoryOpen().catch((e) => e.message);
    if (err) toast(`The vault folder could not be opened: ${err}`, 'warn');
  });
  $('#btn-memory').hidden = false;
  $('#btn-memory').addEventListener('click', () => openMemory());
  loadMemory().catch(() => {}); // so a homework draft kept from before shows its meeting citations as chips
  form.addEventListener('input', (e) => { if (e.target.matches?.('[data-hotkey]')) { paintCaps(e.target); syncHideTray(); } });
  // No picker here: Share meeting takes the screen and everything this PC plays.
  $('#screen-empty .idle p').textContent = 'Not listening. Share captures this screen and all sound the PC plays.';
  $('[data-step="share"] small').textContent = 'Captures the screen and all sound this PC plays. No picker.';
  $('#btn-share').dataset.tip = 'Capture the screen and system audio';
  desk.onAction((a) => {
    if (a === 'listen') return toggleListen();
    if (a === 'bar') return openBar();
    if (!pip) openBar();
    if (a === 'ask') return $('form.ask input', pip.document)?.focus();
    if (a === 'deep') return thinkHarder();
    if (a === 'solve') return runAction('solve');
    if (a === 'assist') return smartAssist();
    if (Object.values(HOTKEYS).includes(a)) trigger(a);
  });
  desk.onNotice((msg) => toast(msg, 'warn'));
  desk.onShareCheck(onShareCheck);
  renderShare();
  desk.checkShare().then(onShareCheck);
  // MAVERICK_TEST_HOOKS only: test/feature-proof.mjs adds a line the way a finished transcription does.
  // test/copilot-proof.mjs and test/screenread-proof.mjs also read the slide tracker, the screen reads and the last prompt.
  if (desk.test) {
    // test/acceptance-fixes-proof.mjs: a line at a meeting time (at, ms), a meeting that began msAgo, a flag pressed
    // now, a WAV played into the meeting audio path (VAD, gates, transcription), and a meeting dropped unsaved.
    window.maverickTest = {
      addLine: (who, text, at) => { const l = addLine(who, text, at == null || !meeting ? Date.now() : meeting.startedAt + at); if (l) sideCheck(l, meeting, null); return !!l; },
      backdate: (msAgo) => { startMeeting(); meeting.startedAt = Date.now() - msAgo; renderTranscript(); return meeting.startedAt; },
      flag: () => { flagMoment(); return meeting?.flags.at(-1) - meeting?.startedAt; },
      playMeeting: async (b64) => {
        await audioGraph();
        const buf = await ac.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
        const dest = ac.createMediaStreamDestination();
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        startMeeting();
        await attach('meeting', dest.stream);
        await new Promise((r) => { src.onended = r; src.start(); });
        await sleep(1000);
        stopStream('meeting');
        await queue;
        return meeting.transcript.map((l) => l.text);
      },
      discard: () => { meeting = null; localStorage.removeItem(LIVE_KEY); renderTranscript(); renderControls(); return 1; },
      // patch: settings, with { connections: { id: fields }, roles: { role: { conn, model } } } merged into the saved ones
      useSettings: (patch) => {
        const { connections = {}, roles = {}, ...rest } = patch;
        storeSettings({
          ...settings, ...rest,
          connections: settings.connections.map((c) => ({ ...c, ...(connections[c.id] || {}) })),
          roles: Object.fromEntries(Object.entries(settings.roles).map(([r, v]) => [r, { ...v, ...(roles[r] || {}) }])),
        });
        settings = loadSettings();
        return 1;
      },
      markRemote: (host) => { remoteForTest.add(host); return 1; }, // test/models-proof.mjs: count a local mock as off this PC
      settings: () => settings,
      slides: () => ({ ...slides }), view: () => ({ ...view }), screens: () => meeting?.screens ?? [], lines: () => meeting?.transcript ?? [], lastPrompt: null, raw: [],
      homework: () => ({ sheets: hwSheets, form: hwForm }), // test/homework-proof.mjs
      memory: () => ({ notes: memNotes, ask: memAsk }), // test/memory-proof.mjs
    };
  }
  setInterval(() => desk.state({ listening: !!(display || mic), busy: !!active }), 500);
  $('#hotkey-fields').addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-hotkey]');
    if (!input || e.key === 'Tab') return;
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); input.value = ''; paintCaps(input); autoApply(); return; }
    const accel = accelFrom(e);
    if (!accel) return;
    e.preventDefault();
    input.value = accel;
    paintCaps(input);
    validateField(input);
    autoApply();
  });
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const bad = $$('[data-hotkey]', form).filter((i) => !validateField(i));
    if (bad.length) { e.preventDefault(); revealField(bad[0]).focus(); }
  });
  desk.settings().then((s) => { deskKeys = s.keys; hotkeyBanner(s.failed); openBar(); barKeyTips(); });
}
