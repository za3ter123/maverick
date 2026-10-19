// node test/homework-proof.mjs   (Windows 11; Ollama with gemma4:12b and embeddinggemma)
// Proves Homework end to end in the real desktop app on a temp profile (MAVERICK_USER_DATA, MAVERICK_TEST_HOOKS=1),
// with the real local models and Sources set to My material, so nothing leaves this PC:
//   1. Fixtures made here by Chromium: a 4-page Library file (science-notes.pdf; page 4 in Arabic), an English worksheet
//      PDF with 5 numbered questions (4 the notes answer, 1 they do not), and a photo of an Arabic worksheet with 2.
//      The notes go into the Library through its file input and must be Ready.
//   2. English worksheet, added through the Homework file input: 5 questions found. One draft streams and is stopped
//      (it says Stopped). Every answerable draft cites the right page of science-notes.pdf and says the fact; the Moon
//      question gets "Not in your material." and no invented answer. Each draft has Copy and Edit; an edit is kept.
//   3. Arabic worksheet photo: 2 questions found, each draft in Arabic, citing page 4.
//   4. Pasted text with one calculation: the draft has its working and the right result (75 J), citing page 3.
//   5. A reload, then Homework again: the three worksheets and their drafts (the edit too) are still there. Export
//      saves a .md (to a folder the test picks, as the save window would) with every question and draft.
//   6. 0 bytes sent off this PC for every worksheet (the header count).
//   7. Fill a form: test/fixtures/homework/form.html, a Microsoft Forms look-alike served here: 6 multiple-choice
//      questions, 2 short-answer and 1 long-answer text questions the notes answer, 1 text question they do not, and a
//      required file upload. It opens in its own visible window (session persist:homework-web, no content protection,
//      while the main window keeps it). The 5 calculations get the right option selected and the World Cup one is Not
//      sure and blank; the text answers are typed into the boxes (the form's own React-like state gets them) with the
//      fact, no citation in the box and the reason citing the page; short answers are a line, the long one a paragraph;
//      the uncovered one is Not sure and blank; the upload is never filled and the review says what to draw, citing the
//      page. The Maverick cursor moves to each question and then its answer. A text answer edited in the review reaches
//      the form. Nothing is posted before yes; "no" posts nothing; "yes" with the upload and a required question empty
//      is refused, naming both, and posts nothing. The test then attaches a file and answers the blank one in the form
//      window; "yes" posts exactly once, with the picks, the typed text and the file name, and the review shows the file
//      read back. A second submit is refused and posts nothing.
//   8. The user's real profile (%APPDATA%\maverick) is byte-identical afterwards.
// Prints "PASS: homework proof passed" only when every check passed; otherwise exits 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { scriptOf } from '../src/prompts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'features');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return !!ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
const PORT = 9371;
const INSPECT = 9271;

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

