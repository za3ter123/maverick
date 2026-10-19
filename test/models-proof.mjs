// node test/models-proof.mjs   (Windows 11; Ollama with gemma4:12b)
// Proves per-task models in the real desktop app on a temp profile (MAVERICK_USER_DATA, MAVERICK_TEST_HOOKS=1):
//   1. Migration: settings saved in the old shape (one provider, a saved DeepSeek key) in the temp profile become
//      connections and roles on the next start, with the same models and the key kept.
//   2. Settings: two OpenAI-compatible connections are added in the Settings dialog, each with its own key: "DeepSeek"
//      (the DeepSeek preset, its base URL pointed at mock A) and a custom one at mock B. Live stays local Ollama gemma4:12b,
//      Reasoning goes to mock A, Vision to mock B. Keys are masked fields, and the note names the host each goes to.
//      Settings refuse Vision and Transcription on DeepSeek (no images, no audio) and do not save them.
//   3. A meeting on a shared window: the screen read and Explain screen go to mock B with key B and an image; Answer goes
//      to Ollama only (seen by a recording proxy in front of it, no key); Think harder and End & summarize go to mock A
//      with key A, model A and no image (DeepSeek reads no images). No request carries the other key.
//   4. Bytes sent off this PC: the mocks run on 127.0.0.1, so a test hook (markRemote) counts their host:port as off this
//      PC; the meeting's count must equal the bytes of exactly the mock requests, so Ollama counted 0.
//   5. The user's real profile (%APPDATA%\maverick) is byte-identical afterwards. Only the PIDs started here are killed.
// Never loads the 27b model: reasoning is the mock. Prints "models proof passed" only when every check passed.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { requestBytes } from '../src/providers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'features');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return !!ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
const PORT = 9377;
const INSPECT = 9277;

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

