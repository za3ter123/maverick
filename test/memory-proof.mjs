// node test/memory-proof.mjs   (Windows 11; Ollama with gemma4:12b and embeddinggemma)
// Proves Memory end to end in the real desktop app on a temp profile (MAVERICK_USER_DATA, MAVERICK_TEST_HOOKS=1), with the
// real local models (the Reasoning model blank, so the notes are written by the live model):
//   1. A meeting (a physics lecture: Dr Huda Salem and Omar Khalid) is ended with End & summarize. Its note lands in the
//      vault, <profile>/memory, as Markdown with YAML frontmatter (type: meeting) and [[links]]; every page it links to
//      exists, the two speakers' pages among them, and each links back to the meeting note.
//   2. Memory opens from the header: the note list (search filters it), the note with clickable [[links]]; a person's page
//      shows the meeting under "Linked from".
//   3. The graph draws a node per note and the links between them; clicking a node opens that note.
//   4. Ask Memory answers "When is the physics midterm exam?" from the meeting note (November 12), citing the note; an
//      unrelated question (the capital of Peru) gets "Not in your notes." and no answer.
//   5. Homework with an empty Library drafts a question the lecture answered (9.8 m/s²), citing the meeting note; its
//      homework note links to the meeting.
//   6. Screenshots of the note view and the graph, dark and light, at a 1280 px window (SHOTS_DIR, or a temp folder).
//   7. The owner's real profile (%APPDATA%\maverick) is byte-identical afterwards.
// Prints "PASS: memory proof passed" only when every check passed; otherwise exits 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { parseLinks, parseNote } from '../src/memory.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.env.SHOTS_DIR || mkdtempSync(join(tmpdir(), 'maverick-memory-shots-'));
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return !!ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
const PORT = 9381;
const INSPECT = 9281;

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-memory-'));
const VAULT = join(PROFILE, 'memory');
const app = spawn(electron, ['.', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
});
const out = [];
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
const finish = (code) => { writeFileSync(join(SHOTS, 'memory-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
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
const M = (body) => main(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); const fs = process.mainModule.require('node:fs');
  const page = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http://127.0.0.1')); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
await until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy') && !!window.maverickTest; })()"), 30000);
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);
// the notes by the live model (gemma4:12b): no Reasoning model; no subtitles or word fixes while the lines go in
await page("window.maverickTest.useSettings({ subtitles: 'off', fixWords: false, roles: { deep: { model: '' } } })");
const click = (sel) => page(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 0; b.click(); return 1; })()`);
const vaultFiles = () => (existsSync(VAULT) ? readdirSync(VAULT).filter((f) => f.endsWith('.md')) : []);
const readNote = (name) => readFileSync(join(VAULT, `${name}.md`), 'utf8');

// ================================================================= 1. a finished meeting writes its note
const LECTURE = [
  ['Dr Huda Salem', 'Good morning everyone, welcome back to Physics 101. Today we cover projectile motion.', 20_000],
  ['Dr Huda Salem', 'Near the surface of the Earth, the acceleration due to gravity is 9.8 metres per second squared, and it points straight down.', 70_000],
  ['Omar Khalid', 'Doctor, when is the midterm exam?', 120_000],
  ['Dr Huda Salem', 'We agreed in the last class: the midterm exam is on Thursday, November 12, in Hall B.', 150_000],
  ['Dr Huda Salem', 'A ball thrown horizontally keeps its horizontal speed, because no horizontal force acts on it.', 200_000],
  ['Omar Khalid', 'I will send everyone the lab report template by Sunday.', 240_000],
  ['Dr Huda Salem', 'Good. Please read chapter four before the next lecture.', 280_000],
];
await page('window.maverickTest.backdate(300_000)');
for (const [who, text, at] of LECTURE) await page(`window.maverickTest.addLine(${JSON.stringify(who)}, ${JSON.stringify(text)}, ${at})`);
await page("(() => { const b = document.querySelector('#btn-end'); b.disabled = false; b.click(); return 1; })()");
const saved = await until(async () => { const h = JSON.parse(await page("localStorage.getItem('maverick.meetings') || '[]'")); const m = h.at(-1); return m && typeof m.summary === 'string' && m.summary ? m : null; }, 400000, 1000);
const title = saved?.title ?? '';
log(`notes of "${title}": ${JSON.stringify(saved?.summary)}`);
check(saved?.summary, 'End & summarize writes the meeting notes');
const meetingFile = await until(() => vaultFiles().find((f) => parseNote(f, readFileSync(join(VAULT, f), 'utf8')).type === 'meeting'), 180000, 1000);
const meetingName = meetingFile?.slice(0, -3) ?? '';
const meetingMd = meetingFile ? readNote(meetingName) : '';
log(`vault after the meeting: ${JSON.stringify(vaultFiles())}`);
log(`meeting note "${meetingName}":\n${meetingMd}`);
check(meetingName && meetingName === title.replace(/(\d):(\d)/g, '$1-$2') && /^---\ntype: meeting\ndate: \d{4}-\d{2}-\d{2}\ntags: \[meeting[^\]]*\]\n---\n# /.test(meetingMd),
  `the meeting's note is in the vault, named after the meeting, with frontmatter (type, date, tags): ${join(VAULT, meetingFile || '?')}`);
check(/## Summary/.test(meetingMd) && /## Decisions/.test(meetingMd) && /## Action items/.test(meetingMd) && /## Transcript excerpt/.test(meetingMd) && /9\.8 metres per second squared/.test(meetingMd),
  'the note has the summary, decisions, action items and a transcript excerpt');
const links = parseLinks(meetingMd);
check(links.includes('Dr Huda Salem') && links.includes('Omar Khalid'), `the note links the two speakers: ${JSON.stringify(links)}`);
const pages = links.map((l) => [l, vaultFiles().find((f) => f.slice(0, -3).toLowerCase() === l.toLowerCase())]);
check(pages.every(([, f]) => f) && pages.every(([, f]) => parseLinks(readFileSync(join(VAULT, f), 'utf8')).includes(meetingName)),
  `every page the note links to exists and links back to it: ${JSON.stringify(pages.map(([l, f]) => [l, f && parseNote(f, readFileSync(join(VAULT, f), 'utf8')).type]))}`);
log(`Dr Huda Salem.md:\n${existsSync(join(VAULT, 'Dr Huda Salem.md')) ? readNote('Dr Huda Salem') : '(missing)'}`);
await page("document.querySelector('#dlg-summary').close(); 1");

// ================================================================= 2. the Memory sheet: list, search, note, backlinks
check(await page("!document.querySelector('#btn-memory').hidden"), 'the header has a Memory button in the desktop app');
await click('#btn-memory');
check(await until(() => page("document.querySelector('#dlg-memory').open"), 5000), 'Memory opens from the header button');
const listed = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('#mem-list button[data-note]')].map((b) => b.dataset.note))"));
check(listed.length === vaultFiles().length && listed.includes(meetingName), `the list shows every note (${listed.length} of ${vaultFiles().length})`);
await page("(() => { const q = document.querySelector('#mem-q'); q.value = 'omar'; q.dispatchEvent(new Event('input')); return 1; })()");
const found = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('#mem-list button[data-note]')].map((b) => b.dataset.note))"));
check(found.includes('Omar Khalid') && found.includes(meetingName) && found.length < listed.length, `search filters the list: "omar" -> ${JSON.stringify(found)}`);
await page("(() => { const q = document.querySelector('#mem-q'); q.value = ''; q.dispatchEvent(new Event('input')); return 1; })()");
await click(`#mem-list button[data-note="${meetingName}"]`);
const view = JSON.parse(await page(`JSON.stringify({ h: document.querySelector('#mem-detail h3')?.textContent, links: [...document.querySelectorAll('#mem-detail .mem-body button.wikilink')].map((b) => b.dataset.note),
  text: document.querySelector('#mem-detail .mem-body')?.innerText.slice(0, 300) })`));
