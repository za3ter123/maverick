// node test/copilot-proof.mjs   (Windows 11; Ollama with gemma4:12b and embeddinggemma; the claude CLI for the egress control)
// Proves the copilot batch in the real desktop app on a temp profile (MAVERICK_USER_DATA, MAVERICK_TEST_HOOKS=1), one
// named check per feature. The shared "meeting screen" is a window this proof opens (Settings, Share meeting captures
// that window by name); transcript lines arrive through the test hook the way a finished transcription adds them.
//   1 live captions        2 question caught in the ask field, Enter answers it   3 smart assist routes three ways
//   4 slide change once, not on flicker   5 earlier meetings in the prompt   6 style rules change the answer
//   7 egress counter: 0 bytes for local models, counts for Web   8 Arabic math stays left to right
//   9 [mm:ss] and [file p.N] citations open their moment and page, live and in History (recording player seeks)
//   10 speed meter on the card and in History   11 remote session warning (a second start with SESSIONNAME=RDP-Tcp#0)
//   13a a not-found card names what is missing   13b a false premise is corrected from the file, with its citation
// The owner's real profile (%APPDATA%\maverick) must be byte-identical afterwards. Only the PIDs started here are killed.
// Prints "copilot proof passed" only when every check passed; otherwise exits 1.
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
const PORT = 9338;
const INSPECT = 9238;

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

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

// One start of the app: { app, main (main process), M, page, bar, out, profile }
async function start(extraEnv = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'maverick-copilot-'));
  const app = spawn(electron, ['.', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
    cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: profile, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '', ...extraEnv },
  });
  const out = [];
  for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };
  const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 30000); if (!t) throw new Error('no debug target'); return t; };
  const main = await cdp((await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json())[0]; } catch { return null; } }, 30000)).webSocketDebuggerUrl);
  const M = (body) => main(`(async () => { const { app, BrowserWindow, screen, globalShortcut } = process.mainModule.require('electron'); const fs = process.mainModule.require('node:fs'); const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); const bar = W.find((w) => w.webContents.getURL() === 'about:blank'); ${body} })()`);
  const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
  const bar = await cdp((await target((t) => t.type === 'page' && t.url === 'about:blank')).webSocketDebuggerUrl);
  await until(() => M('return !!bar && bar.isVisible();'), 15000);
  await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy') && !!window.maverickTest; })()"), 30000);
  return { app, main, M, page, bar, out, profile };
}
async function stop(s) {
  await s.M('app.quit(); return 1;').catch(() => {});
  s.page.close(); s.bar.close(); s.main.close();
  if (!(await until(async () => s.app.exitCode !== null, 8000, 200))) killTree(s.app.pid);
  await sleep(800);
}

