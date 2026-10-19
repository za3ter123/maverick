// node test/live-providers.mjs [screen.jpg]
// Live checks: Ollama chat streaming, then a real serve.mjs with the Claude Code bridge
// (token, host and origin gates, plus a real `claude -p` round trip, optionally with an image).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { PROVIDERS, streamChat } from '../src/providers.mjs';

const defaults = (id) => ({ id, ...Object.fromEntries(PROVIDERS[id].fields.map((f) => [f.key, f.value])) });
const collect = async (it, onChunk) => { let s = ''; for await (const t of it) { s += t; onChunk?.(t); } return s; };
const msgs = (q) => [{ role: 'system', content: 'Answer in one short sentence.' }, { role: 'user', content: q }];

// 1. Ollama
{
  const conf = defaults('ollama');
  let chunks = 0;
  const t0 = Date.now();
  const text = await collect(streamChat(msgs('What is the capital of Kuwait?'), {}, conf), () => chunks++);
  console.log(`ollama ${conf.model}: ${chunks} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${text.trim()}`);
  assert.ok(chunks > 1 && /kuwait city/i.test(text));
}

// 2. Claude Code bridge through a real server
const PORT = 5199;
const server = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url))], { env: { ...process.env, PORT: String(PORT) }, windowsHide: true });
try {
  await new Promise((ok, fail) => { server.stdout.once('data', ok); server.once('exit', fail); });
  const base = `http://localhost:${PORT}`;
  const html = await (await fetch(`${base}/`)).text();
  const token = html.match(/name="cue-token" content="([0-9a-f]{48})"/)?.[1];
  assert.ok(token, 'token injected into the page');

  const post = (headers) => fetch(`${base}/bridge/claude`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ messages: msgs('hi') }) });
  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-cue-token': 'f'.repeat(48) })).status, 403, 'wrong token');
  assert.equal((await post({ 'x-cue-token': token, origin: 'https://attacker-site' })).status, 403, 'foreign origin');
  const rebind = await new Promise((ok) => http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: { host: `rebind-attacker:${PORT}` } }, (r) => { r.resume(); ok(r.statusCode); }).on('error', ok));
  assert.equal(rebind, 421, 'foreign Host header (DNS rebinding)');
  assert.equal((await fetch(`${base}/.git/config`)).status, 404, 'dotfiles hidden');
  console.log('bridge gates: no token 403, wrong token 403, foreign origin 403, foreign host 421, dotfiles 404');

  const image = process.argv[2] ? readFileSync(process.argv[2]).toString('base64') : null;
  const question = image
    ? 'Look at the attached screenshot of the shared screen. In one sentence, what app is shown and what is its name?'
    : 'Reply with exactly: bridge ok';
  const conf = { ...defaults('claudecode'), server: base, token, model: 'haiku' };
  const t0 = Date.now();
  let chunks = 0;
  const text = await collect(streamChat(msgs(question), { images: image ? [image] : [] }, conf), () => chunks++);
  console.log(`claude code bridge (haiku${image ? ', with image' : ''}): ${chunks} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${text.trim()}`);
  assert.ok(text.trim().length > 0);

  const bad = await collect(streamChat(msgs('x'), {}, { ...defaults('cli'), command: 'definitely-not-a-cli', server: base, token })).catch((e) => e.message);
  console.log(`cli bridge, command not on the allowlist -> ${bad}`);
  assert.match(bad, /not on the allowed list/);
  const shell = await collect(streamChat(msgs('x'), {}, { ...defaults('cli'), command: 'cmd', args: '/c echo PWNED', server: base, token })).catch((e) => e.message);
  console.log(`cli bridge, cmd.exe -> ${shell}`);
  assert.match(shell, /not on the allowed list/);
} finally {
  server.kill();
}
console.log('live providers passed');
