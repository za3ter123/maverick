// node test/accuracy-proof.mjs [--runs=2]   (Windows 11; Ollama with gemma4:12b and embeddinggemma; Python with python-docx)
// Study-material accuracy benchmark for Sources, "My material only". A measurement, not a gate: exits 0 when it completed.
//   1. Corpus: test/fixtures/accuracy/corpus.json is the ground truth. The biology chapter (a text PDF, page 3 in
//      Arabic) and the physics chapter (a scanned, image-only PDF) are rendered from it by Chromium in the app's main
//      process; the history chapter (.docx) by make-docx.py. Six facts in it are counterfactual traps.
//   2. The three files go into the Library through the real file input, on a temp profile (MAVERICK_USER_DATA).
//   3. Every question in test/fixtures/accuracy/key.json is asked through the bar in My material only, --runs times.
//      The visible card is graded against the key; the model's raw reply (teed from the page's fetch) is graded too,
//      to show what Maverick's own checks caught. A citation is correct only when that page of corpus.json holds the
//      question's support text.
//   4. Everything goes to test/fixtures/accuracy/results.json. The user's real profile must be byte-identical after.
// Ports 9355/9251, so a sources-proof or feature-proof run by another builder (9335/9231) is left alone.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'test', 'fixtures', 'accuracy');
const CORPUS = JSON.parse(readFileSync(join(DIR, 'corpus.json'), 'utf8'));
const KEY = JSON.parse(readFileSync(join(DIR, 'key.json'), 'utf8'));
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] || 2);
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(','); // e.g. --only=D01,U04 for a quick look
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

// ---- the .docx first: it needs no app
const spec = (make) => CORPUS.files.find((f) => f.make === make);
const path = (make) => join(DIR, spec(make).name);
if (!existsSync(path('docx'))) execFileSync('python', [join(DIR, 'make-docx.py')], { stdio: 'inherit', windowsHide: true });

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-accuracy-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', '--remote-debugging-port=9355', '--inspect=9251'], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1' },
});
log(`started Electron pid ${app.pid} on temp profile ${PROFILE}`);
const bail = (e) => { log(`ABORTED: ${e?.stack || e}`); killTree(app.pid); process.exit(1); };
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
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9355/json/list')).json(); } catch { return []; } };
const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 20000); if (!t) throw new Error('no debug target'); return t; };
const main = await cdp((await until(async () => { try { return (await (await fetch('http://127.0.0.1:9251/json/list')).json())[0]; } catch { return null; } }, 20000)).webSocketDebuggerUrl);
const M = (body) => main(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); const fs = process.mainModule.require('node:fs'); const W = BrowserWindow.getAllWindows(); const bar = W.find((w) => w.webContents.getURL() === 'about:blank'); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
const bar = await cdp((await target((t) => t.type === 'page' && t.url === 'about:blank')).webSocketDebuggerUrl);
await until(() => M('return !!bar && bar.isVisible();'), 10000);
await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy'); })()"), 20000);
if (!await page("document.querySelector('#st-ai').classList.contains('ok')")) throw new Error('the assistant is not ready (Ollama health check failed)');
const userData = await M("return app.getPath('userData');");
if (userData.toLowerCase() !== PROFILE.toLowerCase()) throw new Error(`the app is not on the temp profile: ${userData}`);
log(`app ready, userData ${userData}`);