let S = null;
const finish = (code) => { writeFileSync(join(OUT, 'copilot-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
const bail = (e) => { log(`FAIL: ${e?.stack || e}`); if (S) killTree(S.app.pid); finish(1); };
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

S = await start();
const { M, page, bar } = S;
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
check((await M("return app.getPath('userData');")).toLowerCase() === S.profile.toLowerCase(), `the app runs in the temp profile ${S.profile}`);

// ---- History with four earlier meetings (feature 5), and a recording folder so History has a player (feature 9)
const EARLIER = [
  ['Atlas kickoff', '2026-10-01', '## Summary\nKickoff for Project Atlas.\n## Decisions\n- The pilot runs in three stores.'],
  ['Marketing review', '2026-10-05', '## Summary\nMarketing plan for Atlas.\n## Decisions\n- The marketing budget is 85,000 KWD.'],
  ['Supplier call', '2026-10-09', '## Summary\nCall with Gulf Cold Chain.\n## Decisions\n- Deliveries start on 1 March.'],
  ['Hiring sync', '2026-10-12', '## Summary\nQ3 hiring.\n## Decisions\n- Six engineers will be hired.'],
].map(([title, day, summary], i) => ({ id: `earlier-${i}`, title, startedAt: Date.parse(`${day}T09:00:00Z`), endedAt: Date.parse(`${day}T09:30:00Z`), transcript: [], flags: [], answers: [], summary }));
await page(`localStorage.setItem('maverick.meetings', ${JSON.stringify(JSON.stringify(EARLIER))}); 1`);
const REC_DIR = mkdtempSync(join(tmpdir(), 'maverick-copilot-rec-'));

// ---- the Library: the Atlas brief (text PDF, made by Chromium here), for citations and 13a/13b
const FIX = mkdtempSync(join(tmpdir(), 'maverick-copilot-fix-'));
const PDF = join(FIX, 'atlas-project-brief.pdf');
const FILLER = 'This section repeats the planning notes so the page carries a realistic amount of text around the fact above it. '.repeat(5);
const TEXT_PDF = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:15px/1.6 "Segoe UI",sans-serif;color:#111} section{padding:56px 64px;page-break-after:always;min-height:900px} h1{font-size:24px;margin:0 0 18px} p{margin:0 0 14px}</style></head><body>
<section><h1>Project Atlas brief</h1><p>Project Atlas launches on 14 March 2027 in Kuwait City, after a two week pilot with three stores.</p><p>${FILLER}</p></section>
<section><h1>Budget and team</h1><p>The approved budget for Project Atlas is 2.4 million KWD, signed off by the finance committee. The lead engineer is Fatemah Alsabah, and QRN Logistics runs the deliveries.</p><p>${FILLER}</p></section>
<section dir="rtl" lang="ar"><h1>المستودع</h1><p>يقع المستودع الرئيسي لمشروع أطلس في منطقة الشويخ الصناعية، وتبلغ سعته ١٢٠٠ منصة تخزين مبردة.</p><p>يعمل المستودع على مدار الساعة طوال أيام الأسبوع، ويديره فريق من خمسة عشر موظفا.</p></section>
</body></html>`;
await M(`const w = new BrowserWindow({ width: 800, height: 1000, show: false, title: 'proof fixture', webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(TEXT_PDF)})); await new Promise((r) => setTimeout(r, 600));
  fs.writeFileSync(${JSON.stringify(PDF)}, await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })); w.destroy(); return 1;`);
await page("document.querySelector('#btn-library').click(); 1");
await page.send('DOM.enable');
const docNode = (await page.send('DOM.getDocument')).root.nodeId;
await page.send('DOM.setFileInputFiles', { nodeId: (await page.send('DOM.querySelector', { nodeId: docNode, selector: '#lib-input' })).nodeId, files: [PDF] });
const libReady = await until(() => page("(() => { const r = document.querySelector('#lib-list .lib-row'); return r && r.dataset.status === 'ready'; })()"), 300000, 1000);
check(libReady, 'the Atlas brief is in the Library, ready');
await page("document.querySelector('#dlg-library').close(); 1");

// ---- the shared screen: a window made here, captured by name (Settings, Share meeting captures)
const SLIDE_TITLE = 'Copilot proof slide';
const slideHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${SLIDE_TITLE}</title><style>html,body{margin:0;height:100%;font-family:"Segoe UI",sans-serif}#s{height:100%}</style></head><body><div id="s"></div></body></html>`;
const SLIDES = {
  results: '<div style="height:100%;background:#fff;color:#111"><div style="background:#0b3d91;color:#fff;padding:28px 48px;font-size:44px;font-weight:700">Q3 results</div><div style="padding:30px 48px;font-size:30px">Revenue 2.4M KWD, up 12% on Q2</div><div style="display:flex;align-items:flex-end;gap:40px;height:260px;padding:0 80px"><div style="width:120px;height:120px;background:#999"></div><div style="width:120px;height:180px;background:#666"></div><div style="width:120px;height:240px;background:#0b3d91"></div></div></div>',
  plan: '<div style="height:100%;display:flex;background:#f4f4f4;color:#111"><div style="width:38%;background:#1f8a4c;color:#fff;padding:48px;font-size:48px;font-weight:700">Hiring plan</div><div style="padding:48px;font-size:32px;line-height:1.6">Engineers to hire: 6<br>Designers to hire: 2<br>Interviews start 5 October</div></div>',
  code: '<div style="height:100%;background:#1e1e1e;color:#d4d4d4;padding:36px 48px;font:26px/1.5 Consolas,monospace"><div style="color:#569cd6;font:700 30px Segoe UI">Exercise 4: write a function</div><div>Given an array of integers nums and a target, return the indices of the two numbers that add up to target.</div><pre style="margin-top:24px;color:#ce9178">def two_sum(nums, target):\n    # your code here\n    pass\n\nprint(two_sum([2, 7, 11, 15], 9))  # expect [0, 1]</pre></div>',
  flash: '<div style="height:100%;background:#c62828"></div>',
};
// Always on top: a window covered by another app's stops being painted, and its capture freezes (desktop/main.cjs,
// shareView). screenread-proof covers it on purpose once; anywhere else that would be a test accident.
await M(`const w = new BrowserWindow({ x: 40, y: 60, width: 960, height: 600, show: false, title: ${JSON.stringify(SLIDE_TITLE)}, skipTaskbar: true, focusable: false, alwaysOnTop: true, autoHideMenuBar: true });
  w.on('page-title-updated', (e) => e.preventDefault());
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(slideHtml)})); w.showInactive(); return 1;`);
const showSlide = (key) => M(`const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === ${JSON.stringify(SLIDE_TITLE)}); await w.webContents.executeJavaScript(${JSON.stringify(`document.getElementById('s').innerHTML = ${JSON.stringify(SLIDES[key])}; 1`)}); return 1;`);
await showSlide('results');
await page(`window.maverick.saveSettings({ source: ${JSON.stringify(SLIDE_TITLE)}, recordMode: 'audio', recordDir: ${JSON.stringify(REC_DIR)} }).then(() => 1)`);
const assistKey = await M("return globalShortcut.isRegistered('Ctrl+Shift+6');");
log(`Ctrl+Shift+6 (smart assist) registered as a global hotkey: ${assistKey} (false means another running app holds it; the proof sends the same action the key sends)`);