// ---- two OpenAI-compatible mocks: each records Authorization, model, whether an image came, and the body; streams a fixed reply
const KEY_A = 'sk-mock-a-7f3c1e';
const KEY_B = 'sk-mock-b-91d2aa';
const REPLY = { a: 'DEEPSEEK-MOCK says the target is 4,750 units.', b: 'VISION-MOCK sees a slide: Q3 sales target, 4,750 units.' };
const asked = { a: [], b: [] };
function mock(which) {
  const s = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let j = {};
      try { j = JSON.parse(body); } catch { /* recorded as is */ }
      const image = (j.messages || []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      asked[which].push({ path: req.url, auth: req.headers.authorization || '', model: j.model, image, body, prompt: JSON.stringify(j.messages || []).slice(0, 200) });
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      for (const w of REPLY[which].match(/.{1,12}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const mockA = await mock('a');
const mockB = await mock('b');
const A = `http://127.0.0.1:${mockA.address().port}/v1`;
const B = `http://127.0.0.1:${mockB.address().port}/v1`;

// ---- a recording proxy in front of Ollama: what reached it, and that no key came with it
const ollamaSeen = [];
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let model = '';
    try { model = JSON.parse(body).model || ''; } catch { /* GET */ }
    ollamaSeen.push({ path: req.url, model, auth: req.headers.authorization || '', keys: body.includes(KEY_A) || body.includes(KEY_B), method: req.method });
    const up = httpRequest({ host: '127.0.0.1', port: 11434, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    up.end(body);
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const OLLAMA = `http://127.0.0.1:${proxy.address().port}`;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const my = ++id;
    pending.set(my, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
    return res.result?.value;
  };
  return Object.assign(ev, { send, close: () => ws.close() });
}
async function until(fn, ms, every = 300) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) { const v = await fn(); if (v) return v; }
  return null;
}

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-models-'));
const out = [];
let S = null;
const finish = (code) => { writeFileSync(join(OUT, 'models-proof-log.txt'), `${lines.join('\n')}\n`); for (const s of [mockA, mockB, proxy]) s.close(); process.exit(code); };
const bail = (e) => { log(`FAIL: ${e?.stack || e}`); if (S) killTree(S.app.pid); finish(1); };
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

// One start of the app on PROFILE: { app, M, page, bar, main }
async function start() {
  const app = spawn(electron, ['.', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
    cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
  });
  for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };
  const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 30000); if (!t) throw new Error('no debug target'); return t; };
  const main = await cdp((await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json())[0]; } catch { return null; } }, 30000)).webSocketDebuggerUrl);
  const M = (body) => main(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); const W = BrowserWindow.getAllWindows(); const bar = W.find((w) => w.webContents.getURL() === 'about:blank'); ${body} })()`);
  const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
  const bar = await cdp((await target((t) => t.type === 'page' && t.url === 'about:blank')).webSocketDebuggerUrl);
  await until(() => M('return !!bar && bar.isVisible();'), 15000);
  await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy') && !!window.maverickTest; })()"), 30000);
  return { app, M, page, bar, main };
}
async function stop(s) {
  await s.M('app.quit(); return 1;').catch(() => {});
  s.page.close(); s.bar.close(); s.main.close();
  if (!(await until(async () => s.app.exitCode !== null, 8000, 200))) killTree(s.app.pid);
  await sleep(1000);
}

// ================================================================= 1. old settings in the temp profile
const OLD = {
  provider: 'ollama', transcriber: 'ollama', fixWords: false, subtitles: 'off',
  providers: { ollama: { url: OLLAMA, model: 'gemma4:12b', deepModel: '' }, openai: { baseUrl: 'https://api.deepseek.com/v1', key: 'sk-old-saved-key', model: 'deepseek-chat', deepModel: '' } },
};
S = await start();
check((await S.M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);
await S.page(`localStorage.setItem('maverick.settings', ${JSON.stringify(JSON.stringify(OLD))}); 1`);
await sleep(1500); // let Chromium write it to the profile
await stop(S);
S = await start();
const { M, page, bar } = S;
const mig = JSON.parse(await page('JSON.stringify(window.maverickTest.settings())'));
log(`migrated: ${JSON.stringify({ connections: mig.connections.map(({ key, ...c }) => ({ ...c, key: key ? '(kept)' : '' })), roles: mig.roles })}`);
const ds = mig.connections.find((c) => c.id === 'openai');
check(mig.connections.map((c) => c.id).join() === 'ollama,openai,claudecode' && mig.connections[0].url === OLLAMA
  && ds?.preset === 'deepseek' && ds.name === 'DeepSeek' && ds.key === 'sk-old-saved-key',
'1. the old settings file became connections: Ollama at its URL, DeepSeek with its saved key, Claude Code');
check(JSON.stringify(mig.roles) === JSON.stringify({ live: { conn: 'ollama', model: 'gemma4:12b' }, deep: { conn: 'ollama', model: '' }, vision: { conn: 'ollama', model: 'gemma4:12b' }, transcribe: { conn: 'ollama', model: 'gemma4:12b' }, web: { conn: 'claudecode', model: '' } }),
  '1. and roles with the same models: Live, Vision and Transcription on gemma4:12b, no deep model, Web on Claude Code');
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), '1. the assistant is ready on the migrated settings (Ollama answered the health check through the proxy)');
const rawKey = async (...keys) => { const raw = await page("localStorage.getItem('maverick.settings')"); return { plain: keys.filter((k) => raw.includes(k)), sealed: (raw.match(/"key":"safe:/g) || []).length }; };
const r1 = await rawKey('sk-old-saved-key');
check(!r1.plain.length && r1.sealed === 1, `1. the old plain-text key was sealed on load: the stored value is not the key (${r1.sealed} sealed key)`);
// the Library and Homework notes say where files are read, for the roles as they are now
const dataNotes = async () => {
  await page("document.querySelector('#btn-library').click(); 1");
  const lib = await page("document.querySelector('#lib-note').textContent + ' | ' + document.querySelector('#lib-read-note').textContent");
  await page("document.querySelector('#dlg-library').close(); 1");
  await page("document.querySelector('#btn-homework').click(); 1");
  const hw = await until(() => page("document.querySelector('#dlg-homework').open ? document.querySelector('#hw-note').textContent : ''"), 5000, 200);
  await page("document.querySelector('#dlg-homework').close(); 1");
  return { lib, hw };
};
const localNotes = await dataNotes();
check(localNotes.lib === 'PDF, PNG, JPG, WebP, .docx, .txt and .md. They stay on this PC. | Scanned pages and images are read by Ollama (local), gemma4:12b, on this PC.'
  && localNotes.hw === 'PDF, photo, .docx, .txt or .md. It stays on this PC.', `1. all local: the Library and Homework say the files stay on this PC: ${JSON.stringify(localNotes)}`);

// ================================================================= 2. Settings: two connections, three roles
const stored = async () => JSON.parse(await page("localStorage.getItem('maverick.settings')"));
const set = (name, value) => page(`(() => { const el = document.querySelector('#settings-form').elements[${JSON.stringify(name)}]; el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
const addConn = async (type) => {
  await page(`(() => { const s = document.querySelector('#conn-add'); s.value = ${JSON.stringify(type)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  return page("[...document.querySelectorAll('#provider-fields .prov')].at(-1).dataset.conn");
};
const errOf = (name) => page(`document.getElementById('err-${name}').textContent`);
await page("document.querySelector('#btn-settings').click(); 1");
check(await page("document.querySelector('#dlg-settings').open && document.querySelector('[name=\"role.live\"]').value === 'ollama'"), '2. Settings open on the migrated roles');
const idA = await addConn('openai');
await set(`${idA}.preset`, 'deepseek');
const presetUrl = await page(`document.querySelector('#settings-form').elements['${idA}.baseUrl'].value`);
const presetName = await page(`document.querySelector('#settings-form').elements['${idA}.name'].value`);
check(presetUrl === 'https://api.deepseek.com/v1' && presetName === 'DeepSeek', `2. the DeepSeek preset fills its base URL and name: ${presetUrl}, ${presetName}`);
await set(`${idA}.baseUrl`, A);
await set(`${idA}.key`, KEY_A);
const idB = await addConn('openai');
await set(`${idB}.preset`, 'custom');
await set(`${idB}.name`, 'Vision mock');
await set(`${idB}.baseUrl`, B);
await set(`${idB}.key`, KEY_B);
const masked = JSON.parse(await page(`JSON.stringify([${JSON.stringify(idA)}, ${JSON.stringify(idB)}].map((id) => ({ type: document.querySelector('#settings-form').elements[id + '.key'].type, host: document.querySelector('.prov[data-conn="' + id + '"] [data-host]').textContent })))`));
check(masked.every((x) => x.type === 'password') && masked[0].host === new URL(A).host && masked[1].host === new URL(B).host,
  `2. keys are masked fields, and each connection's note names the host its key goes to: ${masked.map((x) => x.host).join(', ')}`);
// refused: Vision and Transcription on DeepSeek, which takes no images and no audio
await sleep(600);
const beforeRefuse = await stored();
await set('role.vision', idA);
const visionErr = await errOf('role.vision');
await set('role.transcribe', idA);
const audioErr = await errOf('role.transcribe');
await sleep(700);
const afterRefuse = await stored();
const pickers = await page("['vision', 'transcribe'].map((r) => document.querySelector(`[name=\"role.${r}\"]`).value).join()");
check(/^DeepSeek cannot read images\. .* Kept Ollama \(local\)\.$/.test(visionErr) && /^DeepSeek cannot take audio/.test(audioErr) && pickers === 'ollama,ollama'
  && afterRefuse.roles.vision.conn === 'ollama' && afterRefuse.roles.transcribe.conn === 'ollama' && JSON.stringify(afterRefuse.roles) === JSON.stringify(beforeRefuse.roles),
`2. Settings refuse Vision and Transcription on DeepSeek, put both pickers back on Ollama and say so: "${visionErr}" / "${audioErr}"`);
// a later change still saves (it did not, while the refused pick sat in the picker), and Reasoning starts on DeepSeek's own model
await set('role.deep', idA);
const deepDefault = await page("document.querySelector('[name=\"role.deep.model\"]').value");
await sleep(700);
check(deepDefault === 'deepseek-reasoner' && (await stored()).roles.deep.conn === idA, `2. after the refusal, Reasoning moved to DeepSeek is saved, with DeepSeek's reasoning model: ${deepDefault}`);
await set('role.vision', idB);
await sleep(700);
const unsaved = await page("document.querySelector('#set-unsaved').textContent");
check(/^Not saved yet\. Vision model: Enter a model name\.$/.test(unsaved) && (await stored()).roles.vision.conn === 'ollama',
  `2. a custom connection starts with no model name: the dialog says what keeps it from saving: "${unsaved}"`);
await set('role.vision.model', 'vision-mock');
await set('role.deep.model', 'deepseek-mock');
await sleep(700);
check(!(await page("document.querySelector('#set-unsaved').textContent")), '2. fixed: the note is gone');
// Remove on a connection a role uses: said inside the dialog, as an alert, not in a toast behind it
await page(`document.querySelector('[data-remove="${idA}"]').click(); 1`);
const blocked = await page(`(() => { const r = document.querySelector('.prov[data-conn="${idA}"] [data-result]'); return JSON.stringify({ text: r.textContent, role: r.getAttribute('role'), inDialog: !!r.closest('#dlg-settings'), still: !!document.querySelector('.prov[data-conn="${idA}"]') }); })()`);
const bl = JSON.parse(blocked);
check(bl.text === 'DeepSeek is used for Reasoning. Pick another connection there first.' && bl.role === 'alert' && bl.inDialog && bl.still, `2. Remove on DeepSeek is refused inside the dialog: ${blocked}`);
const saved = await stored();
const mem = JSON.parse(await page('JSON.stringify(window.maverickTest.settings())'));
const conn = (id) => saved.connections.find((c) => c.id === id);
const key = (id) => mem.connections.find((c) => c.id === id)?.key;
check(!(await errOf('role.vision')) && saved.roles.live.conn === 'ollama' && saved.roles.live.model === 'gemma4:12b'
  && saved.roles.deep.conn === idA && saved.roles.deep.model === 'deepseek-mock' && saved.roles.vision.conn === idB && saved.roles.vision.model === 'vision-mock'
  && key(idA) === KEY_A && conn(idA)?.preset === 'deepseek' && conn(idA)?.baseUrl === A && key(idB) === KEY_B && conn(idB)?.baseUrl === B && key('openai') === 'sk-old-saved-key',
'2. saved: Live on local Ollama gemma4:12b, Reasoning on mock A, Vision on mock B, each connection with its own key (and the old DeepSeek key kept)');
const r2 = await rawKey(KEY_A, KEY_B, 'sk-old-saved-key');
check(!r2.plain.length && r2.sealed === 3 && conn(idA).key.startsWith('safe:'), `2. no key is stored in plain text: ${r2.sealed} sealed keys, none readable`);
check(saved.provider === undefined && saved.providers === undefined, '2. the saved settings are in the new shape only');
await page("document.querySelector('#dlg-settings').close(); 1");

// ================================================================= 3. a meeting: who gets which request
await page(`window.maverickTest.markRemote(${JSON.stringify(new URL(A).host)}) && window.maverickTest.markRemote(${JSON.stringify(new URL(B).host)})`);
const offNotes = await dataNotes();
check(offNotes.lib === 'PDF, PNG, JPG, WebP, .docx, .txt and .md. The files stay on this PC. Images and scanned pages are read by Vision mock, off this PC. | Scanned pages and images are read by Vision mock, vision-mock, off this PC.'
  && offNotes.hw === 'PDF, photo, .docx, .txt or .md. Photos and scanned pages are read by Vision mock, off this PC.',
`3. Vision off this PC: the Library and Homework no longer say the files stay here; they name the connection that reads them: ${JSON.stringify(offNotes)}`);
const TITLE = 'Models proof slide';
const SLIDE = '<div style="height:100%;background:#fff;color:#111;font-family:Segoe UI,sans-serif"><div style="background:#7a1f5c;color:#fff;padding:28px 48px;font-size:42px;font-weight:700">Q3 sales target</div><div style="padding:60px 48px 0;font-size:120px;font-weight:800;color:#7a1f5c">4,750 units</div></div>';
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title><style>html,body{margin:0;height:100%}</style></head><body>${SLIDE}</body></html>`;
await M(`const w = new BrowserWindow({ x: 60, y: 80, width: 960, height: 600, show: false, title: ${JSON.stringify(TITLE)}, skipTaskbar: true, focusable: false, autoHideMenuBar: true });
  w.on('page-title-updated', (e) => e.preventDefault());
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(html)})); w.showInactive(); return 1;`);
await page(`window.maverick.saveSettings({ source: ${JSON.stringify(TITLE)} }).then(() => 1)`);
await page("document.querySelector('#btn-share').click(); 1");
check(await until(() => page("(document.querySelector('#preview').videoWidth || 0) > 0"), 20000), '3. Share meeting captures the proof window');
const read = await until(async () => JSON.parse(await page('JSON.stringify(window.maverickTest.screens())'))[0]?.text, 60000, 500);
check(read === REPLY.b && asked.b.length === 1 && asked.b[0].image && asked.b[0].auth === `Bearer ${KEY_B}` && asked.b[0].model === 'vision-mock',
  `3. the screen read went to Vision (mock B) with key B, model vision-mock and the frame: "${read}"`);

const latestDone = (n, kind) => until(() => page(`(() => { const a = document.querySelector('#answers .answer.latest'); return document.querySelectorAll('#answers .answer').length > ${n} && a.dataset.kind === '${kind}' && a.getAttribute('aria-busy') === 'false'
  ? JSON.stringify({ text: a.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(), error: a.classList.contains('error') }) : ''; })()`), 240000, 500).then((v) => JSON.parse(v || '{}'));
const count = () => page("document.querySelectorAll('#answers .answer').length");
const chats = () => ollamaSeen.filter((r) => r.path === '/api/chat' && r.method === 'POST'); // not the CORS preflights

// Answer: Ollama only
await page("window.maverickTest.addLine('Speaker 2', 'What is our sales target for the quarter?')");
let n = await count();
let [a0, b0, o0] = [asked.a.length, asked.b.length, chats().length];
await page("document.querySelector('.actions [data-action=\"answer\"]').click(); 1");
const answer = await latestDone(n, 'answer');
log(`Answer: ${JSON.stringify(answer)}`);
const ollamaNew = chats().slice(o0);
log(`Answer requests: Ollama ${JSON.stringify(ollamaNew.map(({ keys, ...r }) => r))}, mock A ${asked.a.length - a0}, mock B ${asked.b.length - b0}`);
check(answer.text && !answer.error && !/MOCK/.test(answer.text) && asked.a.length === a0 && asked.b.length === b0
  && ollamaNew.length >= 1 && ollamaNew.every((r) => r.model === 'gemma4:12b' && !r.auth),
`3. Answer went to Ollama only: ${ollamaNew.length} chat request(s) to gemma4:12b with no key, none to the mocks`);

// Think harder: mock A, key A, no image (DeepSeek reads none), though the screen is shared
n = await count();
[a0, b0, o0] = [asked.a.length, asked.b.length, chats().length];
await page("document.querySelector('#answers .answer.latest [data-cmd=\"deep\"]').click(); 1");
const deep = await latestDone(n, 'answer');
log(`Think harder: ${JSON.stringify(deep)}`);
const reqA = asked.a.slice(a0);
check(deep.text?.includes(REPLY.a) && reqA.length === 1 && reqA[0].auth === `Bearer ${KEY_A}` && reqA[0].model === 'deepseek-mock' && !reqA[0].image
  && asked.b.length === b0,
`3. Think harder went to Reasoning (mock A) only, with key A, model deepseek-mock and no image: "${deep.text?.slice(0, 80)}"`);

// Explain screen: mock B, key B, the frame
n = await count();
[a0, b0, o0] = [asked.a.length, asked.b.length, chats().length];
await page("document.querySelector('.actions [data-action=\"explain\"]').click(); 1");
const explain = await latestDone(n, 'explain');
log(`Explain screen: ${JSON.stringify(explain)}`);
const reqB = asked.b.slice(b0);
check(explain.text?.includes(REPLY.b) && reqB.length === 1 && reqB[0].auth === `Bearer ${KEY_B}` && reqB[0].model === 'vision-mock' && reqB[0].image
  && asked.a.length === a0,
`3. Explain screen went to Vision (mock B) only, with key B, model vision-mock and an image: "${explain.text?.slice(0, 80)}"`);

// End & summarize: the notes from Reasoning (mock A)
a0 = asked.a.length;
const before = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")).length;
await page("document.querySelector('#btn-end').click(); 1");
const meet = await until(async () => { const h = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")); return h.length > before && h.at(-1).summary ? h.at(-1) : null; }, 120000, 1000);
const notesA = asked.a.slice(a0);
check(meet && meet.summary.includes('DEEPSEEK-MOCK') && notesA.length >= 1 && notesA.every((r) => r.auth === `Bearer ${KEY_A}` && r.model === 'deepseek-mock'),
  `3. End & summarize wrote the notes with Reasoning (mock A), key A: ${notesA.length} request(s)`);
await page("document.querySelector('#dlg-summary').close(); 1");

check(asked.a.every((r) => r.auth === `Bearer ${KEY_A}`) && asked.b.every((r) => r.auth === `Bearer ${KEY_B}`) && ollamaSeen.every((r) => !r.auth && !r.keys),
  `3. no request carried the wrong key: ${asked.a.length} to mock A all with key A, ${asked.b.length} to mock B all with key B, ${ollamaSeen.length} to Ollama with none`);

// ================================================================= 4. bytes sent off this PC: exactly the mock requests
const want = [...asked.a.map((r) => [r, KEY_A]), ...asked.b.map((r) => [r, KEY_B])]
  .reduce((s, [r, k]) => s + requestBytes(r.body, { 'content-type': 'application/json', authorization: `Bearer ${k}` }), 0);
check(meet && meet.egress === want && want > 0, `4. the meeting counted ${meet?.egress} bytes sent off this PC: the mock requests' ${want}, and 0 for ${ollamaSeen.length} Ollama requests`);

// ---- the end
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
check(!out.some((l) => l.includes(KEY_A) || l.includes(KEY_B) || l.includes('sk-old-saved-key')), 'no key in the app\'s output');
await M(`BrowserWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(TITLE)})?.destroy(); return 1;`).catch(() => {});
await stop(S);
// the sealed keys open again after a restart: the next start reads them back
S = await start();
const back = JSON.parse(await S.page('JSON.stringify(window.maverickTest.settings().connections.map((c) => c.key || ""))'));
check(back.includes(KEY_A) && back.includes(KEY_B) && back.includes('sk-old-saved-key'), '5. after a restart the sealed keys read back as the keys');
await stop(S);
S = null;
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nmodels proof passed');
finish(fails.length ? 1 : 0);