// ================================================================= 1. the PDFs, rendered by Chromium from corpus.json
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sectionHtml = (p) => `<h1>${esc(p.heading)}</h1>${p.paras.map((t) => `<p>${esc(t)}</p>`).join('')}`;
const TEXT_PDF = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.65 "Segoe UI",sans-serif;color:#111}
section{padding:64px 72px;page-break-after:always;min-height:900px} h1{font-size:26px;margin:0 0 20px} p{margin:0 0 16px}</style></head><body>
${spec('text-pdf').pages.map((p) => `<section${p.lang === 'ar' ? ' dir="rtl" lang="ar"' : ''}>${sectionHtml(p)}</section>`).join('\n')}</body></html>`;
const scanPage = (p) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:794px;height:1123px;background:#f6f3ea;font:21px/1.55 Georgia,serif;color:#1d1d1d}
div{padding:90px 78px;transform:rotate(-0.5deg)} h1{font-size:29px;margin:0 0 26px} p{margin:0 0 18px}</style></head><body><div>${sectionHtml(p)}</div></body></html>`;
if (!existsSync(path('text-pdf')) || !existsSync(path('scan-pdf'))) {
  await M(`
    const win = (w, h) => new BrowserWindow({ width: w, height: h, show: false, title: 'accuracy fixture', webPreferences: { offscreen: true } });
    const load = async (w, html) => { await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await new Promise((r) => setTimeout(r, 700)); };
    const pdfOpts = { pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } };
    let w = win(800, 1000); await load(w, ${JSON.stringify(TEXT_PDF)});
    fs.writeFileSync(${JSON.stringify(path('text-pdf'))}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
    // the scan: each page photographed as pixels; the PDF holds only those pictures, no text layer
    const shots = [];
    for (const html of ${JSON.stringify(spec('scan-pdf').pages.map(scanPage))}) {
      w = win(794, 1123); await load(w, html); shots.push((await w.webContents.capturePage()).toPNG().toString('base64')); w.destroy();
    }
    w = win(794, 1123);
    await load(w, '<!doctype html><html><head><style>@page{margin:0}body{margin:0}img{display:block;width:210mm;height:296mm}img+img{break-before:page}</style></head><body>' + shots.map((s) => '<img src="data:image/png;base64,' + s + '">').join('') + '</body></html>');
    fs.writeFileSync(${JSON.stringify(path('scan-pdf'))}, await w.webContents.printToPDF(pdfOpts)); w.destroy();
    return 1;`);
}
const files = CORPUS.files.map((f) => join(DIR, f.name));
for (const f of files) if (!existsSync(f) || readFileSync(f).length < 1000) throw new Error(`fixture missing or empty: ${f}`);

// ================================================================= 2. import through the Library dialog
await page("document.querySelector('#btn-library').click(); 1");
await until(() => page("document.querySelector('#dlg-library').open"), 3000);
await page.send('DOM.enable');
const doc = (await page.send('DOM.getDocument')).root.nodeId;
const input = (await page.send('DOM.querySelector', { nodeId: doc, selector: '#lib-input' })).nodeId;
await page.send('DOM.setFileInputFiles', { nodeId: input, files });
const rows = () => page("JSON.stringify([...document.querySelectorAll('#lib-list .lib-row')].map((r) => ({ name: r.querySelector('b').textContent, status: r.dataset.status, text: r.querySelector('.status').textContent })))").then(JSON.parse);
const t0 = Date.now();
const lib = await until(async () => { const r = await rows(); return r.length === files.length && r.every((x) => x.status === 'ready' || x.status === 'failed') ? r : null; }, 900000, 1000);
log(`library after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(lib || await rows())}`);
if (!lib || lib.some((r) => r.status !== 'ready')) throw new Error('not every file reached Ready');
await page("document.querySelector('#dlg-library').close(); 1");
// what the app read on each page (the scan's pages come from the vision model), kept for the record
const pagesRead = JSON.parse(await page("import('./src/libstore.mjs').then((s) => JSON.stringify(s.lib.files.map((f) => ({ name: f.name, read: f.read, pages: f.pages }))))"));
for (const f of pagesRead) log(`read ${f.name}: ${f.pages.length} page(s), from the image: ${JSON.stringify(f.read)}`);