// ---- start the meeting: Share meeting
await page("document.querySelector('#btn-share').click(); 1");
check(await until(() => page("(document.querySelector('#preview').videoWidth || 0) > 0"), 20000), 'Share meeting captures the proof window');
const slides = () => page('JSON.stringify(window.maverickTest.slides())').then(JSON.parse);
const screens = () => page('JSON.stringify(window.maverickTest.screens())').then(JSON.parse);
const egressText = () => page("(() => { const e = document.querySelector('#st-egress'); return e.hidden ? '' : e.textContent.trim(); })()");

// ================================================================= 4. slide tracking: the first screen, a new slide, a flicker
let st = await until(async () => { const x = await slides(); return x.changes >= 1 ? x : null; }, 15000);
check(st, `4: the first screen is detected once it is steady (${JSON.stringify(st)})`);
await until(async () => (await screens())[0]?.text, 120000, 1000);
await showSlide('plan');
const afterPlan = await until(async () => { const x = await slides(); return x.changes >= 2 ? x : null; }, 15000);
check(afterPlan?.changes === 2, `4: the next slide counts once: ${afterPlan?.changes} changes after one slide change`);
await until(async () => (await screens()).length >= 2 && (await screens())[1].text, 120000, 1000);
let flick = null;
for (let i = 0; i < 4 && !flick; i++) {
  const before = await slides();
  await showSlide('flash');
  await sleep(450); // shorter than the 700 ms sample, so at most one sampled frame
  await showSlide('plan');
  await sleep(2500);
  const after = await slides();
  log(`flicker try ${i + 1}: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  if (after.flickers > before.flickers) flick = { before, after };
  else if (after.changes !== before.changes) { flick = { before, after }; break; }
}
check(flick && flick.after.changes === flick.before.changes && flick.after.flickers > flick.before.flickers,
  `4: a one-frame flicker was sampled and did not count as a slide (changes ${flick?.before.changes} -> ${flick?.after.changes}, flickers ${flick?.before.flickers} -> ${flick?.after.flickers})`);
const reads = await screens();
log(`screen reads: ${JSON.stringify(reads.map((r) => ({ t: r.t, text: r.text.slice(0, 160) })))}`);
check(reads.length === 2 && /results|revenue/i.test(reads[0].text) && /hiring|engineers/i.test(reads[1].text), `4: two screen reads, one per slide, none for the flicker (${reads.length})`);

// ================================================================= 1. live captions
await page("window.maverickTest.addLine('Speaker 1', 'We closed the quarter ahead of plan, and the pilot stores did well.')");
const cap = await until(() => bar("(() => { const c = document.querySelector('.mini-caption'); return c && !c.hidden ? c.textContent : ''; })()"), 3000);
check(cap && /closed the quarter ahead of plan/.test(cap), `1: the bar shows the latest line as a caption: "${cap}"`);

// helpers for cards (the main window's newest card)
const card = () => page(`(() => { const a = document.querySelector('#answers .answer'); if (!a) return 'null'; const nf = a.querySelector('.not-found');
  return JSON.stringify({ id: a.dataset.id, label: a.querySelector('.tag').textContent, q: a.querySelector('.q').textContent, busy: a.getAttribute('aria-busy'), text: a.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(),
    li: a.querySelectorAll('.md li').length, p: a.querySelectorAll('.md p').length, route: a.querySelector('.tag.route')?.dataset.tip || '', speed: a.querySelector('.answer-head .speed')?.textContent || '', when: a.querySelector('.when')?.textContent || '',
    times: [...a.querySelectorAll('.cite[data-cmd="cite"]')].map((c) => c.dataset.t), chips: [...a.querySelectorAll('.cite.src')].map((c) => c.textContent),
    nf: nf ? nf.querySelector('.msg').textContent : null, error: a.classList.contains('error') }); })()`).then(JSON.parse);
async function settled(prevId, ms = 240000) {
  return until(async () => { const c = await card(); return c && c.id !== prevId && c.busy === 'false' ? c : null; }, ms, 400);
}
const lastId = async () => (await card())?.id ?? null;
const ask = async (q) => { const id = await lastId(); await bar(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(q)}; f.requestSubmit(); return 1; })()`); const c = await settled(id); log(`asked "${q}": ${JSON.stringify(c)}`); return c; };
const lastPrompt = () => page("JSON.stringify(window.maverickTest.lastPrompt)").then(JSON.parse);

