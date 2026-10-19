// Maverick local server: static files plus the CLI bridges. Node stdlib only.
//   node serve.mjs            -> http://localhost:5174
// Safety: binds 127.0.0.1, rejects foreign Host headers (DNS rebinding) and foreign Origins,
// and /bridge/* needs a random per-run token that is only embedded in the page this server serves.
// Only an allowlist of static files is served, and the CLI bridge only runs programs named in maverick.config.json.
// /recording plays a meeting recording back (desktop app, History): only files named like Maverick's recordings, and
// only with the token in the URL (a <video> cannot send headers).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildCliArgs, claudeArgs, cliEntry, DEFAULT_CLI, formatForCli, parseClaudeLine, staticPath } from './src/providers.mjs';
import { byteRange, RECORDING_FILE } from './src/recording.mjs';
import publik from './desktop/publik.cjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5174;
const TOKEN = randomBytes(24).toString('hex');
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const MAX_BODY = 25 * 1024 * 1024;
const RUN_TIMEOUT_MS = Number(process.env.CUE_RUN_TIMEOUT_MS) || 180_000;
const CONFIG_FILE = process.env.CUE_CONFIG || join(ROOT, 'maverick.config.json');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "connect-src *; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const send = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function which(cmd) {
  const exts = process.platform === 'win32' && !extname(cmd) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) if (existsSync(join(dir, cmd + e))) return join(dir, cmd + e);
  }
  return null;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
  return body;
}

// Read on every request, so editing maverick.config.json takes effect without a restart.
// { command: { args: [...] } }; entries whose args are not a list of strings are ignored.
async function cliTable() {
  try {
    const cli = JSON.parse(await readFile(CONFIG_FILE, 'utf8')).cli;
    if (cli && typeof cli === 'object' && !Array.isArray(cli)) {
      return Object.fromEntries(Object.entries(cli).filter(([, v]) => Array.isArray(v?.args) && v.args.every((a) => typeof a === 'string')));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`maverick.config.json is not valid JSON, using the default CLI list: ${e.message}`);
  }
  return DEFAULT_CLI;
}

function claudeSpec(body, prompt) {
  const model = String(body.model || '');
  if (!/^[\w.\-[\]]*$/.test(model)) throw new HttpError(400, 'Bad model name');
  const file = which('claude');
  if (!file) throw new HttpError(400, 'Claude Code CLI not found. Install Claude Code and make sure "claude" runs in a terminal.');
  // Sources, Web (body.web) gets web search and fetch instead of Read (providers.mjs, claudeArgs).
  return { name: 'Claude Code', file, stdin: prompt, parse: parseClaudeLine, args: claudeArgs(model, body.web === true) };
}

async function cliSpec(body, prompt) {
  // Arguments live in maverick.config.json only; a page that sends its own is refused.
  if ('args' in body) throw new HttpError(400, 'CLI arguments are set in maverick.config.json, not by the page.');
  const command = String(body.command || '').trim();
  const table = await cliTable();
  const entry = cliEntry(command, table);
  if (!entry) {
    throw new HttpError(400, `"${command.slice(0, 40)}" is not on the allowed list (${Object.keys(table).join(', ')}). Add it to maverick.config.json next to serve.mjs.`);
  }
  const file = which(entry.name);
  if (!file) throw new HttpError(400, `"${entry.name}" was not found on PATH.`);
  let args;
  try { args = buildCliArgs(entry.args, body.model); } catch (e) { throw new HttpError(400, e.message); }
  const viaCmd = /\.(cmd|bat)$/i.test(file);
  // .cmd/.bat shims only run through cmd.exe, so every argument must be a plain word.
  if (viaCmd && args.some((a) => !/^[\w.:=/@-]+$/.test(a))) {
    throw new HttpError(400, `${entry.name} is a .cmd script, so its arguments in maverick.config.json must be plain words.`);
  }
  return { name: entry.name, file, args, stdin: prompt, viaCmd, parse: (line) => ({ text: line + '\n' }) };
}

function friendly(name, msg) {
  if (name === 'Claude Code' && /log ?in|logged|authenticat|api key|oauth/i.test(msg)) {
    return `Claude Code is not logged in. Open a terminal, run "claude", sign in, then try again. (${msg.trim().slice(0, 200)})`;
  }
  return msg;
}