// ================================================================= 3. ask every question
await page("(() => { document.querySelector('input[name=\"sources\"][value=\"material\"]').click(); return 1; })()");
await sleep(400);
if (!await bar("document.querySelector('.src-btn').getAttribute('aria-label') === 'Sources: My material only'")) throw new Error('Sources did not switch to My material only');
// tee every /api/chat reply, so the model's raw words are kept next to what the card shows
await page(`(() => { if (window.__acc) return 1; window.__acc = []; const of = window.fetch;
  window.fetch = async (url, init) => { const r = await of(url, init);
    if (String(url).includes('/api/chat')) { const e = { req: init?.body ?? '', raw: null }; window.__acc.push(e); r.clone().text().then((t) => { e.raw = t; }, (x) => { e.raw = 'ERR ' + x; }); }
    return r; }; return 1; })()`);
const embedQ = "async (t) => (await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', body: JSON.stringify({ model: 'embeddinggemma', input: t }) })).json()).embeddings";
const retrieval = (q) => page(`import('./src/libstore.mjs').then(async (s) => JSON.stringify((await s.search(${JSON.stringify(q)}, ${embedQ})).slice(0, 3).map((c) => [c.name + ' p.' + c.page, Math.round(c.cos * 1000) / 1000, Math.round(c.bm * 100) / 100])))`).then(JSON.parse);
const card = () => bar(`(() => { const a = document.querySelector('.mini-answer .answer'); if (!a) return 'null'; const nf = a.querySelector('.not-found'); const md = a.querySelector('.md');
  const plain = md.cloneNode(true); plain.querySelectorAll('.cite').forEach((c) => c.replaceWith(' '));
  return JSON.stringify({ id: a.dataset.id, q: a.querySelector('.q').textContent, busy: a.getAttribute('aria-busy'), text: md.innerText.replace(/\\s+/g, ' ').trim(),
    plain: plain.textContent.replace(/\\s+/g, ' ').trim(), error: a.classList.contains('error') || !!a.querySelector('.fail'), chips: [...a.querySelectorAll('.cite.src')].map((c) => c.textContent),
    nf: nf ? nf.querySelector('.msg').textContent : null, note: [...a.querySelectorAll('.stopped')].map((p) => p.textContent).join(' ') }); })()`).then(JSON.parse);