// ================================================================= 2. a question from the other side lands in the ask field; Enter answers it
const Q = 'Can you tell us when Project Atlas launches and where?';
let id0 = await lastId();
await page(`window.maverickTest.addLine('Speaker 2', ${JSON.stringify(Q)})`);
const caught = await until(() => bar("document.querySelector('form.ask input').value"), 3000);
await sleep(3000);
check(caught === Q && (await lastId()) === id0, `2: the question lands in the bar's ask field and is not sent on its own: "${caught}"`);
await bar("document.querySelector('form.ask input').focus(); 1");
await bar.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await bar.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
await bar.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
let c = await settled(id0);
log(`Enter on the caught question: ${JSON.stringify(c)}`);
check(c && c.label === 'Answer' && c.q === Q && c.text.length > 20 && !c.error, `2: Enter answers it: an Answer card for "${c?.q}" (${c?.text.length} characters)`);
const p2 = await lastPrompt();
check(p2 && p2[1].content.includes(`The question to answer, just asked in the meeting: ${Q}`), '2: the answer prompt names the caught question');
// 10. speed meter (shown on the card; History is checked after End & summarize)
check(c && /^· \d+\.\d s$/.test(c.speed) && /^\d{2}:\d{2}$/.test(c.when), `10: the card shows the time from the key press to the first word: "${c?.speed}"`);
// 5. earlier meetings: the three newest, labelled, not the oldest
const earlier = p2?.[1].content.match(/### Earlier meeting E\d: [^\n]+/g) || [];
check(earlier.length === 3 && /Hiring sync/.test(earlier[0]) && !/Atlas kickoff/.test(p2[1].content) && /^Earlier meetings, from my History/m.test(p2[1].content),
  `5: the answer prompt carries the last three meetings' notes, labelled as earlier meetings: ${JSON.stringify(earlier)}`);
// 12 (screen reads) and the transcript: the prompt carries both
check(p2 && /\[\d\d:\d\d\] Screen: /.test(p2[1].content), '12: the answer prompt carries the screen reads');

// ================================================================= 3. smart assist: question -> Answer, slide -> Explain, code -> Solve
const assist = async () => { const id = await lastId(); await M("page.webContents.send('action', 'assist'); return 1;"); return settled(id); };
await page("window.maverickTest.addLine('Speaker 1', 'What budget did we approve for Atlas?')");
await sleep(500);
c = await assist();
log(`assist with a fresh question: ${JSON.stringify(c)}`);
check(c && c.label === 'Answer' && /question/.test(c.route) && /budget/i.test(c.q), `3: a fresh question routes to Answer, and the card says why: "${c?.route}"`);
c = await assist();
log(`assist with a slide and no new question: ${JSON.stringify(c)}`);
check(c && c.label === 'Explain screen' && /slide or document/.test(c.route) && /hiring|engineer/i.test(c.text), `3: a slide with no new question routes to Explain screen: "${c?.route}"`);
await showSlide('code');
await until(async () => (await screens()).length >= 3 && (await screens())[2].text, 150000, 1000);
c = await assist();
log(`assist with a code problem on screen: ${JSON.stringify(c)}`);
check(c && c.label === 'Solve' && /code|problem/.test(c.route) && /def two_sum|return/.test(c.text), `3: a code problem on screen routes to Solve: "${c?.route}"`);

// ================================================================= 5. the earlier meetings are used: a real answer from them
c = await ask('What marketing budget did we decide on in an earlier meeting?');
check(c && /85,?000/.test(c.text), `5: an answer uses an earlier meeting's notes: "${c?.text.slice(0, 160)}"`);

// ================================================================= 6. style rules from Settings change the answer
const STYLE_Q = 'In one line, what is the capital of France?';
const plain = await ask(STYLE_Q);
await page("document.querySelector('#btn-settings').click(); 1");
await sleep(600);
await page("(() => { const t = document.querySelector('#set-style'); t.value = 'Answer in exactly two bullet points and nothing else.'; t.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
await sleep(1200);
await page("document.querySelector('#dlg-settings').close(); 1");
const styled = await ask(STYLE_Q);
const sp = await lastPrompt();
check(plain && styled && styled.li === 2 && styled.p === 0 && plain.li !== 2 && sp[1].content.includes('My style rules, follow them in this answer: Answer in exactly two bullet points and nothing else.'),
  `6: the style rule changes the answer: without it ${plain?.li} bullets and ${plain?.p} paragraphs, with it ${styled?.li} bullets and ${styled?.p} paragraphs`);
await page("document.querySelector('#btn-settings').click(); 1"); await sleep(500);
await page("(() => { const t = document.querySelector('#set-style'); t.value = ''; t.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
await sleep(1200);
await page("document.querySelector('#dlg-settings').close(); 1");

// ================================================================= 8. Arabic math stays left to right
c = await ask('احسب ناتج 12 × 3 + 4 واكتب المعادلة كاملة مع الناتج.');
const math = await page(`(() => { const a = document.querySelector('#answers .answer'); const b = [...a.querySelectorAll('.md bdi[dir="ltr"]')].find((x) => /=/.test(x.textContent) && /\\d/.test(x.textContent));
  if (!b) return JSON.stringify({ found: false, html: a.querySelector('.md').innerHTML.slice(0, 400) });
  const block = b.closest('p, li'); const node = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); const pos = [];
  for (let n = node.nextNode(); n; n = node.nextNode()) for (let i = 0; i < n.length; i++) { if (!n.data[i].trim()) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); pos.push([n.data[i], r.getBoundingClientRect().left]); }
  return JSON.stringify({ found: true, text: b.textContent, dir: getComputedStyle(b).direction, blockDir: getComputedStyle(block).direction, ordered: pos.every((p, i) => i === 0 || p[1] > pos[i - 1][1]), pos: pos.map((p) => p[0]).join('') }); })()`).then(JSON.parse);
log(`Arabic math: ${JSON.stringify(math)}; answer: ${c?.text.slice(0, 200)}`);
check(math.found && math.dir === 'ltr' && math.blockDir === 'rtl' && math.ordered && /40/.test(c?.text || ''),
  `8: in an Arabic (right to left) answer the formula "${math.text}" is laid out left to right, every character to the right of the one before`);

// ================================================================= 9. citations: a [mm:ss] chip shows its moment; a [file p.N] chip opens its page
c = await ask('Recap what Speaker 2 asked, and cite the time.');
let timeChip = c?.times[0];
if (!timeChip) { const id = await lastId(); await page("document.querySelector('[data-action=\"recap\"]').click(); 1"); c = await settled(id); timeChip = c?.times[0]; }
if (timeChip) {
  await page(`(() => { document.querySelector('#answers .answer .cite[data-cmd="cite"]').click(); return 1; })()`);
  const hit = await until(() => page("(() => { const li = document.querySelector('#transcript .line.hit'); return li ? li.querySelector('time').textContent : ''; })()"), 3000, 100);
  check(hit && Math.abs(hit.split(':').reduce((a, n) => a * 60 + Number(n), 0) - timeChip.split(':').reduce((a, n) => a * 60 + Number(n), 0)) <= 30, `9: the [${timeChip}] chip shows the transcript line at ${hit}`);
} else check(false, '9: an answer with a [mm:ss] chip');

// 13a, 13b and the [file p.N] chip: My material only
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"material\"]').click(); return 1; })()");
await sleep(400);
c = await ask('ما هو رقم هاتف مدير المستودع في الشويخ؟');
check(c && c.nf && !/^(No passage in your files backs an answer|Your files do not answer this)\.?$/.test(c.nf) && c.nf.length > 12, `13a: the not-found card names what is missing: "${c?.nf}"`);
c = await ask('Why was the Atlas launch postponed to June 2027?');
check(c && !c.nf && /14 March 2027/.test(c.text) && c.chips.includes('atlas-project-brief.pdf p.1'), `13b: the false premise is answered with what the file says and its citation: "${c?.text.slice(0, 200)}" ${JSON.stringify(c?.chips)}`);
c = await ask('When does Project Atlas launch?');
if (c?.chips.includes('atlas-project-brief.pdf p.1')) {
  await page("[...document.querySelectorAll('#answers .answer .cite.src')][0].click(); 1");
  const v = await until(() => page("(() => { const d = document.querySelector('#dlg-viewer'); return d.open && d.querySelector('canvas')?.width ? d.querySelector('#view-page').textContent : ''; })()"), 15000);
  check(/Page 1 of 3/.test(v || ''), `9: the [atlas-project-brief.pdf p.1] chip opens the file at its page: "${v}"`);
  await page("document.querySelector('#dlg-viewer').close(); 1");
} else check(false, `9: a cited answer from the file: ${JSON.stringify(c)}`);
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"meeting\"]').click(); return 1; })()");

// ================================================================= 7. bytes sent off this PC: 0 with local models, counted for Web
const zero = await egressText();
check(zero === '0 bytes sent off this PC', `7: after ${await page("document.querySelectorAll('#answers .answer').length")} local answers, the header reads "${zero}"`);
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"web\"]').click(); return 1; })()");
await sleep(300);
c = await ask('In one sentence, what is the capital of Kuwait? Cite one page.');
const after = await egressText();
const sent = await page('window.maverickTest.lines().length && JSON.parse(localStorage.getItem("maverick.live") || "{}").egress || 0');
log(`egress after one Web answer: "${after}" (${sent} bytes in the live meeting)`);
check(after && after !== zero && /sent off this PC/.test(after), `7: control: a Web answer through Claude Code is counted: "${after}"`);
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"meeting\"]').click(); return 1; })()");

