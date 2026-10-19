// Provider layer. One interface for every backend:
//   streamChat(messages, { images, audio, temperature, signal }, conf) -> async iterator of text chunks
// messages: [{ role: 'system'|'user'|'assistant', content: string }]
// images: base64 JPEG strings, audio: base64 WAV strings (attached to the last user message)
// conf: { id, ...that provider's settings fields, token, server }
// Each provider is a pure build() (request) plus a pure parse() (one stream line -> text | null, throws on error).

import { TRANSCRIBE_PROMPT } from './prompts.mjs';

const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
const systemText = (msgs) => msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
const withoutSystem = (msgs) => msgs.filter((m) => m.role !== 'system');
const lastUser = (msgs) => msgs.map((m) => m.role).lastIndexOf('user');
const json = { 'content-type': 'application/json' };
const temp = (t, key = 'temperature') => (t === undefined ? {} : { [key]: t });
export const OLLAMA_CTX = 16384;
export const PUBLIK_PROXY = '/bridge/publik/v1'; // serve.mjs, publikProxy
// The tier each role starts with on the publik connection (defaultModel): a tier, never a vendor model name.
export const PUBLIK_MODELS = { live: 'publik-fast', deep: 'publik-smart', vision: 'publik-balanced', transcribe: 'publik-fast', web: '' };

// SSE "data:" payload as JSON, or null for comments, blanks, event lines and [DONE].
export function sseData(line) {
  if (!line.startsWith('data:')) return null;
  const d = line.slice(5).trim();
  return !d || d === '[DONE]' ? null : JSON.parse(d);
}

function needKey(c, label) {
  if (!c.key) throw new Error(`Add your ${label} API key in Settings.`);
}

function noAudio(audio, label) {
  if (audio.length) throw new Error(`${label} cannot take audio. Pick an audio-capable transcription provider in Settings.`);
}

// Bridge stream (served by serve.mjs): data: {"text"} | {"error"} | {"done"}
function parseBridge(line) {
  const j = sseData(line);
  if (!j) return null;
  if (j.error) throw new Error(j.error);
  return j.text || null;
}

