// node test/screenread-proof.mjs   (Windows 11; Ollama with gemma4:12b)
// Proves screen reads in the real desktop app on a temp profile (MAVERICK_USER_DATA, MAVERICK_TEST_HOOKS=1):
//   1. A window made here is the shared meeting screen (Settings, Share meeting captures it by name). Slide A shows a
//      number that is only on the screen; the local vision model reads it once the slide is steady.
//   2. A transcript line says "As you can see, this is our target for the quarter." (the test hook adds it the way a
//      finished transcription does); it is linked to slide A's read.
//   3. Slide B replaces it; a flicker (another picture for under one sample) does not make a second read of anything.
//   3b. Covered by another window, the slide window stops painting: the app says its view is stale, reads nothing, and
//      reads the slide that changed under the cover once the window shows again.
//   4. Asking "What target did they point at?" after slide A is gone answers with slide A's number and a [mm:ss] citation.
//   5. End & summarize: the notes mention slide A's number; History keeps the screen reads.
//   6. The user's real profile (%APPDATA%\maverick) is byte-identical afterwards. Only the PIDs started here are killed.
// Prints "screen read proof passed" only when every check passed; otherwise exits 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'features');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return !!ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
const PORT = 9339;
const INSPECT = 9239;

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-screenread-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
});
const out = [];
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
const finish = (code) => { writeFileSync(join(OUT, 'screenread-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
const bail = (e) => { log(`FAIL: ${e?.stack || e}`); killTree(app.pid); finish(1); };
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

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
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };
const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 30000); if (!t) throw new Error('no debug target'); return t; };
const main = await cdp((await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json())[0]; } catch { return null; } }, 30000)).webSocketDebuggerUrl);
const M = (body) => main(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); const W = BrowserWindow.getAllWindows(); const bar = W.find((w) => w.webContents.getURL() === 'about:blank'); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
const bar = await cdp((await target((t) => t.type === 'page' && t.url === 'about:blank')).webSocketDebuggerUrl);
await until(() => M('return !!bar && bar.isVisible();'), 15000);
await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy') && !!window.maverickTest; })()"), 30000);
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);

// ---- the shared screen: a window made here
const TITLE = 'Screen read proof slide';
const SLIDES = {
  A: '<div style="height:100%;background:#fff;color:#111;font-family:Segoe UI,sans-serif"><div style="background:#7a1f5c;color:#fff;padding:28px 48px;font-size:42px;font-weight:700">Q3 sales target</div><div style="padding:60px 48px 0;font-size:120px;font-weight:800;color:#7a1f5c">4,750 units</div><div style="padding:16px 48px;font-size:28px;color:#555">All regions, July to September</div></div>',
  B: '<div style="height:100%;display:flex;background:#eef3f8;color:#111;font-family:Segoe UI,sans-serif"><div style="width:40%;background:#0b5394;color:#fff;padding:48px;font-size:46px;font-weight:700">Agenda</div><div style="padding:48px;font-size:34px;line-height:1.7">1. Supplier update<br>2. Store openings<br>3. Open questions</div></div>',
  F: '<div style="height:100%;background:#111"></div>',
  C: '<div style="height:100%;background:#fff6e5;color:#111;font-family:Segoe UI,sans-serif;padding:48px"><div style="font-size:46px;font-weight:700;color:#8a4b00">Store openings</div><div style="font-size:96px;font-weight:800;margin-top:40px">12 new stores</div></div>',
};
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title><style>html,body{margin:0;height:100%}#s{height:100%}</style></head><body><div id="s"></div></body></html>`;
// Always on top: a window covered by another app's stops being painted, and its capture freezes (desktop/main.cjs,
// shareView). screenread-proof covers it on purpose once; anywhere else that would be a test accident.
await M(`const w = new BrowserWindow({ x: 60, y: 80, width: 960, height: 600, show: false, title: ${JSON.stringify(TITLE)}, skipTaskbar: true, focusable: false, alwaysOnTop: true, autoHideMenuBar: true });
  w.on('page-title-updated', (e) => e.preventDefault());
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(html)})); w.showInactive(); return 1;`);
const show = (k) => M(`const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === ${JSON.stringify(TITLE)}); await w.webContents.executeJavaScript(${JSON.stringify(`document.getElementById('s').innerHTML = ${JSON.stringify(SLIDES[k])}; 1`)}); return 1;`);
await show('A');
await page(`window.maverick.saveSettings({ source: ${JSON.stringify(TITLE)} }).then(() => 1)`);
const screens = () => page('JSON.stringify(window.maverickTest.screens())').then(JSON.parse);
const slides = () => page('JSON.stringify(window.maverickTest.slides())').then(JSON.parse);

// ================================================================= 1. slide A is read
await page("document.querySelector('#btn-share').click(); 1");
check(await until(() => page("(document.querySelector('#preview').videoWidth || 0) > 0"), 20000), 'Share meeting captures the proof window');
const t0 = Date.now();
const a = await until(async () => { const s = await screens(); return s[0]?.text ? s[0] : null; }, 180000, 1000);
log(`slide A read after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(a)}`);
check(a && /4[,.\s]?750/.test(a.text), `slide A is read by the local model, with its number: "${a?.text.replace(/\s+/g, ' ').slice(0, 160)}"`);

// ================================================================= 2. the pointing line is linked to slide A's read
await page("window.maverickTest.addLine('Speaker 1', 'As you can see, this is our target for the quarter.')");
const pointed = JSON.parse(await page('JSON.stringify(window.maverickTest.lines().at(-1))'));
check(a && pointed.screen === a.t, `the line "${pointed.text}" points at slide A's read (screen ${pointed.screen}, read ${a?.t})`);