check(view.h === meetingName && view.links.includes('Dr Huda Salem') && !/\[\[/.test(view.text), `the note shows with its [[links]] as buttons: ${JSON.stringify(view.links)}`);
await click('#mem-detail .mem-body button.wikilink[data-note="Dr Huda Salem"]');
const person = JSON.parse(await page("JSON.stringify({ h: document.querySelector('#mem-detail h3')?.textContent, back: [...document.querySelectorAll('#mem-detail .mem-back button')].map((b) => b.dataset.note), title: document.querySelector('#mem-detail .mem-back .section-title')?.textContent })"));
check(person.h === 'Dr Huda Salem' && person.title === 'Linked from' && person.back.includes(meetingName), `a [[link]] opens the person's page, whose "Linked from" lists the meeting: ${JSON.stringify(person)}`);
await click(`#mem-detail .mem-back button[data-note="${meetingName}"]`);
check(await page('document.querySelector(\'#mem-detail h3\')?.textContent') === meetingName, 'a backlink opens the meeting note');

// ================================================================= 3. the graph
await click('[data-mem-tab="graph"]');
const graph = JSON.parse(await page(`JSON.stringify({ nodes: [...document.querySelectorAll('#mem-detail .g-node')].map((g) => ({ n: g.dataset.note, t: g.dataset.type, r: +g.querySelector('circle').getAttribute('r'),
  box: g.getBoundingClientRect().width })), edges: document.querySelectorAll('#mem-detail .g-edge').length })`));
log(`graph: ${JSON.stringify(graph)}`);
check(graph.nodes.length === vaultFiles().length && graph.edges >= links.length && graph.nodes.every((n) => n.box > 0) && graph.nodes.find((n) => n.n === meetingName)?.t === 'meeting',
  `the graph draws ${graph.nodes.length} nodes and ${graph.edges} links, the meeting as a meeting node`);
await page("(() => { document.querySelector('#mem-detail .g-node[data-note=\"Omar Khalid\"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()");
check(await page("document.querySelector('#mem-detail h3')?.textContent") === 'Omar Khalid' && await page("document.querySelector('[data-mem-tab=\"note\"]').getAttribute('aria-selected')") === 'true',
  'clicking a node opens its note');

// ================================================================= 4. Ask Memory
const ask = async (q) => {
  await page(`(() => { document.querySelector('#mem-ask-q').value = ${JSON.stringify(q)}; document.querySelector('#mem-ask').requestSubmit(); return 1; })()`);
  await until(() => page(`(() => { const a = window.maverickTest.memory().ask; return a && a.question === ${JSON.stringify(q)} && !a.streaming; })()`), 300000, 500);
  return JSON.parse(await page(`JSON.stringify({ ask: window.maverickTest.memory().ask, shown: document.querySelector('#mem-detail .mem-answer .md')?.innerText.replace(/\\s+/g, ' ').trim(),
    chips: [...document.querySelectorAll('#mem-detail .mem-answer .cite.mem')].map((c) => c.dataset.note), nf: document.querySelector('#mem-detail .not-found .title')?.textContent || '' })`));
};
const a1 = await ask('When is the physics midterm exam?');
log(`Ask Memory: ${JSON.stringify({ text: a1.ask.text, notFound: a1.ask.notFound, error: a1.ask.error, chips: a1.chips })}`);
check(/November\s*12|12\s*November/i.test(a1.shown || '') && a1.chips.includes(meetingName) && !a1.nf, `Ask Memory answers from the meeting, citing it: "${a1.shown}"`);
await click('#mem-detail .mem-answer .cite.mem');
check(await page("document.querySelector('#mem-detail h3')?.textContent") === meetingName, 'the citation opens the meeting note');
const a2 = await ask('What is the capital of Peru?');
log(`unrelated: ${JSON.stringify({ text: a2.ask.text, notFound: a2.ask.notFound, error: a2.ask.error })}`);
check(a2.nf === 'Not in your notes.' && !a2.chips.length && !/lima/i.test(a2.shown || ''), `an unrelated question gets "Not in your notes." and no answer: "${a2.shown}"`);
await page("document.querySelector('#dlg-memory').close(); 1");

// ================================================================= 5. Homework draws on the lecture
await click('#btn-homework');
await until(() => page("document.querySelector('#dlg-homework').open"), 5000);
await page("(() => { document.querySelector('input[name=\"hw-source\"][value=\"material\"]').click(); return 1; })()");
await click('[data-hw="new"]');
await sleep(300);
await page(`(() => { document.querySelector('#hw-text').value = ${JSON.stringify('Physics homework\n1. According to the lecture, what is the acceleration due to gravity near the surface of the Earth?')}; return 1; })()`);
await click('#hw-detail [data-hw="split"]');
await sleep(300);
await click('#hw-detail [data-hw="draft"]');
await until(() => page("!!document.querySelector('#hw-detail [data-hw=\"draft\"]') && !document.querySelector('#hw-detail [data-hw=\"stop\"]')"), 300000, 1000);
const hw = JSON.parse(await page("(() => { const li = document.querySelector('#hw-detail .hw-items > li[data-i=\"0\"]'); return JSON.stringify({ text: li?.querySelector('.md').innerText.replace(/\\s+/g, ' ').trim(), chips: [...(li?.querySelectorAll('.cite.mem') || [])].map((c) => c.dataset.note), nf: li?.querySelector('.not-found .title')?.textContent || '' }); })()"));
log(`homework draft: ${JSON.stringify(hw)}`);
check(/9\.8/.test(hw.text || '') && hw.chips.includes(meetingName) && !hw.nf, `with an empty Library, Homework drafts from the past lecture and cites its note: "${hw.text}"`);
const hwFile = await until(() => vaultFiles().find((f) => parseNote(f, readFileSync(join(VAULT, f), 'utf8')).type === 'homework'), 120000, 1000);
const hwMd = hwFile ? readFileSync(join(VAULT, hwFile), 'utf8') : '';
log(`homework note "${hwFile}":\n${hwMd}`);
check(hwFile && parseLinks(hwMd).includes(meetingName), `the homework run is a note in the vault that links to the lecture: ${hwFile}`);
await page("document.querySelector('#dlg-homework').close(); 1");

// ================================================================= 6. screenshots, dark and light, 1280 px
await M('page.setSize(1280, 860); return 1;');
await sleep(600);
const setTheme = async (t) => { await page(`(() => { const r = document.querySelector('input[name="appearance"][value="${t}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await sleep(800); };
const shoot = async (name) => {
  const r = JSON.parse(await page("JSON.stringify(document.querySelector('#dlg-memory').getBoundingClientRect())"));
  const file = join(SHOTS, `${name}.png`);
  await M(`fs.writeFileSync(${JSON.stringify(file)}, (await page.webContents.capturePage({ x: ${Math.floor(r.x)}, y: ${Math.floor(r.y)}, width: ${Math.ceil(r.width)}, height: ${Math.ceil(r.height)} })).toPNG()); return 1;`);
  log(`shot: ${file} (${Math.ceil(r.width)} x ${Math.ceil(r.height)} px in a ${await M('return page.getSize()[0];')} px window)`);
};
for (const theme of ['dark', 'light']) {
  await setTheme(theme);
  await page(`(() => { document.querySelector('#btn-memory').click(); return 1; })()`);
  await until(() => page("document.querySelector('#dlg-memory').open"), 5000);
  await click(`#mem-list button[data-note="${meetingName}"]`);
  await click('[data-mem-tab="note"]');
  await sleep(700);
  await shoot(`memory-note-${theme}`);
  await click('[data-mem-tab="graph"]');
  await sleep(700);
  await shoot(`memory-graph-${theme}`);
  await page("document.querySelector('#dlg-memory').close(); 1");
}

// ---- the end
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M('app.quit(); return 1;').catch(() => {});
page.close();
main.close();
if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
await sleep(1000);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nPASS: memory proof passed');
finish(fails.length ? 1 : 0);