// ================================================================= End & summarize, then History
const remoteTip = await page("document.querySelector('#st-share').dataset.tip");
check(!/Remote Desktop/.test(remoteTip), `11: a console session shows no remote warning: "${remoteTip.slice(0, 120)}"`);
const before = JSON.parse(await page("localStorage.getItem('maverick.meetings')")).length;
await page("document.querySelector('#btn-end').click(); 1");
const saved = await until(async () => { const h = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")); return h.length > before && 'summary' in h.at(-1) ? h.at(-1) : null; /* saved at the press, then with its notes */ }, 400000, 1000);
check(saved?.answers?.some((a) => a.ttfw > 0), `10: History keeps the speed meter: ${JSON.stringify(saved?.answers?.map((a) => a.ttfw))}`);
check(saved?.screens?.length >= 3 && saved.recording?.file, `12: the meeting in History has its ${saved?.screens?.length} screen reads and its recording`);
await page("document.querySelector('#dlg-summary').close(); 1");
await page("document.querySelector('#btn-history').click(); 1");
await until(() => page("document.querySelector('#dlg-history').open"), 3000);
await page(`document.querySelector('#hist-list button[data-id=${JSON.stringify(saved.id)}]').click(); 1`);
await until(() => page("(() => { const v = document.querySelector('#hist-detail audio'); return v && v.readyState >= 1; })()"), 15000);
const hchip = await page("(() => { const c = document.querySelector('#hist-detail .cite[data-cmd=\"cite\"]'); return c ? c.dataset.t : ''; })()");
if (hchip) {
  await page("document.querySelector('#hist-detail .cite[data-cmd=\"cite\"]').click(); 1");
  await sleep(1200);
  const h = JSON.parse(await page("(() => { const a = document.querySelector('#hist-detail audio'); const li = document.querySelector('#hist-detail li.hit'); a.pause(); return JSON.stringify({ played: a.played.length ? a.played.start(a.played.length - 1) : a.currentTime, li: li ? li.textContent.slice(0, 60) : '' }); })()"));
  const want = hchip.split(':').reduce((a, n) => a * 60 + Number(n), 0) - (saved.recording.startedAt - saved.startedAt) / 1000;
  check(h.li && Math.abs(h.played - Math.max(0, want)) <= 1.5, `9: in History the [${hchip}] chip shows its line ("${h.li}") and seeks the recording to ${h.played.toFixed(2)} s (want ${Math.max(0, want).toFixed(2)})`);
} else check(false, '9: History has a [mm:ss] chip in the notes or the answers');
const fchip = await page("(() => { const c = document.querySelector('#hist-detail .cite.src'); return c ? c.textContent : ''; })()");
if (fchip) {
  await page("document.querySelector('#hist-detail .cite.src').click(); 1");
  const v = await until(() => page("(() => { const d = document.querySelector('#dlg-viewer'); return d.open && d.querySelector('canvas')?.width ? d.querySelector('#view-page').textContent : ''; })()"), 15000);
  check(/Page \d of 3/.test(v || ''), `9: in History the [${fchip}] chip opens the file at its page: "${v}"`);
  await page("document.querySelector('#dlg-viewer').close(); 1");
} else check(false, '9: History has a [file p.N] chip');
await page("document.querySelector('#dlg-history').close(); 1");

const errs = S.out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M(`BrowserWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(SLIDE_TITLE)})?.destroy(); return 1;`);
await stop(S);

// ================================================================= 11. a Remote Desktop session: the warning (a second start)
S = await start({ SESSIONNAME: 'RDP-Tcp#0' });
const tip = await until(async () => { const t = await S.page("document.querySelector('#st-share').dataset.tip || ''"); return /Remote Desktop/.test(t) ? t : ''; }, 20000);
const bannerText = await S.page("document.querySelector('#banners [data-key=\"remote\"] .msg')?.textContent || ''");
const barTip = await S.bar("document.querySelector('.share-badge').dataset.tip || ''");
check(tip && /hiding from screen shares is not guaranteed/.test(tip) && /not guaranteed/.test(bannerText) && /Remote Desktop/.test(barTip),
  `11: with SESSIONNAME=RDP-Tcp#0 the badge tooltips (header and bar) and a banner warn: "${bannerText}"`);
await stop(S);

check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\ncopilot proof passed');
finish(fails.length ? 1 : 0);