// ================================================================= 3. slide B, then a flicker that must not make a read
await sleep(1500);
await show('B');
const b = await until(async () => { const s = await screens(); return s.length >= 2 && s[1].text ? s[1] : null; }, 180000, 1000);
check(b && /agenda|supplier/i.test(b.text), `slide B is read: "${b?.text.replace(/\s+/g, ' ').slice(0, 120)}"`);
let flicked = false;
for (let i = 0; i < 4 && !flicked; i++) {
  const before = await slides();
  await show('F');
  await sleep(450); // under the 700 ms sample: at most one frame of it is seen
  await show('B');
  await sleep(2500);
  const after = await slides();
  log(`flicker try ${i + 1}: ${JSON.stringify({ before, after })}`);
  flicked = after.flickers > before.flickers;
  if (after.changes !== before.changes) break;
}
await sleep(1500);
const all = await screens();
check(flicked && all.length === 2, `the flicker was seen by the tracker and made no second read: ${all.length} reads (${all.map((s) => s.text.replace(/\s+/g, ' ').slice(0, 40)).join(' | ')})`);

// ================================================================= 3b. the shared window covered: the view is stale, then recovers
// Covered by another window, the slide window stops being painted (Chromium marks it occluded) and its capture repeats
// the last picture: three runs read slide B as "undefined" this way. The app must say its view is stale, take no read of
// the frozen picture, and pick the window up again once it shows.
const PW = `BrowserWindow.getAllWindows().find((x) => x.getTitle() === ${JSON.stringify(TITLE)})`;
const view = () => page('JSON.stringify(window.maverickTest.view())').then(JSON.parse);
await M(`${PW}.setAlwaysOnTop(false); const c = new BrowserWindow({ x: 0, y: 0, width: 1600, height: 1000, show: false, title: 'screenread cover', backgroundColor: '#333', skipTaskbar: true });
  await c.loadURL('data:text/html,<body style=background:#333>'); c.show(); c.focus(); return 1;`);
await sleep(1000);
await show('C');
const stale = await until(async () => { const v = await view(); return v.stale ? v : null; }, 10000, 500);
const staleMsg = await page("document.querySelector('#banners [data-key=view] .msg')?.textContent || ''");
check(stale && /covered/.test(stale.stale) && /Screen read proof slide/.test(staleMsg), `covered, the screen view is reported stale: ${stale?.stale}; banner "${staleMsg.slice(0, 160)}"`);
await sleep(3000);
check((await screens()).length === 2, 'no read is taken of the frozen picture while the window is covered');
await M(`BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'screenread cover')?.destroy(); ${PW}.setAlwaysOnTop(true); return 1;`);
const cleared = await until(async () => !(await view()).stale, 10000, 500);
const c = await until(async () => { const s = await screens(); return s.length >= 3 && s[2].text ? s[2] : null; }, 180000, 1000);
check(cleared && c && /store openings|12 new stores/i.test(c.text), `shown again, the view recovers and the slide changed under the cover is read: "${c?.text.replace(/\s+/g, ' ').slice(0, 120)}"`);
check(!(await page("document.querySelector('#banners [data-key=view]') ? 1 : 0")), 'the stale banner is gone once the window shows');
await page("window.maverickTest.addLine('Speaker 2', 'Okay, let us move on to the agenda.')");

// ================================================================= 4. the question after the slide is gone
const Q = 'What target did they point at?';
await bar(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(Q)}; f.requestSubmit(); return 1; })()`);
const card = await until(() => page(`(() => { const a = document.querySelector('#answers .answer'); if (!a || a.querySelector('.q').textContent !== ${JSON.stringify(Q)} || a.getAttribute('aria-busy') !== 'false') return '';
  return JSON.stringify({ text: a.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(), times: [...a.querySelectorAll('.cite[data-cmd="cite"]')].map((c) => c.dataset.t), error: a.classList.contains('error') }); })()`), 240000, 500);
const ans = JSON.parse(card || '{}');
log(`answer: ${JSON.stringify(ans)}`);
check(/4[,.\s]?750/.test(ans.text || '') && ans.times?.length >= 1 && !ans.error, `the answer names slide A's number and cites a moment: "${ans.text?.slice(0, 200)}" [${ans.times?.join(', ')}]`);

// ================================================================= 5. End & summarize: the notes mention slide A
const before = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")).length;
await page("document.querySelector('#btn-end').click(); 1");
const saved = await until(async () => { const h = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")); return h.length > before && 'summary' in h.at(-1) ? h.at(-1) : null; /* saved at the press, then with its notes */ }, 400000, 1000);
const notes = await page("document.querySelector('#sum-body').innerText");
log(`notes: ${notes.replace(/\s+/g, ' ').slice(0, 600)}`);
check(/4[,.\s]?750/.test(saved?.summary || ''), 'the meeting notes mention slide A\'s number');
check(saved?.screens?.length === 3 && saved.transcript.some((l) => l.screen === saved.screens[0].t), `History keeps the three screen reads (A, B, and C from 3b) and the line that pointed at slide A`);
await page("document.querySelector('#dlg-summary').close(); 1");

const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M(`BrowserWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(TITLE)})?.destroy(); app.quit(); return 1;`).catch(() => {});
page.close(); bar.close(); main.close();
if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
await sleep(1000);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nscreen read proof passed');
finish(fails.length ? 1 : 0);