// Stop the child and everything it started. A .cmd shim runs cmd.exe -> the real CLI, and killing
// only cmd.exe leaves the CLI running and holding the pipes. Always by PID, never by image name.
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function run(spec, cwd, res) {
  return new Promise((resolve) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    const opts = { cwd, windowsHide: true, detached: process.platform !== 'win32' };
    const child = spec.viaCmd
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${spec.file}" ${spec.args.join(' ')}"`],
        { ...opts, windowsVerbatimArguments: true })
      : spawn(spec.file, spec.args, opts);
    let finished = false;
    let sent = false;
    let error = '';
    let stderr = '';
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!error && code !== 0 && !sent) error = stderr.trim() || `${spec.name} exited with code ${code}`;
      if (error) sse(res, { error: friendly(spec.name, error) });
      sse(res, { done: true });
      res.end();
      resolve();
    };
    // The timeout ends the stream itself: a grandchild can keep the pipes open after its parent dies.
    const timer = setTimeout(() => {
      error = `${spec.name} took longer than ${RUN_TIMEOUT_MS / 1000} s and was stopped.`;
      killTree(child);
      finish(null);
    }, RUN_TIMEOUT_MS);
    res.on('close', () => { if (!finished) { finished = true; clearTimeout(timer); killTree(child); resolve(); } });
    child.on('error', (e) => { error = e.message; finish(-1); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (finished) return;
      const r = spec.parse(line);
      if (r?.text) { sent = true; sse(res, { text: r.text }); }
      if (r?.error) error = r.error;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdin);
    child.on('close', finish);
  });
}

// publik API (desktop/publik.cjs): the page calls /bridge/publik/v1/<endpoint>, and this adds the pk_ key, which never
// reaches the page, and forwards to the publik base URL. Only the endpoints Maverick uses, only to that base URL, so it
// is not an open proxy. Status, body (SSE included, as it arrives) and x-publik-* headers come back as they are.
const PUBLIK_PATHS = /^\/bridge\/publik\/v1\/(chat\/completions|audio\/transcriptions|embeddings|models|wallet)$/;
async function publikProxy(req, res, path) {
  const endpoint = PUBLIK_PATHS.exec(path)?.[1];
  if (!endpoint) throw new HttpError(404, 'Not a publik API endpoint Maverick uses');
  if (req.method !== 'POST' && req.method !== 'GET') throw new HttpError(405, 'GET or POST only');
  const p = publik.resolveProvider();
  if (!p) {
    return res.writeHead(401, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'publik API is not set up on this computer yet. Accept the publik offer on the first-run screen, or pick another connection in Settings.' } }));
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const headers = { authorization: `Bearer ${p.apiKey}`, accept: req.headers.accept || '*/*' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  let up;
  try {
    up = await fetch(`${p.baseURL}/${endpoint}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) return res.destroy();
    throw new HttpError(502, `Can’t reach publik API: ${e.message}`);
  }
  const out = { 'cache-control': 'no-store', 'content-type': up.headers.get('content-type') || 'application/octet-stream' };
  for (const [k, v] of up.headers) if (k.startsWith('x-publik-')) out[k] = v;
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  try {
    for await (const c of up.body) res.write(c);
  } catch { /* the page stopped reading, or publik closed the stream */ }
  res.end();
}

async function bridge(req, res, path) {
  if (req.headers.origin && !ORIGINS.has(req.headers.origin)) throw new HttpError(403, 'Origin not allowed');
  if (!tokenOk(req.headers['x-cue-token'])) throw new HttpError(403, 'Missing or wrong bridge token');
  if (path.startsWith('/bridge/publik/')) return publikProxy(req, res, path);
  if (path === '/bridge/allowed' && req.method === 'GET') {
    return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ cli: Object.keys(await cliTable()) }));
  }
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const body = await readJson(req);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role));
  if (!messages.length) throw new HttpError(400, 'messages required');
  const images = (Array.isArray(body.images) ? body.images : []).filter((s) => typeof s === 'string').slice(0, 4);

  const dir = await mkdtemp(join(tmpdir(), 'maverick-'));
  try {
    const paths = [];
    for (const [i, b64] of images.entries()) {
      const p = join(dir, `screen-${i + 1}.jpg`);
      await writeFile(p, Buffer.from(b64, 'base64'));
      paths.push(p);
    }
    const prompt = formatForCli(messages, body.web === true ? [] : paths);
    if (path === '/bridge/claude') await run(claudeSpec(body, prompt), dir, res);
    else if (path === '/bridge/cli') await run(await cliSpec(body, prompt), dir, res);
    else throw new HttpError(404, 'Unknown bridge');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const rel = staticPath(path);
  if (!rel) return send(res, 404, 'Not found');
  const file = join(ROOT, ...rel.split('/').filter(Boolean));
  let data;
  try { data = await readFile(file); } catch { return send(res, 404, 'Not found'); }
  const type = TYPES[extname(file)] || 'application/octet-stream';
  if (extname(file) === '.html') data = data.toString('utf8').replaceAll('__CUE_TOKEN__', TOKEN);
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// Byte ranges, so the player can seek.
async function serveRecording(req, res, params) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!tokenOk(params.get('t'))) throw new HttpError(403, 'Missing or wrong token');
  const f = params.get('f') || '';
  const file = resolve(f);
  if (!isAbsolute(f) || !RECORDING_FILE.test(basename(file))) return send(res, 404, 'Not found');
  let size;
  try { const st = await stat(file); if (!st.isFile()) throw new Error('not a file'); size = st.size; } catch { return send(res, 404, 'Not found'); }
  const r = byteRange(req.headers.range, size);
  if (!r) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
  res.writeHead(r.partial ? 206 : 200, {
    'content-type': 'video/webm', 'content-length': r.end - r.start + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(r.partial ? { 'content-range': `bytes ${r.start}-${r.end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || !size) return res.end();
  createReadStream(file, { start: r.start, end: r.end }).on('error', () => res.destroy()).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host)) throw new HttpError(421, 'Unknown host');
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { throw new HttpError(400, 'Bad URL'); }
    if (path.startsWith('/bridge/')) await bridge(req, res, path);
    else if (path === '/recording') await serveRecording(req, res, new URL(req.url, 'http://x').searchParams);
    else await serveStatic(req, res, path);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, e.message);
    else if (!res.writableEnded) { sse(res, { error: e.message }); res.end(); }
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Maverick is running at http://localhost:${PORT}`));