async function ask(q) {
  const before = (await card())?.id ?? null;
  await page('window.__acc.length = 0; 1');
  await bar(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(q)}; f.requestSubmit(); return 1; })()`);
  const t = Date.now();
  const c = await until(async () => { const x = await card(); return x && x.id !== before && x.q === q && x.busy === 'false' ? x : null; }, 300000, 400);
  const secs = Math.round((Date.now() - t) / 100) / 10;
  await until(() => page('window.__acc.every((e) => e.raw !== null)'), 10000);
  const calls = JSON.parse(await page('JSON.stringify(window.__acc)'));
  const chat = calls.at(-1);
  const raw = chat ? chat.raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).message?.content ?? ''; } catch { return ''; } }).join('') : null;
  const body = chat ? JSON.parse(chat.req) : null;
  const given = body ? [...body.messages.at(-1).content.matchAll(/^\[([^\]\n]+ p\.\d+)\]$/gm)].map((m) => m[1]) : [];
  return { ...(c || { timeout: true }), secs, raw, given, model: body?.model ?? null, temperature: body?.options?.temperature ?? null };
}

// ================================================================= 4. grading against the key
const norm = (s) => String(s).toLowerCase().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/\s+/g, ' ').trim();
const pageText = (label) => { const [name, n] = label.split(/ p\.(?=\d+$)/); const p = CORPUS.files.find((f) => f.name === name)?.pages[Number(n) - 1]; return p ? norm([p.heading, ...p.paras].join(' ')) : ''; };
const rx = (s, flags = 'iu') => new RegExp(s, flags);
const ACK = rx(KEY.ack);
const SEVERITY = { 'trap-failed': 0, invented: 1, wrong: 2, 'refused-wrongly': 3, error: 4 };
function outcome(item, text, answered) {
  const has = (r, f) => !!r && rx(r, f).test(text);
  const exp = (item.expect || []).every((r) => has(r));
  if (item.cat === 'unanswerable') {
    if (!answered) return 'refused-correctly';
    if (has(item.invent, item.inventFlags)) return 'invented';
    if (item.sub === 'false-premise' && has(item.correction)) return 'correct'; // corrected the premise from the book
    return ACK.test(text) ? 'refused-correctly' : 'invented';
  }
  if (!answered) return 'refused-wrongly';
  // added after the first full run: "The height is 200 m ... Wait, recalculating ... 80 m" matched the key's 80; a
  // student reads the first number, so an answer that corrects itself midway is wrong
  if (/\bwait\b|recalculat|correction:/i.test(text)) return 'wrong';
  if (item.cat === 'partial') {
    if (has(item.invent, item.inventFlags)) return 'invented';
    return exp && ACK.test(text) ? 'correct' : 'wrong';
  }
  if (exp) return 'correct';
  return has(item.trap) ? 'trap-failed' : 'wrong';
}
function grade(item, a) {
  if (a.timeout || a.error) return { outcome: 'error', rawOutcome: 'error', citations: [] };
  const answered = !a.nf;
  const citations = a.chips.map((label) => ({ label, ok: (item.support || []).some((s) => pageText(label).includes(norm(s))) }));
  const rawText = String(a.raw ?? '').replace(/\[[^\]\n]+ p\.\d+\]/g, ' ');
  const rawAnswered = a.raw !== null && !/^\W*not[ _]found/i.test(a.raw.trim());
  return {
    outcome: outcome(item, answered ? a.plain : '', answered),
    rawOutcome: a.raw === null ? 'not-sent' : outcome(item, rawAnswered ? rawText : '', rawAnswered),
    leak: answered && !!item.trap && rx(item.trap).test(a.plain), // gave the book's value and the outside one too
    premise: item.sub === 'false-premise' ? (!answered ? 'refused, premise not corrected' : rx(item.correction).test(a.plain) ? 'corrected from the book' : 'not corrected') : undefined,
    expectedCite: (item.cite || []).some((c) => a.chips.includes(c)),
    gate: !a.nf ? 'answered' : a.raw === null ? 'retrieval (nothing close enough, no model call)' : /^No passage in your files backs/.test(a.nf) ? 'citation check (model answered without a valid citation)' : 'model said NOT FOUND',
    citations,
  };
}

const items = KEY.items.filter((i) => !ONLY || ONLY.includes(i.id));
const results = [];
const retr = {};
for (let run = 1; run <= RUNS; run++) {
  for (const item of items) {
    if (run === 1) retr[item.id] = await retrieval(item.q);
    const a = await ask(item.q);
    const g = grade(item, a);
    results.push({ run, id: item.id, cat: item.cat, sub: item.sub, q: item.q, ...g, answer: a.nf ? `Not in your material. ${a.nf}` : (a.text ?? '(no answer: timed out)'), chips: a.chips, note: a.note, raw: a.raw, given: a.given, secs: a.secs, model: a.model, temperature: a.temperature });
    log(`run ${run} ${item.id} ${g.outcome.padEnd(17)} raw:${g.rawOutcome.padEnd(17)} ${a.secs}s  ${JSON.stringify(a.nf ? `NF: ${a.nf}` : a.text).slice(0, 220)}`);
  }
}

// ================================================================= 5. numbers
const cats = ['direct', 'trap', 'multi', 'unanswerable', 'partial'];
const outs = ['correct', 'wrong', 'invented', 'refused-correctly', 'refused-wrongly', 'trap-failed', 'error', 'not-sent'];
const table = Object.fromEntries(cats.map((c) => [c, Object.fromEntries(outs.map((o) => [o, results.filter((r) => r.cat === c && r.outcome === o).length]))]));
const rawTable = Object.fromEntries(cats.map((c) => [c, Object.fromEntries(outs.map((o) => [o, results.filter((r) => r.cat === c && r.rawOutcome === o).length]))]));
const answered = results.filter((r) => !r.answer.startsWith('Not in your material.') && r.outcome !== 'error');
const halluc = answered.filter((r) => r.outcome === 'invented' || r.outcome === 'trap-failed').length;
const cites = results.flatMap((r) => r.citations);
const byId = Object.groupBy(results, (r) => r.id);
const consistent = Object.values(byId).filter((rs) => rs.every((r) => r.outcome === rs[0].outcome)).length;
const sameText = Object.values(byId).filter((rs) => rs.every((r) => r.answer === rs[0].answer)).length;
const gates = Object.groupBy(results.filter((r) => r.gate !== 'answered'), (r) => r.gate);
const worst = [...results].filter((r) => r.outcome in SEVERITY).sort((a, b) => SEVERITY[a.outcome] - SEVERITY[b.outcome]).filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i).slice(0, 5)
  .map((r) => ({ id: r.id, outcome: r.outcome, q: r.q, expected: KEY.items.find((i) => i.id === r.id).expect ?? `not in the book (${KEY.items.find((i) => i.id === r.id).sub})`, cite: KEY.items.find((i) => i.id === r.id).cite, answer: r.answer, chips: r.chips }));
const summary = {
  runs: RUNS, questions: items.length, answers: results.length, table, rawModelTable: rawTable,
  hallucinationRate: `${halluc}/${answered.length} answered = ${answered.length ? Math.round((1000 * halluc) / answered.length) / 10 : 0}%`,
  citationPrecision: `${cites.filter((c) => c.ok).length}/${cites.length} = ${cites.length ? Math.round((1000 * cites.filter((c) => c.ok).length) / cites.length) / 10 : 0}%`,
  expectedCiteHit: `${results.filter((r) => r.expectedCite).length}/${results.filter((r) => r.cat !== 'unanswerable').length} answerable answers cited the key's page`,
  leaks: results.filter((r) => r.leak).map((r) => `${r.id} run ${r.run}`),
  falsePremise: results.filter((r) => r.premise).map((r) => `${r.id} run ${r.run}: ${r.premise}`),
  notFoundBy: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, v.length])),
  consistency: `${consistent}/${Object.keys(byId).length} questions got the same outcome in every run; ${sameText}/${Object.keys(byId).length} the same text`,
  medianSeconds: [...results.map((r) => r.secs)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
  worst,
};
log('\ncategory x outcome (visible card, all runs):');
log(`${''.padEnd(13)}${outs.map((o) => o.padStart(18)).join('')}`);
for (const c of cats) log(`${c.padEnd(13)}${outs.map((o) => String(table[c][o]).padStart(18)).join('')}`);
log('\nsame, graded on the raw model reply before Maverick\'s checks:');
for (const c of cats) log(`${c.padEnd(13)}${outs.map((o) => String(rawTable[c][o]).padStart(18)).join('')}`);
for (const k of ['hallucinationRate', 'citationPrecision', 'expectedCiteHit', 'consistency', 'medianSeconds']) log(`${k}: ${summary[k]}`);
log(`not-found by: ${JSON.stringify(summary.notFoundBy)}`);
log(`false premise: ${summary.falsePremise.join(' | ')}`);
log(`trap leaks (book value plus the outside one): ${summary.leaks.join(', ') || 'none'}`);

// ---- the end: quit the app we started, by its PID, then the real profile must be unchanged
await M('app.quit(); return 1;').catch(() => {});
page.close(); bar.close(); main.close();
if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
await sleep(1000);
const realAfter = fingerprint(REAL);
summary.realProfileUnchanged = realAfter === realBefore;
log(`real profile ${REAL} byte-identical before and after (${realBefore.split('\n').length} files): ${summary.realProfileUnchanged}`);
writeFileSync(join(DIR, 'results.json'), `${JSON.stringify({ when: new Date().toISOString(), summary, library: lib, retrieval: retr, pagesRead, results }, null, 1)}\n`);
log('wrote test/fixtures/accuracy/results.json');
log('accuracy proof done');
process.exit(0);
