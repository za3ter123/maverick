// node test/bridge-kill.mjs   (Windows; starts its own serve.mjs on port 5199)
// A .cmd shim starts a grandchild node process that holds stdout open. Checks that the CLI bridge
// kills the whole tree when the client aborts, and that the timeout ends the stream even though
// the grandchild still holds the pipes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 5199;
const dir = mkdtempSync(join(tmpdir(), 'cue-kill-'));
const pidFile = join(dir, 'grandchild.pid');
writeFileSync(join(dir, 'cueshim.cmd'),
  '@echo off\r\nnode -e "require(\'fs\').writeFileSync(process.env.CUE_PIDFILE, String(process.pid)); console.log(\'started\'); setInterval(() => {}, 1000)"\r\n');
writeFileSync(join(dir, 'cue.config.json'), JSON.stringify({ cli: { cueshim: { args: [] } } }));

const server = spawn(process.execPath, [new URL('../serve.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
  env: { ...process.env, PORT: String(PORT), CUE_CONFIG: join(dir, 'cue.config.json'), CUE_RUN_TIMEOUT_MS: '4000', CUE_PIDFILE: pidFile, PATH: `${dir};${process.env.PATH}` },
  windowsHide: true,
});
await new Promise((r) => server.stdout.once('data', r));

const get = (path) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
  let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
}));
const token = (await get('/')).match(/[0-9a-f]{48}/)[0];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts a bridge run; resolves once the grandchild printed "started". Returns the request and a promise of the full body.
function startRun() {
  rmSync(pidFile, { force: true });
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/bridge/cli', method: 'POST',
      headers: { host: `127.0.0.1:${PORT}`, 'x-cue-token': token, 'content-type': 'application/json' } }, (res) => {
      let body = '';
      const done = new Promise((r) => { res.on('end', () => r(body)); res.on('close', () => r(body)); });
      res.on('data', (c) => { body += c; if (body.includes('started')) resolve({ req, done }); });
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], command: 'cueshim' }));
  });
}

// POST /bridge/cli and return [status, body].
const post = (payload) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/bridge/cli', method: 'POST',
    headers: { host: `127.0.0.1:${PORT}`, 'x-cue-token': token, 'content-type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve([res.statusCode, d]));
  });
  req.end(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...payload }));
});

try {
  // 0. The page cannot pick arguments: the old attack and a flag passed as the model are refused.
  const attack = await post({ command: 'cueshim', args: '--dangerously-skip-permissions --version' });
  console.log(`args:    ${attack[0]} ${attack[1]}`);
  assert.deepEqual(attack, [400, 'CLI arguments are set in maverick.config.json, not by the page.']);
  const dash = await post({ command: 'cueshim', model: '--yolo' });
  console.log(`model:   ${dash[0]} ${dash[1]}`);
  assert.equal(dash[0], 400);

  // 1. Stop: the client goes away mid-answer.
  let run = await startRun();
  const pid1 = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid1), 'grandchild running');
  run.req.destroy();
  await sleep(1500);
  console.log(`stop:    grandchild ${pid1} alive after abort: ${alive(pid1)}`);
  assert.ok(!alive(pid1), 'Stop kills the grandchild');

  // 2. Timeout: the stream must end on its own while the grandchild holds the pipes.
  const t0 = Date.now();
  run = await startRun();
  const pid2 = Number(readFileSync(pidFile, 'utf8'));
  const body = await Promise.race([run.done, sleep(15000).then(() => 'HUNG')]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(1000);
  console.log(`timeout: stream ended after ${secs} s, body: ${JSON.stringify(body.replace(/\s+/g, ' ').slice(-140))}`);
  console.log(`timeout: grandchild ${pid2} alive after timeout: ${alive(pid2)}`);
  assert.notEqual(body, 'HUNG', 'stream ended');
  assert.match(body, /took longer than 4 s and was stopped/);
  assert.match(body, /"done":true/);
  assert.ok(!alive(pid2), 'timeout kills the grandchild');
  console.log('bridge-kill passed');
} finally {
  server.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