export const PROVIDERS = {
  ollama: {
    label: 'Ollama (local)',
    audio: true,
    note: 'Runs on this computer. gemma4 understands audio and images. A Reasoning model here is slower: it swaps the live model out of GPU memory while it runs, and unloads right after.',
    fields: [
      { key: 'url', label: 'Ollama URL', value: 'http://127.0.0.1:11434' },
      { key: 'model', label: 'Live model', value: 'gemma4:12b' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: 'qwen3.8:27b' },
    ],
    build(messages, { images = [], audio = [], temperature, maxTokens }, c) {
      const last = lastUser(messages);
      const media = [...images, ...audio]; // Ollama takes audio in the same images array
      return {
        url: `${trimUrl(c.url)}/api/chat`,
        headers: json,
        body: {
          model: c.model,
          stream: true,
          think: false,
          // A long transcript plus a screen frame overflows Ollama's small default context, and the
          // model would otherwise unload after 5 idle minutes and make the next answer slow.
          keep_alive: c.keepAlive ?? '1h', // the deep model passes 0 and unloads after each answer
          options: { num_ctx: OLLAMA_CTX, ...temp(temperature), ...temp(maxTokens, 'num_predict') },
          messages: messages.map((m, i) => (i === last && media.length ? { ...m, images: media } : m)),
        },
      };
    },
    parse(line) {
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      return j.message?.content || null;
    },
  },

  openai: {
    label: 'OpenAI-compatible',
    audio: true,
    note: 'Any /chat/completions server: OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp. Audio needs a model that accepts input_audio.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', value: 'https://api.openai.com/v1' },
      { key: 'key', label: 'API key (blank for local servers)', value: '', type: 'password' },
      { key: 'model', label: 'Live model', value: 'gpt-4o-mini' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: '', placeholder: 'gpt-5' },
    ],
    build(messages, { images = [], audio = [], temperature, maxTokens }, c) {
      const last = lastUser(messages);
      const rich = (m) => ({
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } })),
          ...audio.map((b) => ({ type: 'input_audio', input_audio: { data: b, format: 'wav' } })),
        ],
      });
      return {
        url: `${trimUrl(c.baseUrl)}/chat/completions`,
        headers: { ...json, ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
        body: {
          model: c.model,
          stream: true,
          ...temp(temperature),
          ...temp(maxTokens, 'max_tokens'),
          messages: messages.map((m, i) => (i === last && (images.length || audio.length) ? rich(m) : m)),
        },
      };
    },
    parse(line) {
      const j = sseData(line);
      if (!j) return null;
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.choices?.[0]?.delta?.content || null;
    },
  },

  anthropic: {
    label: 'Anthropic API',
    audio: false,
    note: 'Key stays in this browser and goes straight to api.anthropic.com.',
    fields: [
      { key: 'key', label: 'API key', value: '', type: 'password' },
      { key: 'model', label: 'Live model', value: 'claude-sonnet-5' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: '', placeholder: 'claude-opus-5' },
    ],
    build(messages, { images = [], audio = [], temperature }, c) {
      noAudio(audio, 'The Anthropic API');
      needKey(c, 'Anthropic');
      const msgs = withoutSystem(messages);
      const last = lastUser(msgs);
      const system = systemText(messages);
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          ...json,
          'x-api-key': c.key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: {
          model: c.model,
          max_tokens: 2048,
          stream: true,
          ...temp(temperature),
          ...(system ? { system } : {}),
          messages: msgs.map((m, i) => (i === last && images.length
            ? { role: m.role, content: [
              ...images.map((b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } })),
              { type: 'text', text: m.content },
            ] }
            : m)),
        },
      };
    },
    parse(line) {
      const j = sseData(line);
      if (!j) return null;
      if (j.type === 'error') throw new Error(j.error?.message || 'Anthropic stream error');
      return j.type === 'content_block_delta' && j.delta?.type === 'text_delta' ? j.delta.text : null;
    },
  },

  gemini: {
    label: 'Google Gemini',
    audio: true,
    note: 'Key stays in this browser and goes straight to generativelanguage.googleapis.com.',
    fields: [
      { key: 'key', label: 'API key', value: '', type: 'password' },
      { key: 'model', label: 'Live model', value: 'gemini-2.5-flash' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: '', placeholder: 'gemini-2.5-pro' },
    ],
    build(messages, { images = [], audio = [], temperature, maxTokens }, c) {
      needKey(c, 'Gemini');
      const msgs = withoutSystem(messages);
      const last = lastUser(msgs);
      const system = systemText(messages);
      const inline = (mime) => (data) => ({ inline_data: { mime_type: mime, data } });
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:streamGenerateContent?alt=sse`,
        headers: { ...json, 'x-goog-api-key': c.key },
        body: {
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          ...(temperature === undefined && maxTokens === undefined ? {} : { generationConfig: { ...temp(temperature), ...temp(maxTokens, 'maxOutputTokens') } }),
          contents: msgs.map((m, i) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [
              { text: m.content },
              ...(i === last ? [...images.map(inline('image/jpeg')), ...audio.map(inline('audio/wav'))] : []),
            ],
          })),
        },
      };
    },
    parse(line) {
      const j = sseData(line);
      if (!j) return null;
      if (j.error) throw new Error(j.error.message || 'Gemini stream error');
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || null;
    },
  },

  // publik API (https://publikhq.com/developers): the OpenAI-compatible adapter above, pointed at serve.mjs's
  // /bridge/publik/v1 proxy, which adds the key in Node. So there is no key field, and the page never holds one.
  publik: {
    label: 'publik API',
    audio: true,
    note: 'No key to paste: priced per use in dollars from a publik balance. Prompts go through publik’s servers to the model. The key stays in the desktop app, never in this page.',
    fields: [
      { key: 'model', label: 'Live model', value: 'publik-fast' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: 'publik-smart' },
    ],
    build(messages, opts, c) {
      const req = PROVIDERS.openai.build(messages, opts, { ...c, baseUrl: `${c.server || ''}${PUBLIK_PROXY}`, key: '' });
      return { ...req, headers: { ...req.headers, 'x-cue-token': c.token || '' } };
    },
    parse: (line) => PROVIDERS.openai.parse(line),
  },

  claudecode: {
    label: 'Local CLI agent (Claude Code)',
    audio: false,
    bridge: true,
    web: true, // the only type that searches the web (build, web)
    note: 'Uses the claude CLI you are logged in to on this computer, through the Maverick server. No API key. Slower to start than an API. Sources, Web also answers through it, with web search.',
    fields: [
      { key: 'model', label: 'Live model (blank = the CLI default)', value: '', placeholder: 'sonnet, haiku' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: '', placeholder: 'opus' },
    ],
    // web: Sources, Web. The server then gives the CLI web search and fetch instead of Read (serve.mjs, claudeSpec).
    build(messages, { images = [], audio = [], web = false }, c) {
      noAudio(audio, 'Claude Code');
      return {
        url: `${c.server || ''}/bridge/claude`,
        headers: { ...json, 'x-cue-token': c.token || '' },
        body: { messages, images, model: c.model || '', ...(web ? { web: true } : {}) },
      };
    },
    parse: parseBridge,
  },

  cli: {
    label: 'CLI agent (bridge)',
    audio: false,
    bridge: true,
    note: 'Runs a command-line agent on this computer through the Maverick server. The prompt goes to stdin. Its arguments are set in maverick.config.json; the model fills {model} there.',
    fields: [
      { key: 'command', label: 'Command on PATH', value: 'gemini', placeholder: 'gemini, codex' },
      { key: 'model', label: 'Live model (blank = the CLI default)', value: '', placeholder: 'gemini-2.5-flash' },
      { key: 'deepModel', label: 'Deep model (blank = none)', value: '', placeholder: 'gemini-2.5-pro' },
    ],
    build(messages, { images = [], audio = [] }, c) {
      noAudio(audio, 'A CLI agent');
      return {
        url: `${c.server || ''}/bridge/cli`,
        headers: { ...json, 'x-cue-token': c.token || '' },
        body: { command: c.command || '', model: c.model || '', messages, images },
      };
    },
    parse: parseBridge,
  },
};

// ---- connections and roles
// A connection is one saved backend: { id, name, type (a PROVIDERS id), preset (OpenAI-compatible only), and that type's
// fields except the models }. Several can share a type, each with its own key. A role is one task: { conn, model }.
// The request conf of a role is { id: type, ...the connection's fields, model }, what streamChat has always taken.
export const PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', images: false, audio: false, model: 'deepseek-chat', deepModel: 'deepseek-reasoner' }, // a text-only API
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  xai: { label: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  together: { label: 'Together', baseUrl: 'https://api.together.xyz/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  custom: { label: 'Custom', baseUrl: '' },
};
export const presetOf = (baseUrl) => Object.keys(PRESETS).find((k) => k !== 'custom' && PRESETS[k].baseUrl === trimUrl(baseUrl)) || 'custom';

// need: what the connection must do for the role (can, below)
export const ROLES = {
  live: { label: 'Live answers', need: 'chat' },
  deep: { label: 'Reasoning', need: 'chat' },
  vision: { label: 'Vision', need: 'images' },
  transcribe: { label: 'Transcription', need: 'audio' },
  web: { label: 'Web', need: 'web' },
};

export const connFields = (type) => PROVIDERS[type].fields.filter((f) => f.key !== 'model' && f.key !== 'deepModel');
const fieldDefaults = (type) => Object.fromEntries(PROVIDERS[type].fields.map((f) => [f.key, f.value]));

// Every type takes images (for Ollama and OpenAI-compatible servers, if the model does), unless its preset says not.
export function can(c, need) {
  const p = PROVIDERS[c?.type];
  if (!p) return false;
  const preset = c.type === 'openai' ? PRESETS[c.preset] : null;
  if (need === 'audio') return p.audio && preset?.audio !== false;
  if (need === 'images') return preset?.images !== false;
  if (need === 'web') return !!p.web;
  return true;
}
export function roleError(role, c) {
  if (!c) return 'Pick a connection.';
  if (can(c, ROLES[role].need)) return '';
  return {
    images: `${c.name} cannot read images. Pick a connection that can.`,
    audio: `${c.name} cannot take audio. Pick an audio-capable connection.`,
    web: `${c.name} cannot search the web. Pick a Claude Code connection.`,
  }[ROLES[role].need];
}

// A connection on this PC: Ollama or an OpenAI-compatible server (LM Studio, say) on localhost. Takes a connection or a conf.
export function isLocalConn(c) {
  const type = c?.type ?? c?.id;
  const u = type === 'ollama' ? c.url : type === 'openai' ? c.baseUrl : '';
  return !!u && isLocalHost(u);
}

// Settings saved before connections ({ provider, transcriber, providers: { type: fields } }), or none (a fresh install).
// One connection per type in use, plus Ollama and Claude Code (Vision and Web ran on them) and any type with a saved key.
// Vision gets Ollama: the screen reads and the Library and Homework reads ran there.
export function migrateModels(s = {}) {
  const old = Object.fromEntries(Object.keys(PROVIDERS).map((t) => [t, { ...fieldDefaults(t), ...(s.providers?.[t] || {}) }]));
  const provider = PROVIDERS[s.provider] ? s.provider : 'ollama';
  const transcriber = PROVIDERS[s.transcriber]?.audio ? s.transcriber : 'ollama';
  const keep = new Set(['ollama', 'claudecode', provider, transcriber]);
  const connections = Object.keys(PROVIDERS).filter((t) => keep.has(t) || old[t].key).map((t) => {
    const c = { id: t, name: PROVIDERS[t].label, type: t, ...Object.fromEntries(connFields(t).map((f) => [f.key, old[t][f.key] ?? ''])) };
    if (t !== 'openai') return c;
    const preset = presetOf(c.baseUrl);
    return { ...c, preset, name: preset === 'custom' ? c.name : PRESETS[preset].label };
  });
  return {
    connections,
    roles: {
      live: { conn: provider, model: old[provider].model },
      deep: { conn: provider, model: old[provider].deepModel },
      vision: { conn: 'ollama', model: old.ollama.model },
      transcribe: { conn: transcriber, model: old[transcriber].model },
      web: { conn: 'claudecode', model: '' },
    },
  };
}

// { connections, roles } from saved settings of either shape. A role missing from them gets the fresh install's.
export function loadModels(s = {}) {
  if (!Array.isArray(s.connections)) return migrateModels(s);
  const connections = s.connections.filter((c) => c && PROVIDERS[c.type] && typeof c.id === 'string' && c.id)
    .map((c) => ({ ...Object.fromEntries(connFields(c.type).map((f) => [f.key, f.value])), ...c, name: String(c.name || PROVIDERS[c.type].label) }));
  const fresh = migrateModels().roles;
  const roles = Object.fromEntries(Object.keys(ROLES).map((r) => [r, { ...fresh[r], ...(s.roles?.[r] || {}) }]));
  return { connections, roles };
}

// The model a role starts with when it is moved to connection c: the preset's (DeepSeek), else the type's (Reasoning:
// its deep model, which may be blank). An OpenAI-compatible preset with no models of its own starts blank, with the
// type's placeholder; OpenAI itself keeps the type's.
export function defaultModel(c, role) {
  const key = role === 'deep' ? 'deepModel' : 'model';
  if (c?.type === 'publik') return PUBLIK_MODELS[role] ?? '';
  if (c?.type === 'openai' && c.preset !== 'openai') return PRESETS[c.preset]?.[key] ?? '';
  return PROVIDERS[c?.type]?.fields.find((f) => f.key === key)?.value ?? '';
}

// API keys at rest. seal(text) -> sealed text, or null where nothing can encrypt (the browser build: keys stay as they
// were); open(sealed) -> text, or null when it cannot be read (another Windows user): that key is then blank.
export const SEALED = 'safe:';
export const sealKeys = (conns, seal) => conns.map((c) => {
  if (!c.key || c.key.startsWith(SEALED)) return c;
  const s = seal(c.key);
  return s ? { ...c, key: SEALED + s } : c;
});
export const openKeys = (conns, open) => conns.map((c) => (c.key?.startsWith(SEALED) ? { ...c, key: open(c.key.slice(SEALED.length)) ?? '' } : c));

export function roleConf(m, role) {
  const r = m.roles[role];
  const c = m.connections.find((x) => x.id === r?.conn);
  if (!c) throw new Error(`Pick a connection for ${ROLES[role].label} in Settings.`);
  const { id, name, type, preset, ...fields } = c;
  return { ...fields, id: type, conn: id, name, model: r.model, sees: can(c, 'images') };
}

export async function* readLines(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

function unreachable(conf) {
  const p = PROVIDERS[conf.id];
  if (conf.id === 'ollama') return `Can’t reach Ollama at ${conf.url}. Start it with “ollama serve” and try again.`;
  if (p.bridge) return 'Can’t reach the Maverick server. Is “node serve.mjs” still running?';
  return `Can’t reach ${p.label}. Check the URL and your connection (some servers also block browser requests).`;
}

// A publik 402 shows error.message plus exactly one link, error.top_up_url, and only an https publikhq.com one
// (desktop/publik.cjs, topUpUrlFrom402). The link rides at the end of the error text; splitTopUp takes it back out.
const TOP_UP = '\nTop up: ';
function topUp402(text) {
  let e = null;
  try { e = JSON.parse(text)?.error; } catch { /* not JSON */ }
  let url = null;
  try { const u = new URL(e?.top_up_url); if (u.protocol === 'https:' && u.hostname === 'publikhq.com') url = u.href; } catch { /* no link */ }
  return { message: typeof e?.message === 'string' ? e.message : 'Not enough publik API balance.', url };
}
export function splitTopUp(msg) {
  const i = String(msg).lastIndexOf(TOP_UP);
  return i < 0 ? { message: String(msg), url: null } : { message: msg.slice(0, i), url: msg.slice(i + TOP_UP.length) };
}

async function httpError(res, conf) {
  const p = PROVIDERS[conf.id];
  const body = await res.text().catch(() => '');
  let msg = body;
  try { const j = JSON.parse(body); msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || body; } catch { /* plain text */ }
  if (conf.id === 'ollama' && res.status === 404) return `Model "${conf.model}" is not installed in Ollama. Run: ollama pull ${conf.model}`;
  if (p.bridge && res.status === 403) return 'The Maverick server rejected this page. Reload it and try again.';
  if (conf.id === 'publik') {
    if (res.status !== 402) return `publik API error ${res.status}: ${String(msg).slice(0, 300)}`;
    const t = topUp402(body);
    return t.url ? `${t.message}${TOP_UP}${t.url}` : t.message;
  }
  if (res.status === 401 || res.status === 403) return `${p.label} rejected the API key (HTTP ${res.status}).`;
  return `${p.label} error ${res.status}: ${String(msg).slice(0, 300)}`;
}

// ---- bytes sent off this PC
// Counted where each request leaves, from the exact bytes handed to fetch: the body (UTF-8) and the header lines. A
// request leaves this PC when its host is not this PC; the Claude Code and CLI bridges run on this PC but hand the whole
// request to an agent that sends it to its cloud, so they count too (a CLI running "ollama" stays here). Listeners get
// (bytes, url) for every request that leaves; nothing is counted for local ones.
// shortcut: TLS and HTTP framing, and what a CLI agent adds to the prompt, are not in the count; the payload is.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const remoteForTest = new Set(); // host:port pairs a test counts as off this PC (test/models-proof.mjs); empty otherwise
export function isLocalHost(url) {
  try { const u = new URL(url, 'http://127.0.0.1/'); return LOCAL_HOSTS.has(u.hostname) && !remoteForTest.has(u.host); } catch { return false; }
}
export function leavesPc(conf, url) {
  if (conf?.id === 'claudecode' || conf?.id === 'publik') return true; // publik: the local proxy forwards it to publikhq.com
  if (conf?.id === 'cli') return String(conf.command || '').toLowerCase() !== 'ollama';
  return !isLocalHost(url);
}
export function requestBytes(body = '', headers = {}) {
  const enc = new TextEncoder();
  const n = typeof body === 'number' ? body : enc.encode(typeof body === 'string' ? body : '').length; // a number: a binary body's size
  return n + Object.entries(headers).reduce((n, [k, v]) => n + enc.encode(`${k}: ${v}\r\n`).length, 0);
}
export const egress = new Set(); // listeners
export function countSend(url, body, headers, conf = null) {
  if (!(conf ? leavesPc(conf, url) : !isLocalHost(url))) return 0;
  const n = requestBytes(body, headers);
  for (const fn of egress) fn(n, url);
  return n;
}

export async function* streamChat(messages, opts = {}, conf) {
  const p = PROVIDERS[conf?.id];
  if (!p) throw new Error(`Unknown provider: ${conf?.id}`);
  const req = p.build(messages, opts, conf);
  const body = JSON.stringify(req.body);
  let res;
  try {
    countSend(req.url, body, req.headers, conf);
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body, signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(unreachable(conf));
  }
  if (!res.ok) throw new Error(await httpError(res, conf));
  for await (const line of readLines(res.body)) {
    const text = p.parse(line);
    if (text) yield text;
  }
}

// A stream that must write its first word within ms, or fail saying so: a deep model that cannot load (the GPU is
// full) would otherwise keep the notes waiting for minutes. run(signal) starts it; signal is the caller's Stop, which
// still ends it as an AbortError.
export async function* firstTokenWithin(ms, run, signal) {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), ms);
  try {
    for await (const t of run(signal ? AbortSignal.any([signal, late.signal]) : late.signal)) { clearTimeout(timer); yield t; }
  } catch (e) {
    if (late.signal.aborted && !signal?.aborted) throw new Error(`it did not start writing within ${Math.round(ms / 1000)} s`);
    throw e;
  } finally { clearTimeout(timer); }
}

// Loads a model with the same context size the live requests use (a different num_ctx would reload it again).
// /api/generate with no prompt only loads the model and returns.
export function ollamaWarm(c) {
  return { url: `${trimUrl(c.url)}/api/generate`, headers: json, body: { model: c.model, keep_alive: '1h', options: { num_ctx: OLLAMA_CTX } } };
}

// 30 s of speech is under 150 tokens; the cap stops a model that runs on instead of ending.
export const TRANSCRIBE_MAX_TOKENS = 400;
export async function transcribe(wavBase64, conf, signal, prompt = TRANSCRIBE_PROMPT) {
  // publik: its speech-to-text endpoint, POST /audio/transcriptions (https://publikhq.com/developers), not audio through chat.
  // A plain transcript, which parseTurns reads as one turn per line; the prompt is for chat models and is not sent.
  if (conf?.id === 'publik') {
    const bytes = Uint8Array.from(atob(wavBase64), (ch) => ch.charCodeAt(0));
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', conf.model || PUBLIK_MODELS.transcribe);
    return (await publikPost(conf, 'audio/transcriptions', form, bytes.length, signal)).text || '';
  }
  let text = '';
  for await (const t of streamChat([{ role: 'user', content: prompt }], { audio: [wavBase64], temperature: 0, maxTokens: TRANSCRIBE_MAX_TOKENS, signal }, conf)) text += t;
  return text;
}

// One JSON request through the publik proxy (transcription, embeddings). size: the body's bytes, for the egress count.
async function publikPost(conf, endpoint, body, size, signal) {
  const url = `${conf.server || ''}${PUBLIK_PROXY}/${endpoint}`;
  const headers = { 'x-cue-token': conf.token || '', ...(typeof body === 'string' ? json : {}) };
  let res;
  try {
    countSend(url, size, headers, conf);
    res = await fetch(url, { method: 'POST', headers, body, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(unreachable(conf));
  }
  if (!res.ok) throw new Error(await httpError(res, conf));
  return res.json();
}

// Library search vectors through publik, POST /embeddings (https://publikhq.com/developers), OpenAI's request and reply shape.
export async function embedPublik(texts, conf, signal) {
  const body = JSON.stringify({ model: PUBLIK_MODELS.live, input: texts });
  const j = await publikPost(conf, 'embeddings', body, new TextEncoder().encode(body).length, signal);
  return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---- Server-side helpers for the CLI bridges (pure, imported by serve.mjs) ----

export function formatForCli(messages, imagePaths = []) {
  const parts = messages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content));
  if (imagePaths.length) {
    parts.push(`Screenshots of the shared meeting screen are saved here. Read them before answering:\n${imagePaths.join('\n')}`);
  }
  parts.push('Reply with the answer only. Do not edit files or run commands.');
  return parts.join('\n\n');
}

// argv for `claude -p`: read only, confined to its temp dir (--restricted), no MCP, no saved session. Web (Sources,
// Web) swaps Read for web search and fetch and nothing else; --restricted keeps WebFetch only because --tools names it.
export function claudeArgs(model = '', web = false) {
  const tools = web ? 'WebSearch,WebFetch' : 'Read';
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
    '--restricted', '--strict-mcp-config', '--tools', tools, '--allowedTools', tools, ...(model ? ['--model', model] : [])];
}

// One line of `claude -p --output-format stream-json --include-partial-messages`.
export function parseClaudeLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type === 'stream_event' && !j.parent_tool_use_id && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
    return { text: j.event.delta.text };
  }
  if (j.type === 'result' && j.is_error) return { error: String(j.result || j.subtype || 'Claude Code failed') };
  return null;
}

// argv from a server-side template in maverick.config.json. Only {model} is filled, from a checked model name;
// with no model, the {model} argument and the flag right before it are dropped. The prompt always goes to stdin.
export const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/; // no leading dash: a model is never read as a flag
export function buildCliArgs(template, model) {
  const m = String(model || '').trim();
  if (m && !CLI_MODEL.test(m)) throw new Error(`Bad model name "${m.slice(0, 40)}". Start with a letter or number; then letters, numbers, dots, colons and dashes.`);
  const out = [];
  for (const a of template) {
    if (!a.includes('{model}')) out.push(a);
    else if (m) out.push(a.replaceAll('{model}', m));
    else if (out.at(-1)?.startsWith('-')) out.pop();
  }
  return out;
}

// Static files the server may send. Everything else (serve.mjs, test/, shots/, .git, config) is 404. From
// node_modules only PDF.js and its worker, which the library reads PDFs with; no other package file.
const STATIC = /^\/(?:index\.html|styles\.css|bar\.css|icon\.svg|src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|js)|node_modules\/pdfjs-dist\/build\/pdf(?:\.worker)?\.min\.mjs)$/;
export function staticPath(decoded) {
  const p = decoded === '/' ? '/index.html' : String(decoded);
  if (/[\:\0]|\.\./.test(p) || p.split('/').some((seg) => seg.startsWith('.'))) return null;
  return STATIC.test(p) ? p : null;
}

// The CLI bridge only runs commands listed in maverick.config.json, with the arguments written there.
// The browser sends a command name and a model, never arguments.
// ponytail: flag spellings for codex, qwen and llm are from their docs, not run here; fix them in the config file.
export const DEFAULT_CLI = {
  claude: { args: ['-p', '--model', '{model}'] },
  codex: { args: ['exec', '--model', '{model}'] },
  gemini: { args: ['--model', '{model}'] },
  aider: { args: [] },
  opencode: { args: [] },
  qwen: { args: ['--model', '{model}'] },
  llm: { args: ['-m', '{model}'] },
  ollama: { args: ['run', '{model}'] },
  'cursor-agent': { args: [] },
};
// { name, args } for an allowed command (case-insensitive, like Windows), or null.
export function cliEntry(command, table) {
  const c = String(command || '').trim().toLowerCase();
  if (!/^[a-z0-9][\w-]*$/.test(c)) return null;
  const name = Object.keys(table).find((k) => k.toLowerCase() === c);
  return name ? { name, args: table[name].args } : null;
}
