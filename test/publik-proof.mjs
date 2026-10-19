// node test/publik-proof.mjs   (no network: a mock publik API on 127.0.0.1, and its own serve.mjs on port 5198)
// publik API wiring (desktop/publik.cjs, serve.mjs publikProxy, src/providers.mjs): the proxy adds the pk_ key and the
// page never sees it; it forwards only to publik; SSE streams through as it comes; a 402 gives its message and one
// top-up link; transcription goes as multipart to /audio/transcriptions; malformed credential files are ignored;
// selfTest prints its line. PUBLIK_TEST_BASE_URL points everything at the mock (honoured only for 127.0.0.1 with MAVERICK_TEST_HOOKS=1).
// Last, the real desktop app (a throwaway profile, Ollama on a dead port, DOM read over CDP, no real input): with no app
// token it offers no publik setup, with PUBLIK_APP_TOKEN=pat_test_dummy (env only, nothing is provisioned) it does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import electron from 'electron';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const KEY = 'pk_mock_not_a_real_key';
const dir = mkdtempSync(join(tmpdir(), 'maverick-publik-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

// ---- the mock publik API: records what reached it
const hits = [];
let lastChunkAt = 0;
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  hits.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', type: req.headers['content-type'] || '', body });
  const json = (status, obj, extra = {}) => res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(obj));
  if (req.url === '/installs') {
    return json(201, {
      key: KEY, base_url: 'https://publikhq.com/api/v1', install_id: 'abcdef12-3456-7890-abcd-ef1234567890', claim_url: 'https://publikhq.com/claim/abc',
      claim_state: 'anonymous', wallet: { add_credit_url: 'https://publikhq.com/wallet/add' }, disclosure: { cost: 'Answers cost about a cent each.' }, balance_micros: 0,
    });
  }
  if (req.url === '/chat/completions') {
    const text = body.toString();
    if (text.includes('BROKE')) return json(402, { error: { message: 'Your publik balance is empty.', top_up_url: 'https://publikhq.com/top-up/abc' } }, { 'x-publik-balance': '0' });
    if (text.includes('EVIL402')) return json(402, { error: { message: 'Empty.', top_up_url: 'https://evil.example/pay' } });
    if (text.includes('HTTP402')) return json(402, { error: { message: `Empty.${NL}Top up: https://publikhq.com/x`, top_up_url: 'http://publikhq.com/pay' } });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-publik-balance': '48000', 'x-publik-model': 'publik-fast' });
    for (const [i, w] of ['Hello', ' from', ' publik'].entries()) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      if (i < 2) await sleep(700);
    }
    lastChunkAt = Date.now();
    return res.end('data: [DONE]\n\n');
  }
  if (req.url === '/audio/transcriptions') return json(200, { text: 'hello from the mock' });
  if (req.url === '/embeddings') return json(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  // another provider (OpenAI-compatible) whose error text imitates a publik top-up line
  if (req.url === '/v1/chat/completions') return json(402, { error: { message: `Session expired.${NL}Top up: http://evil.example/login`, top_up_url: 'https://publikhq.com/looks-real' } });
  json(404, { error: { message: 'mock: no such endpoint' } });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// The test process and the server see the same LOCALAPPDATA (the credential file) and the same mock.
process.env.LOCALAPPDATA = dir;
process.env.PUBLIK_TEST_BASE_URL = MOCK;
process.env.MAVERICK_TEST_HOOKS = '1'; // without it the override is ignored (checked below)
delete process.env.PUBLIK_API_KEY;
delete process.env.PUBLIK_API_BASE_URL;
delete process.env.PUBLIK_APP_TOKEN;
const publik = (await import('../desktop/publik.cjs')).default;
const { embedPublik, isPublikTopUp, PROVIDERS, streamChat, transcribe } = await import('../src/providers.mjs');

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, windowsHide: true });
await new Promise((r) => server.stdout.once('data', r));
const BASE = `http://127.0.0.1:${PORT}`;
const token = (await (await fetch(`${BASE}/`)).text()).match(/[0-9a-f]{48}/)[0];
const conf = { id: 'publik', server: BASE, token, model: 'publik-fast' };
const raw = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { 'x-cue-token': token, 'content-type': 'application/json', ...init.headers } });
const chatBody = (content) => JSON.stringify({ model: 'publik-fast', stream: true, messages: [{ role: 'user', content }] });
const credFile = publik.credentialPath();
const writeCred = (obj) => { mkdirSync(dirname(credFile), { recursive: true }); writeFileSync(credFile, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// The desktop app on a throwaway profile with Ollama at a dead port: what the page renders about publik.
async function appRun(appToken) {
  const profile = mkdtempSync(join(tmpdir(), 'maverick-publik-app-'));
  const env = { ...process.env, MAVERICK_USER_DATA: profile, LOCALAPPDATA: dir };
  for (const k of ['PUBLIK_APP_TOKEN', 'PUBLIK_API_KEY', 'PUBLIK_TEST_BASE_URL', 'MAVERICK_TEST_HOOKS', 'PORT']) delete env[k];
  if (appToken) env.PUBLIK_APP_TOKEN = appToken;
  const app = spawn(electron, ['.', '--remote-debugging-port=9388'], { cwd: ROOT, env, windowsHide: false });
  try {
    let ws;
    for (const t0 = Date.now(); !ws && Date.now() - t0 < 30000; await sleep(300)) {
      try { ws = (await (await fetch('http://127.0.0.1:9388/json/list')).json()).find((t) => t.url.startsWith('http://127.0.0.1'))?.webSocketDebuggerUrl; } catch { /* starting */ }
    }
    assert.ok(ws, 'the app page came up');
    const sock = new WebSocket(ws);
    await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j); });
    let id = 0;
    const pending = new Map();
    sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
    const ev = (expression) => new Promise((resolve) => {
      const my = ++id;
      pending.set(my, (m) => resolve(m.result?.exceptionDetails ? null : m.result?.result?.value));
      sock.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    const until = async (expr, ms = 20000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) { const v = await ev(expr); if (v) return v; } return null; };
    const seed = async (conns) => {
      await until('!!document.querySelector("#st-ai")');
      await ev(`localStorage.setItem('maverick.settings', ${JSON.stringify(JSON.stringify({ connections: conns }))}); setTimeout(() => location.reload(), 50); 1`);
      await sleep(1500);
      return until('document.querySelector("#st-ai")?.textContent.includes("Ollama offline")');
    };
    const dead = { id: 'ollama', type: 'ollama', url: 'http://127.0.0.1:9' };
    const out = { ollama: !!(await seed([dead])) };
    await sleep(1500); // renderPublikOffer asks publik-info once
    Object.assign(out, await ev(`(async () => ({ info: await window.maverick.publikInfo(), offer: !document.querySelector('#fr-publik').hidden,
      offerYes: !!document.querySelector('#fr-publik [data-publik="yes"]') }))()`));
    // Settings with a publik connection (that hides the first-run offer, so a second load)
    await seed([dead, { id: 'publik', type: 'publik' }]);
    await ev('document.querySelector("#btn-settings").click(); 1');
    out.note = (await until('document.querySelector("[data-publik-setup]")?.textContent.trim()')) || '';
    out.setupYes = await ev('!!document.querySelector("[data-publik-setup-yes]")');
    sock.close();
    return out;
  } finally {
    const gone = new Promise((r) => app.once('exit', r));
    app.kill();
    await Promise.race([gone, sleep(10000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); // its helpers let go a moment later
  }
}

try {
  // 0. The page side builds no key and talks only to the local proxy.
  const req = PROVIDERS.publik.build([{ role: 'user', content: 'q' }], {}, conf);
  assert.equal(req.url, `${BASE}/bridge/publik/v1/chat/completions`);
  assert.equal(req.headers.authorization, undefined, 'the page sends no key');
  assert.equal(req.headers['x-cue-token'], token);
  console.log('build:      the page request goes to the local proxy with no Authorization header');

  // 1. Not set up yet: the proxy says so, and nothing reaches publik.
  let r = await raw('/bridge/publik/v1/chat/completions', { method: 'POST', body: chatBody('hi') });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error.message, /not set up/);
  assert.equal(hits.length, 0);
  console.log('no key:     401 "not set up", nothing forwarded');

  // 2. selfTest with no app token, then with one: provision() writes the credential file.
  assert.match(await publik.selfTest(), /^publik self-test: failed: This build has no publik API app token\./);
  process.env.PUBLIK_APP_TOKEN = 'pat_mock_token';
  const line = await publik.selfTest();
  console.log(`selfTest:   ${line}`);
  assert.equal(line, `publik self-test: ok maverick ${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version} (install abcdef12)`);
  const sent = JSON.parse(hits.at(-1).body);
  assert.equal(hits.at(-1).url, '/installs');
  assert.deepEqual([sent.app_slug, sent.disclosure_version, sent.dialects, sent.app_token], ['maverick', 1, ['chat_completions'], 'pat_mock_token']);
  assert.equal(JSON.parse(readFileSync(credFile, 'utf8')).key, KEY);
  const card = publik.card(publik.readCredential());
  assert.ok(!JSON.stringify(card).includes('pk_'), 'the card for the page carries no key');
  assert.equal(card.balance, '$0.00 · link this computer for $0.05 of free use');
  assert.equal(card.cost_sentence, 'Answers cost about a cent each.');
  console.log(`card:       ${card.balance} | ${card.cost_sentence} | ${card.claim_url}`);

  // 3. The proxy injects the key; the page sees neither it nor any header carrying it. SSE comes through as it is sent.
  hits.length = 0;
  const t0 = Date.now();
  const times = [];
  let text = '';
  for await (const t of streamChat([{ role: 'user', content: 'hi' }], {}, conf)) { times.push(Date.now()); text += t; }
  assert.equal(text, 'Hello from publik');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].auth, `Bearer ${KEY}`, 'publik got the key');
  assert.ok(times[0] < lastChunkAt - 1000, `the first word came ${times[0] - t0} ms in, before the mock sent its last (${lastChunkAt - t0} ms)`);
  console.log(`sse:        first word at ${times[0] - t0} ms, last sent at ${lastChunkAt - t0} ms: streamed, not buffered`);
  r = await raw('/bridge/publik/v1/chat/completions', { method: 'POST', body: chatBody('hi') });
  const seen = [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + (await r.text());
  assert.ok(!seen.includes(KEY) && !/pk_/.test(seen), 'no key in what the page receives');
  assert.equal(r.headers.get('x-publik-balance'), '48000', 'x-publik-* headers pass through');
  console.log('key:        injected upstream, absent from the page response; x-publik-balance passed through');

  // 4. Only publik endpoints, only to the publik base URL; the bridge token is still required.
  hits.length = 0;
  for (const p of ['/bridge/publik/v1/../../evil', '/bridge/publik/v1/https://evil.example/x', '/bridge/publik/v1//evil.example/chat/completions',
    '/bridge/publik/v1/completions', '/bridge/publik/v2/chat/completions', '/bridge/publik/v1/chat/completions/../../installs', '/bridge/publik/v1/installs']) {
    r = await raw(p, { method: 'POST', body: chatBody('x') });
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
  }
  r = await raw('/bridge/publik/v1/chat/completions', { method: 'POST', body: chatBody('x'), headers: { 'x-cue-token': 'wrong' } });
  assert.equal(r.status, 403);
  r = await raw('/bridge/publik/v1/chat/completions', { method: 'POST', body: chatBody('x'), headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(hits.length, 0, 'nothing reached publik');
  const saved = process.env.PUBLIK_TEST_BASE_URL;
  process.env.PUBLIK_TEST_BASE_URL = 'http://evil.example:9/';
  assert.equal(publik.baseUrl(), 'https://publikhq.com/api/v1', 'the test override is ignored unless the host is 127.0.0.1');
  assert.equal(publik.baseUrl('https://evil.example/api/v1'), 'https://publikhq.com/api/v1');
  assert.equal(publik.baseUrl('http://publikhq.com/api/v1'), 'https://publikhq.com/api/v1');
  process.env.PUBLIK_TEST_BASE_URL = saved;
  delete process.env.MAVERICK_TEST_HOOKS;
  assert.equal(publik.baseUrl(), 'https://publikhq.com/api/v1', 'the test override needs MAVERICK_TEST_HOOKS=1');
  process.env.MAVERICK_TEST_HOOKS = '1';
  assert.equal(publik.baseUrl(), MOCK);
  console.log('targets:    other paths 404, wrong token or origin 403, foreign base URLs fall back to publikhq.com');

  // 5. A 402: its message and one link, the top_up_url, and only an https publikhq.com one. The link rides on the Error
  // (.topUp), set only for the publik connection; error text that imitates a top-up line never makes a link.
  const fail = async (c, content) => { try { for await (const _ of streamChat([{ role: 'user', content }], {}, c)); } catch (e) { return e; } return null; };
  let err = await fail(conf, 'BROKE');
  assert.deepEqual([err.message, err.topUp], ['Your publik balance is empty.', 'https://publikhq.com/top-up/abc']);
  err = await fail(conf, 'EVIL402');
  assert.deepEqual([err.message, err.topUp], ['Empty.', null], 'a foreign top_up_url gets no link');
  err = await fail(conf, 'HTTP402');
  assert.equal(err.topUp, null, 'http publikhq.com gets no link, and a link in the message text is ignored');
  const spoof = await fail({ id: 'openai', baseUrl: `${MOCK}/v1`, key: 'k', model: 'm' }, 'x');
  assert.match(spoof.message, /Top up: http:\/\/evil\.example\/login/);
  assert.equal(spoof.topUp, undefined, 'another provider’s error never carries a top-up link');
  for (const [u, ok] of [['https://publikhq.com/t', true], ['http://publikhq.com/t', false], ['https://evil.example/login', false], ['https://publikhq.com.evil.example/', false],
    ['https://evil.example/?u=https://publikhq.com', false], ['javascript:alert(1)', false], [null, false]]) assert.equal(isPublikTopUp(u), ok, String(u));
  // the page builds the button only from .topUp through isPublikTopUp, and opens it through publikOpen, never openUrl
  const appSrc = readFileSync(join(ROOT, 'src', 'app.mjs'), 'utf8');
  assert.ok(!/splitTopUp|Top up: /.test(appSrc), 'no top-up link is parsed out of error text');
  assert.match(appSrc, /function failHtml\(msg, topUp = null\) \{\s+if \(isPublikTopUp\(topUp\)\)/);
  assert.match(appSrc, /function openTopUp\(u\) \{\s+if \(!isPublikTopUp\(u\)\) return;\s+if \(desk\?\.publikOpen\) desk\.publikOpen\(u\);/);
  assert.match(appSrc, /if \(cmd === 'topup'\) return openTopUp\(b\.dataset\.url\);/);
  assert.equal((appSrc.match(/Add publik balance/g) || []).length, 2, 'two buttons: answers, and Memory and Homework through topUpButton');
  assert.deepEqual(publik.topUpUrlFrom402({ error: { message: 'm', top_up_url: 'https://publikhq.com/t' } }), { message: 'm', url: 'https://publikhq.com/t' });
  assert.deepEqual(publik.topUpUrlFrom402({ error: { top_up_url: 'javascript:alert(1)' } }), { message: 'Not enough publik API balance.', url: null });
  console.log(`402:        publik's own link kept; foreign or http links dropped; spoofed text from another provider ("${spoof.message.split(NL)[1]}") makes no link`);

  // 6. Transcription: multipart to /audio/transcriptions with the WAV and the tier model.
  hits.length = 0;
  const wav = Buffer.from('RIFF....WAVEfmt mock audio bytes');
  assert.equal(await transcribe(wav.toString('base64'), conf), 'hello from the mock');
  const up = hits[0];
  assert.equal(up.url, '/audio/transcriptions');
  assert.equal(up.auth, `Bearer ${KEY}`);
  assert.match(up.type, /^multipart\/form-data; boundary=/);
  const form = up.body.toString('latin1');
  assert.match(form, /name="file"; filename="chunk\.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF\.\.\.\.WAVEfmt mock audio bytes\r\n/);
  assert.match(form, /name="model"\r\n\r\npublik-fast\r\n/);
  console.log(`transcribe: multipart (${up.body.length} bytes) with file=chunk.wav and model=publik-fast -> "hello from the mock"`);

  // 7. Embeddings: POST /embeddings, vectors back in input order.
  assert.deepEqual(await embedPublik(['a', 'b'], conf), [[1, 0], [0, 1]]);
  assert.equal(hits.at(-1).url, '/embeddings');
  console.log('embeddings: /embeddings, vectors in input order');

  // 8. Malformed credential files are ignored (the proxy then says "not set up"); foreign URLs in a good one are dropped.
  delete process.env.PUBLIK_TEST_BASE_URL; // so a credential's own base_url is what is judged
  for (const bad of ['{not json', JSON.stringify({ key: 123 }), JSON.stringify({ key: 'sk-abc' }), JSON.stringify([KEY]), 'null', '']) {
    writeCred(bad);
    assert.equal(publik.readCredential(), null, bad);
    r = await raw('/bridge/publik/v1/chat/completions', { method: 'POST', body: chatBody('x') });
    assert.equal(r.status, 401, bad);
  }
  writeCred({ key: KEY, base_url: 'https://evil.example/api/v1', claim_url: 'javascript:alert(1)', add_credit_url: 'http://publikhq.com/x', claim_state: 'owned', balance_micros: 'lots' });
  const c = publik.readCredential();
  assert.deepEqual([c.base_url, c.claim_url, c.add_credit_url, c.claim_state, c.balance_micros], ['https://publikhq.com/api/v1', null, null, 'anonymous', null]);
  process.env.PUBLIK_TEST_BASE_URL = MOCK;
  console.log('credential: 6 malformed files ignored (proxy 401), foreign base_url and links replaced or dropped');

  // 9. The real app, once without an app token and once with a dummy one in the environment. publik-info carries hasToken
  // and never the token; the first-run offer and Settings' "Yes, set it up" are rendered only with a token.
  rmSync(credFile, { force: true });
  assert.equal(publik.hasAppToken(), true); // PUBLIK_APP_TOKEN from step 2
  delete process.env.PUBLIK_APP_TOKEN;
  assert.equal(publik.hasAppToken(), false);
  for (const appToken of [null, 'pat_test_dummy']) {
    const s = await appRun(appToken);
    assert.ok(!JSON.stringify(s.info).includes('pat_'), 'publik-info never carries the token');
    assert.equal(s.info.hasToken, !!appToken);
    assert.equal(s.ollama, true, 'Ollama is out of reach, so only the token decides');
    assert.deepEqual([s.offer, s.offerYes, s.setupYes], [!!appToken, !!appToken, !!appToken], JSON.stringify(s));
    console.log(`app ${appToken ? 'token' : 'none '}: publik-info hasToken ${s.info.hasToken}; first-run offer ${s.offer ? 'shown' : 'not rendered'}; Settings "${s.note.slice(0, 50)}..." ${s.setupYes ? 'with' : 'without'} "Yes, set it up"`);
  }

  console.log('\npublik-proof: all checks passed');
} finally {
  server.kill();
  mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