// the form's server: GET /form.html, POST /submit (each post recorded)
const posts = [];
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/form.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(ROOT, 'test', 'fixtures', 'homework', 'form.html')));
  }
  if (req.method === 'POST' && req.url === '/submit') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { posts.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FORM_URL = `http://127.0.0.1:${server.address().port}/form.html`;

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-homework-'));
const FIX = mkdtempSync(join(tmpdir(), 'maverick-homework-fixtures-'));
const EXPORT_DIR = mkdtempSync(join(tmpdir(), 'maverick-homework-export-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
});
const out = [];
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
const finish = (code) => { server.close(); writeFileSync(join(OUT, 'homework-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
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
const M = (body) => main(`(async () => { const { app, BrowserWindow, session } = process.mainModule.require('electron'); const fs = process.mainModule.require('node:fs');
  const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); const formWin = W.find((w) => w.webContents.session === session.fromPartition('persist:homework-web')); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1') && !t.url.includes('/form.html'))).webSocketDebuggerUrl);
const ready = () => until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy') && !!window.maverickTest; })()"), 30000);
await ready();
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);

// ================================================================= 1. fixtures, made by Chromium in the app's main process
const pageCss = 'body{margin:0;font:15px/1.6 "Segoe UI",sans-serif;color:#111} section{padding:56px 64px;page-break-after:always;min-height:900px} h1{font-size:24px;margin:0 0 18px} p{margin:0 0 14px}';
const NOTES = `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body>
<section><h1>Photosynthesis</h1><p>Photosynthesis takes place in the chloroplasts of plant cells. Chlorophyll in the chloroplasts absorbs sunlight.</p>
<p>The plant uses the light energy to turn carbon dioxide and water into glucose, and it releases oxygen gas as a by-product.</p></section>
<section><h1>The water cycle</h1><p>The Sun heats water in seas and lakes, and the water evaporates. When the water vapour rises and cools, it condenses into tiny droplets that form clouds.</p>
<p>The droplets join and fall back to the ground as precipitation: rain, snow or hail.</p></section>
<section><h1>Forces and energy</h1><p>Newton's first law of motion: an object stays at rest, or keeps moving at the same speed in a straight line, unless an unbalanced force acts on it.</p>
<p>Kinetic energy: KE = 1/2 × m × v², where m is the mass in kilograms and v is the speed in metres per second. The answer is in joules (J).</p>
<p>Speed = distance ÷ time. With the distance in metres and the time in seconds, the speed is in metres per second (m/s).</p>
<p>Density = mass ÷ volume. With the mass in grams and the volume in cm³, the density is in g/cm³.</p>
<p>Weight W = m × g, where g = 10 N/kg on Earth. Weight is a force, in newtons (N).</p>
<p>Momentum p = m × v, in kg m/s.</p></section>
<section dir="rtl" lang="ar"><h1>الخلية</h1><p>الميتوكوندريا هي مصنع الطاقة في الخلية، فهي تنتج الطاقة التي تحتاجها الخلية من خلال التنفس الخلوي.</p>
<p>توجد المادة الوراثية (DNA) داخل نواة الخلية، والنواة هي مركز التحكم في الخلية.</p></section>
</body></html>`;
const WORKSHEET = `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body><section>
<h1>Science homework, Unit 3</h1><p>Name: ______________ Class: ______</p>
<p>1. Where in a plant cell does photosynthesis take place?</p>
<p>2. Which gas do plants release during photosynthesis?</p>
<p>3. What happens to water vapour when it rises and cools in the water cycle?</p>
<p>4. State Newton's first law of motion.</p>
<p>5. Who was the first person to walk on the Moon?</p></section></body></html>`;
const AR_PHOTO = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>body{margin:0;width:1000px;height:700px;background:#6b6f73;display:grid;place-items:center}
div{width:760px;padding:40px 48px;background:#fbfbf8;box-shadow:0 12px 30px rgba(0,0,0,.45);transform:rotate(-1.5deg);font:28px/1.7 "Segoe UI",sans-serif;color:#222}
h1{font-size:32px;margin:0 0 16px}</style></head><body><div><h1>واجب العلوم: الخلية</h1><p>١. ما وظيفة الميتوكوندريا في الخلية؟</p><p>٢. أين توجد المادة الوراثية في الخلية؟</p></div></body></html>`;
const files = { notes: join(FIX, 'science-notes.pdf'), sheet: join(FIX, 'science-worksheet.pdf'), photo: join(FIX, 'arabic-worksheet.png') };
await M(`
  const win = (w, h) => new BrowserWindow({ width: w, height: h, show: false, title: 'proof fixture', webPreferences: { offscreen: true } });
  const load = async (w, html) => { await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await new Promise((r) => setTimeout(r, 600)); };
  const pdfOpts = { pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } };
  let w = win(800, 1000); await load(w, ${JSON.stringify(NOTES)});
  fs.writeFileSync(${JSON.stringify(files.notes)}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
  w = win(800, 1000); await load(w, ${JSON.stringify(WORKSHEET)});
  fs.writeFileSync(${JSON.stringify(files.sheet)}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
  w = win(1000, 700); await load(w, ${JSON.stringify(AR_PHOTO)});
  fs.writeFileSync(${JSON.stringify(files.photo)}, (await w.webContents.capturePage()).toPNG()); w.destroy();
  return 1;`);
for (const [k, f] of Object.entries(files)) check(existsSync(f) && readFileSync(f).length > 1000, `fixture ${k}: ${f} (${existsSync(f) ? readFileSync(f).length : 0} bytes)`);

await page.send('DOM.enable');
const setFiles = async (selector, list) => {
  const doc = (await page.send('DOM.getDocument')).root.nodeId;
  const input = (await page.send('DOM.querySelector', { nodeId: doc, selector })).nodeId;
  await page.send('DOM.setFileInputFiles', { nodeId: input, files: list });
};
await page("document.querySelector('#btn-library').click(); 1");
await setFiles('#lib-input', [files.notes]);
const libReady = await until(async () => page("(() => { const r = document.querySelector('#lib-list .lib-row'); return r && (r.dataset.status === 'ready' || r.dataset.status === 'failed') ? r.dataset.status + ': ' + r.querySelector('.status').textContent : ''; })()"), 600000, 1000);
check(/^ready/.test(libReady || ''), `the Library has science-notes.pdf ready: ${libReady}`);
await page("document.querySelector('#dlg-library').close(); 1");

// ================================================================= 2. the English worksheet
const sheets = () => page(`JSON.stringify(window.maverickTest.homework().sheets.map((w) => ({ id: w.id, name: w.name, reading: !!w.reading, error: w.error, lang: w.lang, egress: w.egress,
  items: w.items.map((it) => ({ n: it.n, q: it.q, a: it.a, notFound: it.notFound, error: it.error, stopped: !!it.stopped, streaming: !!it.streaming })) })))`).then(JSON.parse);
const sheetNamed = async (name) => (await sheets()).find((w) => w.name === name);
const shown = () => page(`JSON.stringify([...document.querySelectorAll('#hw-detail .hw-items > li[data-i]')].map((li) => ({ i: li.dataset.i, busy: li.getAttribute('aria-busy'),
  text: li.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(), chips: [...li.querySelectorAll('.cite.src')].map((c) => c.textContent),
  nf: li.querySelector('.not-found .title')?.textContent || '', tools: [...li.querySelectorAll('.tools [data-hw]')].map((b) => b.dataset.hw) })))`).then(JSON.parse);
const click = (sel) => page(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 0; b.click(); return 1; })()`);
const idle = () => until(() => page("!!document.querySelector('#hw-detail [data-hw=\"draft\"]') && !document.querySelector('#hw-detail [data-hw=\"stop\"]')"), 900000, 1000);

await page("document.querySelector('#btn-homework').click(); 1");
check(await until(() => page("document.querySelector('#dlg-homework').open"), 3000), 'Homework opens from the header button');
await page("(() => { document.querySelector('input[name=\"hw-source\"][value=\"material\"]').click(); return 1; })()");
await setFiles('#hw-input', [files.sheet]);
const en = await until(async () => { const w = await sheetNamed('science-worksheet.pdf'); return w && !w.reading ? w : null; }, 120000, 500);
log(`English worksheet: ${JSON.stringify(en?.items.map((it) => [it.n, it.q]))}`);
check(en?.items.length === 5 && en.items.map((it) => it.n).join() === '1,2,3,4,5' && en.lang === 'English', `the English worksheet splits into 5 questions (${en?.items.length}), answers in ${en?.lang}`);

// a draft streams and is stopped: question 4
await click('#hw-detail .hw-items > [data-i="3"] [data-hw="redo"]');
const streaming = await until(() => page("(() => { const li = document.querySelector('#hw-detail .hw-items > [data-i=\"3\"]'); return li?.getAttribute('aria-busy') === 'true' && li.querySelector('.md').innerText.trim().length > 0 ? li.querySelector('.md').innerText.trim().slice(0, 80) : ''; })()"), 120000, 50);
await click('#hw-detail .hw-items > [data-i="3"] [data-hw="stop"]');
await idle();
const stoppedRow = (await shown())[3];
check(streaming && /Stopped\./.test(stoppedRow?.text || '') && (await sheetNamed('science-worksheet.pdf')).items[3].stopped,
  `a draft streams into its card ("${streaming}") and Stop ends it: "${stoppedRow?.text.slice(-60)}"`);
await click('#hw-detail .hw-items > [data-i="3"] [data-hw="redo"]'); // and drafted again, whole
await idle();
await click('#hw-detail [data-hw="draft"]');
await idle();
const enDone = await sheetNamed('science-worksheet.pdf');
const enShown = await shown();
log(`English drafts: ${JSON.stringify(enShown)}`);
const EN = [
  ['science-notes.pdf p.1', /chloroplast/i],
  ['science-notes.pdf p.1', /oxygen/i],
  ['science-notes.pdf p.2', /condens|cloud/i],
  ['science-notes.pdf p.3', /rest|straight line|unbalanced force/i],
];
EN.forEach(([chip, fact], i) => {
  const r = enShown[i];
  check(r && r.chips.includes(chip) && fact.test(r.text) && !r.nf && enDone.items[i].a, `question ${i + 1} is drafted from the notes with ${chip}: chips ${JSON.stringify(r?.chips)}, fact ${fact} ${fact.test(r?.text || '')}`);
});
check(enShown[4]?.nf === 'Not in your material.' && !enShown[4].chips.length && !/armstrong|aldrin|1969/i.test(enShown[4].text) && !enDone.items[4].a,
  `question 5 (the Moon) is not in the material, and nothing is invented: "${enShown[4]?.text}"`);
check(enShown.slice(0, 4).every((r) => r.tools.includes('copy') && r.tools.includes('edit')), 'every draft has Copy and Edit');
// an edit in place
const EDIT = 'In my own words: oxygen is the gas plants give off when they make glucose.';
await click('#hw-detail .hw-items > [data-i="1"] [data-hw="edit"]');
await page(`(() => { const t = document.querySelector('#hw-detail .hw-items > [data-i="1"] .hw-edit'); t.value = ${JSON.stringify(EDIT)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
// Done, and the card read in the same task: the edit must be painted by the click itself, not after the IndexedDB write
// (that order failed once on master, when the write was slow).
const doneText = await page(`(() => { document.querySelector('#hw-detail .hw-items > [data-i="1"] [data-hw="edit"]').click();
  return document.querySelector('#hw-detail .hw-items > [data-i="1"] .md')?.innerText.replace(/\\s+/g, ' ').trim() || ''; })()`);
check(doneText.includes(EDIT) && (await shown())[1]?.text.includes(EDIT), `a draft edited in place shows the edit at once: "${doneText.slice(0, 90)}"`);

// ================================================================= 3. the Arabic worksheet photo
await setFiles('#hw-input', [files.photo]);
const ar = await until(async () => { const w = await sheetNamed('arabic-worksheet.png'); return w && !w.reading ? w : null; }, 300000, 1000);
log(`Arabic worksheet: ${JSON.stringify(ar?.items.map((it) => [it.n, it.q]))} ${ar?.error || ''}`);
check(ar?.items.length === 2 && ar.lang === 'Arabic', `the Arabic worksheet photo is read and splits into 2 questions (${ar?.items.length}), answers in ${ar?.lang}`);
await click('#hw-detail [data-hw="draft"]');
await idle();
const arShown = await shown();
log(`Arabic drafts: ${JSON.stringify(arShown)}`);
const AR = [/الطاقة/, /النواة|نواة/];
AR.forEach((fact, i) => {
  const r = arShown[i];
  const words = (r?.text || '').replace(/science-notes\.pdf p\.\d+/g, '').replace(/\bDNA\b/g, '');
  check(r && r.chips.includes('science-notes.pdf p.4') && fact.test(r.text) && scriptOf(words) === 'arabic', `Arabic question ${i + 1} is answered in Arabic (${scriptOf(words)}) from page 4: ${JSON.stringify(r?.chips)}, ${fact}`);
});

// ================================================================= 4. pasted text with a calculation
await click('[data-hw="new"]');
await sleep(300);
await page(`(() => { document.querySelector('#hw-text').value = ${JSON.stringify('Physics practice\n1. A trolley of mass 6 kg moves at 5 m/s. Calculate its kinetic energy. Show your working.')}; return 1; })()`);
await click('#hw-detail [data-hw="split"]');
await sleep(300);
const mathSheet = (await sheets()).find((w) => w.items.length === 1 && /trolley/.test(w.items[0].q));
check(mathSheet && mathSheet.items[0].n === '1', `pasted text splits into its one question: ${JSON.stringify(mathSheet?.items.map((it) => it.q))}`);
await click('#hw-detail [data-hw="draft"]');
await idle();
const m = (await shown())[0];
log(`math draft: ${JSON.stringify(m)}`);
check(m && /\b75\b/.test(m.text) && /working|×|\*/i.test(m.text) && m.chips.includes('science-notes.pdf p.3'), `the calculation shows its working and 75 J, citing page 3: "${m?.text.slice(0, 220)}"`);

// ================================================================= 5. reopened after a reload, and the export
await M('W.filter((w) => w.webContents.getURL() === \'about:blank\').forEach((w) => w.destroy()); return 1;');
await page.send('Page.reload', { ignoreCache: true });
await sleep(1500);
await ready();
await page("document.querySelector('#btn-homework').click(); 1");
await until(() => page('!!window.maverickTest.homework().sheets'), 10000);
const kept = await sheets();
const keptEn = kept.find((w) => w.name === 'science-worksheet.pdf');
check(kept.length === 3 && keptEn?.items[1].a === EDIT && keptEn.items.slice(0, 4).every((it) => it.a) && keptEn.items[4].notFound && kept.find((w) => w.name === 'arabic-worksheet.png')?.items.every((it) => it.a),
  `after a reload Homework still has the 3 worksheets with their drafts and the edit: ${JSON.stringify(kept.map((w) => [w.name, w.items.filter((it) => it.a).length]))}`);
await page(`(() => { const b = [...document.querySelectorAll('#hw-list [data-hw="pick"]')].find((x) => x.querySelector('strong').textContent === 'science-worksheet.pdf'); b.click(); return 1; })()`);
const EXPORT = join(EXPORT_DIR, 'science-worksheet-answers.md');
await M(`session.defaultSession.once('will-download', (e, item) => item.setSavePath(${JSON.stringify(EXPORT)})); return 1;`);
await click('#hw-detail [data-hw="export"]');
const md = await until(() => (existsSync(EXPORT) && readFileSync(EXPORT, 'utf8').length > 50 ? readFileSync(EXPORT, 'utf8') : ''), 15000);
log(`export: ${JSON.stringify(md)}`);
check(md && md.startsWith('# science-worksheet.pdf') && (md.match(/^## \d\. /gm) || []).length === 5 && md.includes(EDIT) && md.includes('[science-notes.pdf p.1]')
  && md.includes('[science-notes.pdf p.2]') && /## 5\. Who was the first person to walk on the Moon\?\n\nNot in your material\./.test(md), `Export saves a .md with the 5 questions, the drafts as edited, their citations and the not-found one: ${EXPORT}`);

// ================================================================= 6. nothing left this PC
for (const w of kept) {
  await page(`(() => { [...document.querySelectorAll('#hw-list [data-hw="pick"]')].find((x) => x.dataset.id === ${JSON.stringify(w.id)}).click(); return 1; })()`);
  const usage = await page("document.querySelector('#hw-usage').textContent");
  check(usage === '0 bytes sent off this PC' && !w.egress, `${w.name}: "${usage}"`);
}

// ================================================================= 7. fill a multiple-choice form
await page(`(() => { [...document.querySelectorAll('#hw-list [data-hw="pick"]')].find((x) => x.dataset.id === ${JSON.stringify(mathSheet.id)}).click(); return 1; })()`);
check(await page("!document.querySelector('#hw-form-open').hidden"), 'the desktop app offers Fill a form');
await page(`(() => { document.querySelector('#hw-url').value = ${JSON.stringify(FORM_URL)}; document.querySelector('[data-hw="open-form"]').click(); return 1; })()`);
const loaded = await until(() => M("return formWin && !formWin.webContents.isLoading() && formWin.webContents.getURL().endsWith('/form.html') ? formWin.getTitle() : '';"), 20000);
check(loaded, `the form opens in its own window: "${loaded}"`);
const prot = JSON.parse(await M("return JSON.stringify({ form: formWin.isContentProtected(), visible: formWin.isVisible(), main: page.isContentProtected(), partition: formWin.webContents.session === session.fromPartition('persist:homework-web') });"));
check(prot.form === false && prot.visible && prot.partition && prot.main === true, `the form window is visible, not hidden from shares, in its own session (main window protected: ${prot.main}): ${JSON.stringify(prot)}`);
await click('[data-hw="fill-form"]');
const formDone = await until(async () => { const f = JSON.parse(await page('JSON.stringify(window.maverickTest.homework().form)')); return f && !['reading', 'answering', 'filling'].includes(f.state) ? f : null; }, 900000, 1000);
log(`form: ${JSON.stringify(formDone?.questions.map((q) => ({ q: q.text, kind: q.kind, picks: q.picks, typed: q.typed, value: q.value, files: q.files, notSure: q.notSure, reason: q.reason, guide: q.guide, match: q.match?.n ?? null })))} state ${formDone?.state} ${formDone?.msg || ''}`);
check(formDone?.state === 'review' && formDone.questions.length === 11, `the form is read (11 questions: ${formDone?.questions.length}) and waits in review (${formDone?.state})`);
check(formDone && JSON.stringify(formDone.questions.map((q) => q.kind)) === JSON.stringify([...Array(6).fill('choice'), 'text', 'text', 'text', 'text', 'upload'])
  && JSON.stringify(formDone.questions.map((q) => !!q.required)) === JSON.stringify([...Array(6).fill(false), true, true, false, true, true]),
`the questions are read in page order as choice, text and upload, with the required ones marked: ${JSON.stringify(formDone?.questions.map((q) => [q.kind, !!q.required]))}`);
check(formDone && !formDone.questions[0].match, 'a form question with other numbers is not matched to the worksheet\'s calculation');
const state = async () => JSON.parse(await M('return JSON.stringify(await formWin.webContents.executeJavaScript("window.formState()"));'));
const filled = await state();
const WANT = ['9 J', '6 m/s', '4 g/cm³', '50 N', '12 kg m/s', null];
log(`the form holds: ${JSON.stringify(filled)}`);
WANT.slice(0, 5).forEach((w, i) => check(filled.picks[i] === w, `form question ${i + 1}: "${filled.picks[i]}" selected (want "${w}")`));
check(filled.picks[5] === null && formDone?.questions[5].notSure, 'the World Cup question is Not sure and left blank');
// the typed answers: in the form's own state (so the input events reached it, as a React form needs), with the facts, and
// the reason citing the page they come from
const TYPED = [[6, 'q7', /chloroplast/i, 'science-notes.pdf p.1'], [7, 'q8', /\b20\s*m\s*\/\s*s\b|\b20 metres per second/i, 'science-notes.pdf p.3'], [8, 'q9', /condens|cloud/i, 'science-notes.pdf p.2']];
for (const [i, key, fact, cite] of TYPED) {
  const q = formDone?.questions[i];
  check(q && !q.notSure && fact.test(filled.text[key] || '') && filled.text[key] === q.value && q.reason.includes(`[${cite}]`) && !/\[|\]\(/.test(filled.text[key]),
    `text question ${i + 1} is typed in with the fact and no citation inside the box, the reason citing ${cite}: "${filled.text[key]}" / "${q?.reason}"`);
}
check(filled.text.q7?.length < 80 && !/\n/.test(filled.text.q8 || '') && (filled.text.q9 || '').length > 60 && (filled.text.q9.match(/[.!?](\s|$)/g) || []).length >= 2,
  `a short answer is one short line and the long answer a short paragraph (${filled.text.q7?.length}, ${filled.text.q8?.length}, ${filled.text.q9?.length} characters)`);
check(!filled.text.q10 && formDone?.questions[9].notSure && /Not in your material/.test(formDone.questions[9].reason), `the Olympics question is not in the material: Not sure, left blank ("${formDone?.questions[9].reason}")`);
check(filled.file === null && !formDone?.questions[10].files?.length, 'the upload is not filled');
const reviewUpload = await page("document.querySelector('.hw-form [data-q=\"10\"]')?.innerText || ''");
const uploadCites = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('.hw-form [data-q=\"10\"] .cite.src')].map((c) => c.textContent))"));
check(/You need to add this/.test(reviewUpload) && /chloroplast/i.test(reviewUpload) && uploadCites.includes('science-notes.pdf p.1'), `the review says the upload is the student's to add, and what to draw, citing page 1: "${reviewUpload.replace(/\s+/g, ' ').slice(0, 240)}"`);
check(filled.cursorSeen && filled.cursorMoves >= 16, `the Maverick cursor was shown in the page and moved to each question, then to its pick or box (${filled.cursorMoves} moves for 5 picks and 3 typed answers)`);
const review = await page("document.querySelector('.hw-form')?.innerText || ''");
const cites = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('.hw-form .cite.src')].map((c) => c.textContent))"));
check(/Check the answers in the form\. Type yes to submit\./.test(review) && /Not sure/.test(review) && cites.includes('science-notes.pdf p.3'), `the review lists the picks, their citations (${cites.length}) and the Not sure flag, and asks for yes`);
const typedShown = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('.hw-form .hw-typed')].map((t) => t.value))"));
check(typedShown.length === 4 && typedShown[0] === filled.text.q7 && typedShown[2] === filled.text.q9, 'the review shows the full typed text of each text question, in a box that can be edited');
// an edit in the review goes into the form
const EDITED = `${filled.text.q9} I checked this myself.`;
await page(`(() => { const t = document.querySelector('.hw-form [data-q="8"] .hw-typed'); t.value = ${JSON.stringify(EDITED)}; t.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
const edited = await until(async () => ((await state()).text.q9 === EDITED ? 1 : 0), 15000, 300);
check(edited, 'a text answer edited in the review is typed into the form');
await sleep(2000);
check(posts.length === 0, `nothing is submitted before yes (${posts.length} posts)`);
const type = (v) => page(`(() => { const t = document.querySelector('#hw-yes'); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
const formState = () => page('JSON.stringify(window.maverickTest.homework().form.state)').then(JSON.parse);
await type('no');
await sleep(3000);
check(posts.length === 0 && await formState() === 'review', `"no" submits nothing (${posts.length} posts)`);
// yes while the upload and a required question are still empty: refused, saying which
await type('yes');
await until(async () => (await formState()) === 'review' && /Can’t submit yet/.test(await page("document.querySelector('.hw-note')?.textContent || ''")), 20000, 300);
await sleep(3000);
const refused = await page("document.querySelector('.hw-note')?.textContent || ''");
check(posts.length === 0 && /^Can’t submit yet: question 11 needs your photo or file, and question 10 is still blank\. .*then type yes again\.$/.test(refused),
  `"yes" with the upload and a required question empty is refused, naming them, and nothing is posted (${posts.length} posts): "${refused}"`);
// the student adds the photo and answers the blank one in the form window, by hand
const formPage = await cdp((await target((t) => t.type === 'page' && t.url === FORM_URL)).webSocketDebuggerUrl);
await formPage.send('DOM.enable');
const PHOTO = join(FIX, 'plant-cell-drawing.png');
writeFileSync(PHOTO, readFileSync(files.photo));
const fdoc = (await formPage.send('DOM.getDocument')).root.nodeId;
await formPage.send('DOM.setFileInputFiles', { nodeId: (await formPage.send('DOM.querySelector', { nodeId: fdoc, selector: '#upload' })).nodeId, files: [PHOTO] });
await formPage("(() => { const t = document.querySelector('[role=\"textbox\"]'); t.textContent = 'Rio de Janeiro'; t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Rio de Janeiro' })); return 1; })()");
formPage.close();
await type('yes');
const sent = await until(() => posts.length > 0, 20000, 200);
await sleep(4000);
log(`posted: ${JSON.stringify(posts)}`);
const p0 = posts[0] || {};
check(sent && posts.length === 1 && JSON.stringify(p0.picks) === JSON.stringify(WANT), `"yes" submits exactly once, with the picks as selected (${posts.length} post)`);
check(p0.text?.q7 === filled.text.q7 && p0.text?.q8 === filled.text.q8 && p0.text?.q9 === EDITED && p0.text?.q10 === 'Rio de Janeiro' && p0.file === 'plant-cell-drawing.png',
  `the post has the typed answers (the review's edit and the student's own answer too) and the file name: ${JSON.stringify({ text: p0.text, file: p0.file })}`);
const finalShown = await page("document.querySelector('.hw-form [data-q=\"10\"]')?.innerText || ''");
check(/Attached: plant-cell-drawing\.png/.test(finalShown), `the review was read again before submitting and shows the attached file: "${finalShown.replace(/\s+/g, ' ').slice(0, 120)}"`);
const again = await page('window.maverick.formSubmit()');
await sleep(2000);
check(again?.error && posts.length === 1, `a second submit is refused and posts nothing: "${again?.error}"`);
const after = await page("document.querySelector('.hw-form')?.innerText || ''");
check(/Submitted once/.test(after) && !/Type yes to submit/.test(after), 'the review says it was submitted once and offers no second submit');

// ---- the end
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M('formWin?.destroy(); app.quit(); return 1;').catch(() => {});
page.close();
main.close();
if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
await sleep(1000);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nPASS: homework proof passed');
finish(fails.length ? 1 : 0);
