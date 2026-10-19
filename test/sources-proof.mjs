// node test/sources-proof.mjs   (Windows 11; Ollama with gemma4:12b and embeddinggemma; the claude CLI for the Web step)
// Proves Sources end to end in the real desktop app on a temp profile (MAVERICK_USER_DATA):
//   1. Fixtures made here, in a temp folder, by Chromium itself: a text PDF with known facts on known pages (page 3
//      in Arabic), a scanned PDF (its only page is an image of text, no text layer), and a PNG photo of a page.
//   2. They go into the Library through the real UI path: the Library dialog's file input (CDP sets its files, which
//      fires the same change event a person's choice does). Each must reach "Ready"; the scan and the photo must say
//      they were read from the image. A reload must find them again (IndexedDB).
//   3. My material only: four questions the files answer must cite the right file and page (and say the fact); two
//      they do not answer (one general knowledge) must get "Not in your material." with what is missing and "Add a
//      file", and no answer. A citation opens the viewer at that page with the passage marked.
//   4. Web: one current-events question through the Claude Code CLI must cite at least one URL. If the CLI is missing
//      or not logged in, the step is reported as SKIPPED with the reason, never faked.
//   5. Static files: PDF.js and its worker are served, every other node_modules path is 404, the CSP is unchanged.
//   6. The user's real profile (%APPDATA%\maverick) is byte-identical afterwards.
// Screenshots (dark and light) of the library, a cited answer, the viewer and a not-found card go to shots/features/.
// Prints "sources proof passed" only when every check passed; otherwise exits 1.
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
const ONLY = process.argv.includes('--import-only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return ok; };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const PS_DRAW = 'Add-Type -AssemblyName System.Drawing; Add-Type -Name D -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; [W.D]::SetProcessDPIAware() | Out-Null;';
const grab = (file, r) => ps(`${PS_DRAW} $b = New-Object System.Drawing.Bitmap ${r.width}, ${r.height}, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${r.x}, ${r.y}, 0, 0, $b.Size); $b.Save('${file}'); $g.Dispose(); $b.Dispose()`);
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-sources-'));
const FIX = mkdtempSync(join(tmpdir(), 'maverick-fixtures-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', '--remote-debugging-port=9335', '--inspect=9231'], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '1' },
});
const out = [];
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
const finish = (code) => { writeFileSync(join(OUT, 'sources-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
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
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9335/json/list')).json(); } catch { return []; } };
const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 20000); if (!t) throw new Error('no debug target'); return t; };
const main = await cdp((await until(async () => { try { return (await (await fetch('http://127.0.0.1:9231/json/list')).json())[0]; } catch { return null; } }, 20000)).webSocketDebuggerUrl);
const M = (body) => main(`(async () => { const { app, BrowserWindow, screen } = process.mainModule.require('electron'); const fs = process.mainModule.require('node:fs'); const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); const bar = W.find((w) => w.webContents.getURL() === 'about:blank'); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
let barTarget = await target((t) => t.type === 'page' && t.url === 'about:blank');
let bar = await cdp(barTarget.webSocketDebuggerUrl);
await until(() => M('return !!bar && bar.isVisible();'), 10000);
await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy'); })()"), 20000);
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);
const port = await page('location.port');

// ================================================================= 1. fixtures, made by Chromium in the app's main process
const FILLER = 'This section repeats the planning notes so the page carries a realistic amount of text around the fact above it. '.repeat(5);
const pageCss = 'body{margin:0;font:15px/1.6 "Segoe UI",sans-serif;color:#111} section{padding:56px 64px;page-break-after:always;min-height:900px} h1{font-size:24px;margin:0 0 18px} p{margin:0 0 14px}';
const TEXT_PDF = `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body>
<section><h1>Project Atlas brief</h1><p>Project Atlas launches on 14 March 2027 in Kuwait City, after a two week pilot with three stores.</p><p>${FILLER}</p></section>
<section><h1>Budget and team</h1><p>The approved budget for Project Atlas is 2.4 million KWD, signed off by the finance committee. The lead engineer is Fatemah Alsabah, and QRN Logistics runs the deliveries.</p><p>${FILLER}</p></section>
<section dir="rtl" lang="ar"><h1>المستودع</h1><p>يقع المستودع الرئيسي لمشروع أطلس في منطقة الشويخ الصناعية، وتبلغ سعته ١٢٠٠ منصة تخزين مبردة.</p><p>يعمل المستودع على مدار الساعة طوال أيام الأسبوع، ويديره فريق من خمسة عشر موظفا.</p></section>
</body></html>`;
const SCAN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:794px;height:1123px;background:#f7f5ef;font:22px/1.5 Georgia,serif;color:#1b1b1b}
div{padding:90px 80px;transform:rotate(-0.6deg)} h1{font-size:30px;margin:0 0 26px}</style></head><body><div><h1>Supply Agreement (signed copy)</h1>
<p>Supplier: Gulf Cold Chain Company.</p><p>Contract term: 36 months from the signing date.</p><p>Late delivery penalty: 2% of the order value for each week of delay.</p>
<p>Signed in Kuwait City.</p></div></body></html>`;
const PHOTO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1000px;height:700px;background:#6b6f73;display:grid;place-items:center}
div{width:760px;padding:40px 48px;background:#fbfbf8;box-shadow:0 12px 30px rgba(0,0,0,.45);transform:rotate(2deg);font:26px/1.5 "Segoe Print","Segoe UI",sans-serif;color:#222}
h1{font-size:32px;margin:0 0 16px}</style></head><body><div><h1>Q3 hiring plan</h1><p>Engineers to hire: 6</p><p>Designers to hire: 2</p><p>Interviews start on 5 October.</p></div></body></html>`;
const files = {
  text: join(FIX, 'atlas-project-brief.pdf'),
  scan: join(FIX, 'supplier-contract-scan.pdf'),
  photo: join(FIX, 'hiring-plan-photo.png'),
};
await M(`
  const win = (w, h) => new BrowserWindow({ width: w, height: h, show: false, title: 'proof fixture', webPreferences: { offscreen: true } });
  const load = async (w, html) => { await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await new Promise((r) => setTimeout(r, 600)); };
  const pdfOpts = { pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } };
  let w = win(800, 1000); await load(w, ${JSON.stringify(TEXT_PDF)});
  fs.writeFileSync(${JSON.stringify(files.text)}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
  // the scan: the page is photographed as pixels, and the PDF holds only that picture
  w = win(794, 1123); await load(w, ${JSON.stringify(SCAN_PAGE)});
  const shot = (await w.webContents.capturePage()).toPNG().toString('base64'); w.destroy();
  w = win(794, 1123); await load(w, '<!doctype html><html><head><style>@page{margin:0}body{margin:0}img{display:block;width:100%}</style></head><body><img src="data:image/png;base64,' + shot + '"></body></html>');
  fs.writeFileSync(${JSON.stringify(files.scan)}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
  w = win(1000, 700); await load(w, ${JSON.stringify(PHOTO_PAGE)});
  fs.writeFileSync(${JSON.stringify(files.photo)}, (await w.webContents.capturePage()).toPNG()); w.destroy();
  return 1;`);
for (const [k, f] of Object.entries(files)) check(existsSync(f) && readFileSync(f).length > 1000, `fixture ${k}: ${f} (${existsSync(f) ? readFileSync(f).length : 0} bytes)`);

// ================================================================= 2. import through the Library dialog
await page("document.querySelector('#btn-library').click(); 1");
check(await until(() => page("document.querySelector('#dlg-library').open"), 3000), 'the Library opens from the header button');
await page.send('DOM.enable');
const doc = (await page.send('DOM.getDocument')).root.nodeId;
const input = (await page.send('DOM.querySelector', { nodeId: doc, selector: '#lib-input' })).nodeId;
await page.send('DOM.setFileInputFiles', { nodeId: input, files: Object.values(files) });
const rows = () => page("JSON.stringify([...document.querySelectorAll('#lib-list .lib-row')].map((r) => ({ name: r.querySelector('b').textContent, status: r.dataset.status, text: r.querySelector('.status').textContent })))").then(JSON.parse);
const t0 = Date.now();
const done = await until(async () => { const r = await rows(); return r.length === 3 && r.every((x) => x.status === 'ready' || x.status === 'failed') ? r : null; }, 600000, 1000);
log(`library after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(done || await rows())}`);
const row = (name) => (done || []).find((r) => r.name === name);
check(row('atlas-project-brief.pdf')?.status === 'ready' && !/image/.test(row('atlas-project-brief.pdf').text), `the text PDF is ready from its text layer: "${row('atlas-project-brief.pdf')?.text}"`);
check(row('supplier-contract-scan.pdf')?.status === 'ready' && /1 scanned page read from the image/.test(row('supplier-contract-scan.pdf').text), `the scanned PDF is ready, read from the image: "${row('supplier-contract-scan.pdf')?.text}"`);
check(row('hiring-plan-photo.png')?.status === 'ready' && /read from the image/.test(row('hiring-plan-photo.png').text), `the photo is ready, read from the image: "${row('hiring-plan-photo.png')?.text}"`);
log(`usage line: ${await page("document.querySelector('#lib-usage').textContent")}`);

if (ONLY) {
  await M('app.quit(); return 1;').catch(() => {});
  await sleep(1500);
  killTree(app.pid);
  finish(fails.length ? 1 : 0);
}

// ---- what was read, for the log: the start of each page (the Arabic page, the scan and the photo matter most)
const read = await page("import('./src/libstore.mjs').then((s) => JSON.stringify(s.lib.files.map((f) => ({ name: f.name, pages: f.pages.map((p) => p.replace(/\\s+/g, ' ').slice(0, 160)) }))))");
log(`pages read: ${read}`);
// Chromium's PDF draws Arabic glyph by glyph, left to right, in presentation forms; the text must come out in reading order
const arPage = JSON.parse(read).find((f) => f.name === 'atlas-project-brief.pdf')?.pages[2] ?? '';
check(arPage.includes('يقع المستودع الرئيسي لمشروع أطلس'), `the Arabic page reads in order, as letters: "${arPage.slice(0, 80)}"`);

// ---- persisted in IndexedDB: a reload finds the same three files ready
const oldBar = barTarget.id;
await M('bar && bar.destroy(); return 1;');
await page.send('Page.reload', { ignoreCache: true });
barTarget = await target((t) => t.type === 'page' && t.url === 'about:blank' && t.id !== oldBar);
bar.close();
bar = await cdp(barTarget.webSocketDebuggerUrl);
await until(() => M('return !!bar && bar.isVisible();'), 10000);
await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy'); })()"), 20000);
await page("document.querySelector('#btn-library').click(); 1");
const again = await until(async () => { const r = await rows(); return r.length === 3 && r.every((x) => x.status === 'ready') ? r : null; }, 10000);
check(again, `after a reload the library still has the three files, ready (IndexedDB): ${JSON.stringify((again || []).map((r) => r.name))}`);
await page("document.querySelector('#dlg-library').close(); 1");

// ---- auto vocabulary: Settings shows names and acronyms from the files
await page("document.querySelector('#btn-settings').click(); 1"); await sleep(700);
const vocab = JSON.parse(await page("JSON.stringify({ on: document.querySelector('#set-file-vocab').checked, note: document.querySelector('#file-vocab-note').textContent })"));
check(vocab.on && /Atlas/.test(vocab.note) && /QRN|KWD|Alsabah/.test(vocab.note), `Settings, From your files is on by default and lists names from the files: "${vocab.note}"`);
await page("document.querySelector('#dlg-settings').close(); 1"); await sleep(300);

// ---- screenshots: a box of the main window lifted above the bar, or the bar itself
const centreBar = () => M('const b = bar.getBounds(); const d = screen.getPrimaryDisplay().workArea; bar.setPosition(Math.round(d.x + (d.width - b.width) / 2), d.y + 12); return 1;');
await centreBar();
const setTheme = async (t) => { await page(`(() => { const r = document.querySelector('input[name="appearance"][value="${t}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await sleep(800); };
async function shoot(name, which, sel) {
  let r;
  if (which === 'bar') {
    const b = JSON.parse(await M('return JSON.stringify(bar.getBounds());'));
    r = { x: b.x - 24, y: b.y - 8, width: b.width + 48, height: b.height + 16 };
  } else {
    await M("bar.hide(); page.show(); page.setAlwaysOnTop(true, 'screen-saver'); page.moveTop(); return 1;");
    await sleep(600);
    const cb = JSON.parse(await M('return JSON.stringify(page.getContentBounds());'));
    const el = JSON.parse(await page(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`));
    r = { x: Math.round(cb.x + el.x - 16), y: Math.round(cb.y + el.y - 16), width: Math.round(el.width + 32), height: Math.round(el.height + 32) };
  }
  await sleep(500);
  grab(join(OUT, `${name}.png`), r);
  if (which !== 'bar') await M('page.setAlwaysOnTop(false); bar.showInactive(); return 1;');
  log(`shot: shots/features/${name}.png (${r.width}x${r.height})`);
}
for (const t of ['dark', 'light']) {
  await setTheme(t);
  await page("document.querySelector('#btn-library').click(); 1"); await sleep(700);
  await shoot(`sources-library-${t}`, 'main', '#dlg-library');
  await page("document.querySelector('#dlg-library').close(); 1"); await sleep(300);
}

// ================================================================= 3. My material only
await page("(() => { const r = document.querySelector('input[name=\"sources\"][value=\"material\"]'); r.click(); return 1; })()");
await sleep(400);
check(await bar("document.querySelector('.src-btn').getAttribute('aria-label') === 'Sources: My material only'") && await page("localStorage.getItem('maverick.settings').includes('\"sources\":\"material\"')"),
  'Sources is My material only, shown in the bar and remembered in the settings');
const embedQ = "async (t) => (await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', body: JSON.stringify({ model: 'embeddinggemma', input: t }) })).json()).embeddings";
const scores = (q) => page(`import('./src/libstore.mjs').then(async (s) => JSON.stringify((await s.search(${JSON.stringify(q)}, ${embedQ})).slice(0, 3).map((c) => [c.name, c.page, Math.round(c.cos * 1000) / 1000, Math.round(c.bm * 100) / 100])))`);
const ask = (q) => bar(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(q)}; f.requestSubmit(); return 1; })()`);
const card = () => bar(`(() => { const a = document.querySelector('.mini-answer .answer'); if (!a) return 'null'; const nf = a.querySelector('.not-found');
  return JSON.stringify({ q: a.querySelector('.q').textContent, busy: a.getAttribute('aria-busy'), text: a.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(), error: a.classList.contains('error'),
    chips: [...a.querySelectorAll('.cite.src')].map((c) => c.textContent), nf: nf ? { title: nf.querySelector('.title').textContent, msg: nf.querySelector('.msg').textContent, add: nf.querySelector('[data-cmd="library"]')?.textContent } : null,
    tag: [...a.querySelectorAll('.tag')].map((t) => t.textContent).join(' / '), note: [...a.querySelectorAll('.stopped')].map((p) => p.textContent).join(' ') }); })()`).then(JSON.parse);
async function answer(q) {
  log(`retrieval for "${q}": ${await scores(q)}`);
  await ask(q);
  const t = Date.now();
  const c = await until(async () => { const x = await card(); return x?.q === q && x.busy === 'false' ? x : null; }, 240000, 400);
  log(`answer (${Math.round((Date.now() - t) / 1000)} s) to "${q}": ${JSON.stringify(c)}`);
  return c;
}
const ANSWERABLE = [
  ['When does Project Atlas launch?', 'atlas-project-brief.pdf p.1', /14 March 2027/],
  ['What is the penalty for late delivery in the supply agreement?', 'supplier-contract-scan.pdf p.1', /2\s?%/],
  ['How many engineers are we hiring in Q3?', 'hiring-plan-photo.png p.1', /\b6\b|\bsix\b/i],
  ['ما هي سعة المستودع الرئيسي لمشروع أطلس؟', 'atlas-project-brief.pdf p.3', /1200|١٢٠٠|1,200/],
];
let first = null;
for (const [q, chip, fact] of ANSWERABLE) {
  const c = await answer(q);
  first ??= c;
  check(c && !c.error && !c.nf && c.chips.includes(chip) && fact.test(c.text) && /My material/.test(c.tag),
    `answered from the files with the right citation: "${q}" -> chips ${JSON.stringify(c?.chips)} (want ${chip}), fact ${fact} ${fact.test(c?.text || '')}`);
  if (q.startsWith('When')) {
    for (const t of ['dark', 'light']) { await setTheme(t); await shoot(`sources-answer-${t}`, 'bar'); }
    // the citation opens the viewer at that page, the passage marked over the PDF's own text
    await bar(`[...document.querySelectorAll('.mini-answer .cite.src')].find((c) => c.textContent === ${JSON.stringify(chip)}).click(); 1`);
    const v = await until(() => page("(() => { const d = document.querySelector('#dlg-viewer'); const c = d.querySelector('canvas'); return d.open && c && c.width > 0 && d.querySelectorAll('.hl i').length ? JSON.stringify({ title: d.querySelector('#view-title').textContent, page: d.querySelector('#view-page').textContent, boxes: d.querySelectorAll('.hl i').length, canvas: c.width + 'x' + c.height }) : ''; })()"), 15000);
    check(v && /atlas-project-brief\.pdf/.test(v) && /Page 1 of 3/.test(v), `the citation opens the viewer at its page, the passage marked: ${v}`);
    for (const t of ['dark', 'light']) { await setTheme(t); await shoot(`sources-viewer-${t}`, 'main', '#dlg-viewer'); }
    await page("document.querySelector('#dlg-viewer').close(); 1");
  }
  if (q.startsWith('What is the penalty')) {
    await bar(`[...document.querySelectorAll('.mini-answer .cite.src')].find((c) => c.textContent === ${JSON.stringify(chip)})?.click(); 1`);
    const v = await until(() => page("(() => { const d = document.querySelector('#dlg-viewer'); const m = d.querySelector('mark'); return d.open && m && d.querySelector('canvas')?.width ? m.textContent.replace(/\\s+/g, ' ').slice(0, 400) : ''; })()"), 15000);
    check(v && /2\s?%/.test(v), `a scanned page's citation shows the page and marks the passage in what was read: "${v}"`);
    await page("document.querySelector('#dlg-viewer').close(); 1");
  }
}
const UNANSWERABLE = [
  ['What salary does the Atlas lead engineer earn?', /\d{3,}|salary of|earns? /i],
  ['Who won the 2022 FIFA World Cup?', /argentina|messi|france/i],
];
for (const [q, invented] of UNANSWERABLE) {
  const c = await answer(q);
  check(c && c.nf && c.nf.title === 'Not in your material.' && c.nf.msg.length > 5 && c.nf.add === 'Add a file' && !c.chips.length && !invented.test(c.text.replace(c.nf.msg, '')),
    `not in the files: "${q}" -> "${c?.nf?.title} ${c?.nf?.msg}" with "${c?.nf?.add}", no citation, no invented answer`);
  if (q.startsWith('Who won')) {
    for (const t of ['dark', 'light']) { await setTheme(t); await shoot(`sources-not-found-${t}`, 'bar'); }
    await bar("document.querySelector('.mini-answer [data-cmd=\"library\"]').click(); 1");
    check(await until(() => page("document.querySelector('#dlg-library').open"), 5000), '"Add a file" opens the Library in the main window');
    await page("document.querySelector('#dlg-library').close(); 1");
  }
}

// ================================================================= 4. Web, through the Claude Code CLI
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"web\"]').click(); return 1; })()");
await sleep(300);
const WEB_Q = 'What is one major world news story today? One or two sentences, with the page you got it from.';
await ask(WEB_Q);
const tw = Date.now();
const wc = await until(async () => { const x = await card(); return x?.q === WEB_Q && x.busy === 'false' ? x : null; }, 300000, 1000);
const urls = JSON.parse(await bar("JSON.stringify([...document.querySelectorAll('.mini-answer .cite.url')].map((c) => c.dataset.url))"));
log(`web answer (${Math.round((Date.now() - tw) / 1000)} s): ${JSON.stringify(wc)}; urls ${JSON.stringify(urls)}`);
if (wc?.error && /not found|not logged in|log ?in|sign in/i.test(wc.text)) {
  log(`SKIPPED: Web step. The Claude Code CLI could not answer: "${wc.text.slice(0, 200)}"`);
} else {
  check(wc && !wc.error && urls.length >= 1 && urls.every((u) => /^https?:\/\//.test(u)) && /Web/.test(wc.tag), `Web answered through Claude Code with ${urls.length} URL citation(s): ${urls.slice(0, 3).join(' ')}`);
  if (urls.length) for (const t of ['dark', 'light']) { await setTheme(t); await shoot(`sources-web-${t}`, 'bar'); }
}
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"meeting\"]').click(); return 1; })()");

// ================================================================= 5. static files and the CSP
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, csp: r.headers.get('content-security-policy') || '', type: r.headers.get('content-type') }; };
const pdfjs = await get('/node_modules/pdfjs-dist/build/pdf.min.mjs');
const worker = await get('/node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
check(pdfjs.status === 200 && worker.status === 200 && /javascript/.test(pdfjs.type), `PDF.js and its worker are served (${pdfjs.status}, ${worker.status}, ${pdfjs.type})`);
const closed = [];
for (const p of ['/node_modules/pdfjs-dist/package.json', '/node_modules/pdfjs-dist/build/pdf.mjs', '/node_modules/pdfjs-dist/build/pdf.min.mjs.map', '/node_modules/pdfjs-dist/web/pdf_viewer.mjs', '/node_modules/electron/index.js', '/node_modules/.package-lock.json', '/node_modules/pdfjs-dist/build/../package.json', '/package.json', '/serve.mjs']) closed.push(`${p} ${(await get(p)).status}`);
check(closed.every((x) => x.endsWith(' 404')), `every other node_modules path and server file is 404: ${closed.join(', ')}`);
check(pdfjs.csp === "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src *; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", `the CSP is unchanged: ${pdfjs.csp}`);

// ---- the end
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M('app.quit(); return 1;').catch(() => {});
page.close(); bar.close(); main.close();
if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
await sleep(1000);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nsources proof passed');
finish(fails.length ? 1 : 0);
