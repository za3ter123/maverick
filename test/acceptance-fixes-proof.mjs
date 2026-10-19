// node test/acceptance-fixes-proof.mjs   (Windows; Ollama with gemma4:12b; System.Speech voices)
// Reproduces six defects of the 2026-10-17 acceptance test in the real desktop app on a temp profile (MAVERICK_USER_DATA,
// MAVERICK_TEST_HOOKS) and checks each is fixed. The live model answers; the notes are written by it too (the deep model
// is switched off in the temp profile, so the run takes minutes, not ten).
//   1. Ask "إذا كان 5x - 3 = 2x + 9 فكم قيمة x؟ اكتب الخطوات": every formula in the card is one left-to-right unit (its first
//      glyph left of its last), no operand is left outside it, and no "=" sits outside one.
//   3. A TTS meeting with pauses (the tester's kind) is played into the meeting audio path (VAD, gates, transcription):
//      no line that was not said.
//   4. Meeting 2 asks about meeting 1 (in History, "Sarah will send the budget" at 00:20): no transcript jump in the card
//      points at a time that is no moment of meeting 2, an earlier-meeting chip is there, and it opens meeting 1 in
//      History at its 00:20 line.
//   6. At 09:13 of a meeting too long for the prompt, "Who will send the venue contract?" is answered from its 00:25 line.
//   7. A flag at 03:57, pressed while its words are still being transcribed, ends on the 03:52 line once that arrives, and
//      the notes say what was said there, not "no speech".
//   8. Every decision and action item in the notes cites a transcript line that backs it (src/meetings.mjs, groundNotes).
//  13. History shows an Arabic line after its Latin label right to left, isolated, with its question mark at its end.
//  14. The notes' Flagged moments section has one clean bullet per flag: a valid mm:ss and what was said near it.
//  15. End & summarize with a deep model that is not installed, then one that never answers (a stub in front of Ollama):
//      the meeting is in History within 3 s, and the live model writes the notes in time and says so at their top.
//  12. "Not responding" (a measurement): the longest task on the page's main thread and the longest stall of the main
//      process's event loop over the whole run; each must stay under 1 s (Windows says "not responding" after 5 s).
// Acceptance 2 (the second ghost pass):
//   A. Answer from the bar while keyboard focus sits on a button of an older card there: the card finishes.
//   C. Think harder on an Arabic Recap with a deep model (a stub) that writes only its English reasoning: none of it shows,
//      the live model answers in Arabic, and the card says why. The same stub as the deep model for End & summarize, once
//      writing the notes and once in the unclear-words pass before them: no reasoning in the notes, the live model writes
//      them, and their first line says why.
//   E. The Arabic Ask with no meeting (1): no transcript placeholder in its prompt or its card.
//   F. A citation of the screen read at 00:01 shows that read, not the 00:11 transcript line.
// The user's real profile must be byte-identical afterwards. Prints "acceptance fixes passed" only if every check passed.
// Ports 9366/9262, so the other proofs and a capture session (9371/9271) are left alone.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { groundNotes } from '../src/meetings.mjs';
import { SCRIPT, speakMeeting } from './stt-gate.mjs';
import { normalizeWords } from './wer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'features');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };

const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

// the TTS meeting: the same file test/stt-gate.mjs speaks (16 kHz mono)
const WAV = speakMeeting();

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-acceptance-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', '--remote-debugging-port=9366', '--inspect=9262'], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
});
const out = [];
let step = 'start'; // which part was running when the app printed a line
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean).map((l) => `${l} (during ${step})`)));
const finish = (code) => { writeFileSync(join(OUT, 'acceptance-fixes-proof-log.txt'), `${lines.join('\n')}\n`); killTree(app.pid); process.exit(code); };
const bail = (e) => { log(`FAIL: ${e?.stack || e}`); fails.push('crashed'); finish(1); };
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
  return async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
    return res.result?.value;
  };
}
async function until(fn, ms, every = 300) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const pageTarget = await until(async () => { try { return (await (await fetch('http://127.0.0.1:9366/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1')); } catch { return null; } }, 30000);
if (!pageTarget) bail('no debug target');
const page = await cdp(pageTarget.webSocketDebuggerUrl);
const ready = () => until(() => page("!!document.querySelector('#st-ai') && !!window.maverickTest"), 30000);
await ready();
// the deep model off (the notes and answers come from the live model), and no side passes competing for it
await page("window.maverickTest.useSettings({ roles: { deep: { model: '' } }, fixWords: false, subtitles: 'off' })");
// 12: long tasks on the page (the bar shares its thread) and event-loop stalls in the main process, for the whole run
await page("window.__long = []; new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); 1");
const mainTarget = await until(async () => { try { return (await (await fetch('http://127.0.0.1:9262/json/list')).json())[0]; } catch { return null; } }, 10000);
const mainProc = await cdp(mainTarget.webSocketDebuggerUrl);
await mainProc("globalThis.__lag = 0; let last = Date.now(); setInterval(() => { const now = Date.now(); globalThis.__lag = Math.max(globalThis.__lag, now - last - 100); last = now; }, 100); 1");
check((await page("JSON.parse(localStorage.getItem('maverick.settings')).roles.deep.model")) === '', `the app runs in the temp profile ${PROFILE}, deep model off`);

// Asks in the main window's ask field, like a person; resolves with the finished card.
async function ask(q) {
  const before = await page("document.querySelectorAll('#answers .answer').length");
  await page(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(q)}; f.requestSubmit(); return 1; })()`);
  const done = await until(() => page(`(() => { const a = document.querySelector('#answers .answer.latest'); return document.querySelectorAll('#answers .answer').length > ${before} && a?.getAttribute('aria-busy') === 'false' ? 1 : 0; })()`), 180000, 500);
  if (!done) throw new Error(`no answer to "${q}" within 3 minutes`);
  return JSON.parse(await page("JSON.stringify({ html: document.querySelector('#answers .answer.latest .md').innerHTML, text: document.querySelector('#answers .answer.latest .md').textContent })"));
}

// ================================================================= 1. math in an Arabic answer
step = '1';
const a1 = await ask('إذا كان 5x - 3 = 2x + 9 فكم قيمة x؟ اكتب الخطوات');
log(`1. answer: ${a1.text.replace(/\s+/g, ' ').slice(0, 400)}`);
const p1 = await page('JSON.stringify(window.maverickTest.lastPrompt)');
check(!/No transcript yet/.test(p1) && !/لا (?:يوجد|توجد) نص|no transcript|no previous text/i.test(a1.text), 'E. the Ask with no meeting has no transcript placeholder in its prompt or its card');
const m1 = JSON.parse(await page(`(() => {
  const md = document.querySelector('#answers .answer.latest .md');
  const res = { bdis: [], bad: [] };
  const ar = /[\\u0600-\\u06FF]/;
  for (const b of md.querySelectorAll('bdi[dir="ltr"]')) { // formulas; a bdi dir=auto is Arabic text after a label
    res.bdis.push(b.textContent);
    const prev = b.previousSibling?.textContent || '';
    const next = b.nextSibling?.textContent || '';
    if (/[\\dA-Za-z)]\\s*[-+−×÷*/=]\\s*$/.test(prev)) res.bad.push('operand left outside: ' + prev.slice(-10) + ' | ' + b.textContent);
    if (/^\\s*[-+−×÷*/=]\\s*[\\dA-Za-z(]/.test(next)) res.bad.push('operand right outside: ' + b.textContent + ' | ' + next.slice(0, 10));
    const texts = []; const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.trim()) texts.push(n);
    if (texts.length && b.textContent.trim().length > 2) {
      const r = (node, i) => { const g = document.createRange(); g.setStart(node, i); g.setEnd(node, i + 1); return g.getBoundingClientRect(); };
      const first = texts[0]; const last = texts.at(-1);
      const fi = first.textContent.search(/\\S/); const li = last.textContent.length - 1 - [...last.textContent].reverse().join('').search(/\\S/);
      const a = r(first, fi); const z = r(last, li);
      if (Math.abs(a.top - z.top) < 4 && !(a.left < z.left)) res.bad.push('drawn right to left: ' + b.textContent);
    }
  }
  const w = document.createTreeWalker(md, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const block = n.parentElement.closest('p, li');
    if (!n.parentElement.closest('bdi, code, pre') && block && ar.test(block.textContent) && /[\\dA-Za-z]\\s*=\\s*[-\\dA-Za-z]/.test(n.textContent)) res.bad.push('formula outside a bdi: ' + n.textContent.trim().slice(0, 40));
  }
  res.dollar = md.textContent.includes('$');
  return JSON.stringify(res);
})()`));
log(`1. formulas isolated: ${JSON.stringify(m1.bdis)}`);
check(m1.bdis.some((b) => /=/.test(b)) && !m1.bad.length && !m1.dollar, `1. every formula in the Arabic answer is one left-to-right unit (${m1.bdis.length} of them)${m1.bad.length ? `: ${m1.bad.join('; ')}` : ''}${m1.dollar ? '; a raw $ shows' : ''}`);
check(m1.bdis.some((b) => /\b3x\s*=\s*12\b/.test(b)) || m1.bdis.some((b) => /5x\s*-\s*3\s*=\s*2x\s*\+\s*9/.test(b)), '1. the equation or its working is isolated whole (3x = 12, or 5x - 3 = 2x + 9)');

// ================================================================= 3. a TTS meeting with pauses through the audio path
step = '3';
const heardLines = await page(`window.maverickTest.playMeeting(${JSON.stringify(readFileSync(WAV).toString('base64'))})`);
const spoken = SCRIPT.map(([t]) => normalizeWords(t));
const isReal = (text) => { const w = normalizeWords(text); return w.length > 0 && spoken.some((s) => w.filter((x) => s.includes(x)).length / w.length >= 0.6); };
const invented = heardLines.filter((l) => !isReal(l));
const heard = SCRIPT.filter(([t]) => { const s = normalizeWords(t); return heardLines.some((l) => { const w = normalizeWords(l); return s.filter((x) => w.includes(x)).length / s.length >= 0.6; }); });
log(`3. the model wrote, per chunk: ${JSON.stringify(await page('window.maverickTest.raw.map((r) => r.slice(0, 160))'))}`);
log(`3. transcript: ${JSON.stringify(heardLines)}`);
check(heardLines.length && !invented.length, `3. no invented line: ${heardLines.length} lines, ${invented.length} not said${invented.length ? `: ${invented.join(' | ')}` : ''}`);
check(heard.length >= 4, `3. real speech kept: ${heard.length} of ${SCRIPT.length} sentences (${SCRIPT.filter((s) => !heard.includes(s)).map(([t]) => t).join(' / ') || 'none'} missed)`);
await page('window.maverickTest.discard()');

// ================================================================= 4 and 6. meeting 1 in History; meeting 2 at 09:13, too long for the prompt
step = '4 and 6';
const day = Date.now() - 86_400_000;
const meeting1 = {
  id: 'acc-m1', title: 'Budget sync', startedAt: day, endedAt: day + 600_000, flags: [], answers: [], screens: [], egress: 0,
  transcript: [
    { who: 'Speaker 1', text: 'Thanks for joining the budget sync.', t: day + 4_000 },
    { who: 'Speaker 1', text: 'Sarah will send the budget by Friday.', t: day + 20_000 },
    { who: 'Speaker 2', text: 'Then finance reviews it next Monday.', t: day + 41_000 },
  ],
  summary: '## Summary\nThe budget sync.\n\n## Decisions\n- None noted.\n\n## Action items\n- [ ] Sarah: send the budget (due Friday) [00:20]',
};
await page(`localStorage.setItem('maverick.meetings', ${JSON.stringify(JSON.stringify([meeting1]))}); 1`);
const startA = await page('window.maverickTest.backdate(553_000)'); // the meeting is at 09:13
await page("window.maverickTest.addLine('Speaker 1', 'Welcome to the second meeting, the venue planning call.', 11_000)");
await page("window.maverickTest.addLine('Speaker 1', 'Layla will send the venue contract by Sunday.', 25_000)");
const filler = ['the stage layout and where the screens go', 'the catering order and the coffee breaks', 'the parking passes for the guests', 'the badge printing and the registration desk', 'the sound check before the first session'];
for (let t = 60_000, i = 0; t <= 540_000; t += 4_000, i++) {
  await page(`window.maverickTest.addLine('Speaker ${2 + (i % 2)}', ${JSON.stringify(`We went over ${filler[i % filler.length]}, and agreed to look at it again later, point ${i + 1} of the list for this part of the plan. Nobody had more to add on it today, so the group moved on to the next point after a short pause.`)}, ${t})`);
}
const a6 = await ask('Who will send the venue contract?');
const p6 = await page('JSON.stringify(window.maverickTest.lastPrompt)');
log(`6. answer: ${a6.text.replace(/\s+/g, ' ').slice(0, 300)}`);
const p6at = (s) => p6.indexOf(s);
check(p6at('Earlier lines of this meeting that may answer the question:') >= 0 && p6at('Earlier lines of this meeting') < p6at('[00:25] Speaker 1: Layla will send the venue contract by Sunday.')
  && p6at('[00:25] Speaker 1: Layla') < p6at('Transcript, the latest part'),
  '6. the prompt at 09:13 carries the 00:25 line that answers it, besides the latest part of the meeting');
check(/Layla/.test(a6.text), '6. the answer names Layla, said at 00:25');

// ---- acceptance 2, defect A: keyboard focus on a button of the bar's answer, then Answer from the bar. The bar shows only
// the newest card, so the focused card was gone from it, keepFocus threw, and the card sat at "Catching up" forever.
step = 'A';
const bar = await cdp((await until(async () => { try { return (await (await fetch('http://127.0.0.1:9366/json/list')).json()).find((t) => t.type === 'page' && t.url === 'about:blank'); } catch { return null; } }, 10000)).webSocketDebuggerUrl);
const focusedA = await bar("(() => { const b = document.querySelector('.mini-answer [data-cmd=\"regen\"]'); b?.focus(); return document.activeElement === b ? b.closest('.answer').dataset.id : ''; })()");
const beforeA = await page("document.querySelectorAll('#answers .answer').length");
await bar("document.querySelector('[data-action=\"answer\"]').click(); 1");
const doneA = await until(() => page(`(() => { const a = document.querySelector('#answers .answer.latest'); return document.querySelectorAll('#answers .answer').length > ${beforeA} && a.dataset.kind === 'answer' && a.getAttribute('aria-busy') === 'false' ? JSON.stringify({ error: a.classList.contains('error'), text: a.querySelector('.md').textContent.trim().slice(0, 120) }) : ''; })()`), 180000, 500);
log(`A. focus on card ${focusedA} in the bar, then Answer from the bar: ${doneA || 'still running after 3 minutes'}`);
check(focusedA && doneA && !JSON.parse(doneA).error && JSON.parse(doneA).text, 'A. Answer from the bar, with focus on an older card\'s button there, finishes with an answer');
const stuckA = await page("document.querySelectorAll('#answers .answer[aria-busy=\"true\"]').length");
check(stuckA === 0, `A. no card is left running (${stuckA})`);


// The model does not always cite; the question is asked again (at most three times) until the card holds a time.
const moments = JSON.parse(await page('JSON.stringify(window.maverickTest.lines().map((l) => l.t))')).map((t) => (t - startA) / 1000);
const secsOf = (s) => s.split(':').reduce((x, n) => x * 60 + Number(n), 0);
let a4;
const jumps = [];
for (let i = 0; i < 3; i++) {
  a4 = await ask('In the earlier budget meeting, who sends the budget? Cite the time it was said.');
  log(`4. answer ${i + 1}: ${a4.text.replace(/\s+/g, ' ').slice(0, 300)} | cites: ${(a4.html.match(/<button[^>]*class="cite"[^>]*>[^<]*<\/button>/g) || []).join(' ')}`);
  jumps.push(...[...a4.html.matchAll(/data-cmd="cite" data-t="([\d:]+)"/g)].map((m) => m[1]));
  if (/class="cite"/.test(a4.html)) break;
}
const stray = jumps.filter((t) => !moments.some((s) => Math.abs(s - secsOf(t)) <= 3));
check(!stray.length, `4. no transcript jump in any card points at a time that is no moment of meeting 2 (jumps: ${jumps.join(', ') || 'none'})`);
const chip = /data-cmd="earlier" data-m="acc-m1" data-t="00:20"/.test(a4.html);
check(chip, '4. the 00:20 citation from meeting 1 is a chip for that meeting');
if (chip) {
  await page("document.querySelector('#answers .answer.latest [data-cmd=\"earlier\"][data-t=\"00:20\"]').click(); 1");
  const hit = await until(() => page("(() => { const d = document.querySelector('#dlg-history'); const h = document.querySelector('#hist-detail li.hit strong'); const sel = document.querySelector('#hist-list button[aria-current=\"true\"]'); return d.open && h ? JSON.stringify({ line: h.textContent, meeting: sel?.dataset.id }) : ''; })()"), 5000);
  log(`4. clicked the earlier-meeting chip: ${hit}`);
  check(hit && JSON.parse(hit).meeting === 'acc-m1' && /^00:20/.test(JSON.parse(hit).line), '4. the chip opens meeting 1 in History at its 00:20 line');
  await page("document.querySelector('#dlg-history').close(); 1");
}
// ---- acceptance 2, defect F: a citation of the screen read at 00:01 (Solve, Explain) with the nearest line at 00:11
step = 'F';
const fRes = JSON.parse(await page(`(async () => {
  window.maverickTest.screens().push({ t: ${startA} + 1000, hash: 'f', text: 'Slide: y = 2x + 3' });
  document.querySelectorAll('#transcript li.hit').forEach((l) => l.classList.remove('hit'));
  const b = document.createElement('button'); b.dataset.cmd = 'cite'; b.dataset.t = '00:01';
  document.querySelector('#answers').append(b); b.click(); b.remove();
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({ hit: [...document.querySelectorAll('#transcript li.hit time')].map((t) => t.textContent), shown: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).find((x) => x.includes('Screen at 00:01')) || '' });
})()`));
log(`F. clicked [00:01]: ${JSON.stringify(fRes)}`);
check(!fRes.hit.length && /Screen at 00:01: Slide: y = 2x \+ 3/.test(fRes.shown), 'F. a citation of a screen read shows that read and highlights no transcript line (00:11 is the nearest)');
await page('window.maverickTest.discard()');

// ---- ghost pass 3: a question caught in the ask field, then the Answer button (not Enter in the field). The button sent
// "Transcript, last 2 minutes" with no question, and the model made up "I'll get you that door code right after we finish".
step = 'G3';
await page('window.maverickTest.backdate(750_000)'); // 12:30
await page("window.maverickTest.addLine('Speaker 1', 'Quick housekeeping first: the new server room door code is 7419, starting today.', 40_000)");
for (let t = 70_000, i = 0; t <= 740_000; t += 6_000, i++) {
  await page(`window.maverickTest.addLine('Speaker ${2 + (i % 2)}', ${JSON.stringify(`We went over ${filler[i % filler.length]}, point ${i + 1} of the rollout list, and moved on to the next point.`)}, ${t})`);
}
const QG = 'What is the new server room door code?';
await page(`window.maverickTest.addLine('Speaker 2', ${JSON.stringify(QG)}, 750_000)`);
const caughtG = await page("document.querySelector('form.ask input').value");
const nG = await page("document.querySelectorAll('#answers .answer').length");
await page("document.querySelector('.actions [data-action=\"answer\"]').click(); 1");
const doneG = await until(() => page(`(() => { const a = document.querySelector('#answers .answer.latest'); return document.querySelectorAll('#answers .answer').length > ${nG} && a.dataset.kind === 'answer' && a.getAttribute('aria-busy') === 'false' ? JSON.stringify({ q: a.querySelector('.q')?.textContent || '', text: a.querySelector('.md').textContent.replace(/\\s+/g, ' ').trim() }) : ''; })()`), 180000, 500);
const gAns = JSON.parse(doneG || '{}');
const pG = JSON.parse(await page('JSON.stringify(window.maverickTest.lastPrompt)'))[1].content;
log(`G3. caught "${caughtG}", then the Answer button: ${JSON.stringify(gAns)}`);
check(caughtG === QG && pG.includes(`The question to answer, just asked in the meeting: ${QG}`) && !pG.includes('Transcript, last 2 minutes') && pG.includes('7419'),
  'G3. the Answer button answers the caught question, with the whole meeting (the 00:40 line) in its prompt');
check(/7419/.test(gAns.text || '') && !/right after|get back to|get you that|after we finish|let me check/i.test(gAns.text || ''), `G3. the answer gives 7419 and no made-up deferral: "${(gAns.text || '').slice(0, 160)}"`);
check(await page("[...document.querySelectorAll('form.ask input')].every((i) => !i.value)"), 'G3. the caught question left the ask field once answered');
await page('window.maverickTest.discard()');

// ================================================================= 7 and 8. a flag pressed while its words are still being transcribed; the notes
step = '7 and 8';
await page('window.maverickTest.backdate(237_000)'); // now is 03:57
await page("window.maverickTest.addLine('Speaker 1', 'Good morning, this is the planning call.', 5_000)");
await page("window.maverickTest.addLine('Speaker 3', 'سارة بترسل الميزانية يوم الجمعة، صح؟', 12_000)"); // 13: an Arabic line in History
await page("window.maverickTest.addLine('Speaker 2', 'Sarah will send the budget by Friday.', 20_000)");
await page("window.maverickTest.addLine('Speaker 1', 'The budget still needs a second look before anyone signs it.', 47_000)");
const flagAt = await page('window.maverickTest.flag()');
const flaggedTime = () => page("[...document.querySelectorAll('#transcript li.flagged time')].map((t) => t.textContent).join(',')");
const atPress = await flaggedTime();
await page("window.maverickTest.addLine('Speaker 2', 'Omar will review the dashboard numbers on Thursday.', 232_000)"); // its transcription lands after the press
await page("window.maverickTest.addLine('Speaker 1', 'Thanks everyone, talk soon.', 236_500 + 20_000)");
const afterLate = await flaggedTime();
log(`7. flag at ${(flagAt / 1000).toFixed(0)} s: marked line ${atPress} at the press, ${afterLate} once the 03:52 line arrived`);
check(afterLate === '03:52', `7. the flag ends on the line spoken at it (03:52), not on 00:47 (was ${atPress} before that line arrived)`);
await page("document.querySelector('[data-cmd=end], #btn-end').click(); 1");
const saved = await until(() => page("(() => { const m = JSON.parse(localStorage.getItem('maverick.meetings') || '[]').find((x) => x.flags?.length); return m?.summary ? JSON.stringify(m) : ''; })()"), 240000, 1000);
if (!check(saved, '7. End & summarize wrote and saved the notes')) finish(1);
const mB = JSON.parse(saved);
log(`notes:\n${mB.summary}`);
const flagged = mB.summary.split(/^#{1,4}\s+/m).find((s) => /^flagged moments/i.test(s)) || '';
check(/Omar|dashboard|Thursday/i.test(flagged) && !/no speech|nothing was (?:said|transcribed|recorded)|no transcript/i.test(flagged), `7. the notes say what was said at the flag: ${flagged.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
const g = groundNotes(mB.summary, mB.transcript, mB.startedAt);
const removed = mB.summary.match(/Maverick removed (\d+)/)?.[1] || '0';
check(!g.dropped.length && !/approved in principle/i.test(mB.summary), `8. every decision and action item in the notes cites a line that backs it (${removed} removed by the app before saving)`);
const bullets = flagged.split('\n').slice(1).filter((l) => l.trim());
check(bullets.length === mB.flags.length && bullets.every((b) => /^- \*\*\d{2}:\d{2}\*\* \S/.test(b)) && !/\(nothing was transcribed|^- \*\*:/m.test(flagged),
  `14. one clean bullet per flag, each with a valid time: ${bullets.join(' | ').slice(0, 200)}`);
await page("document.querySelector('#dlg-summary').close(); 1");

// 13: the meeting in History; the Arabic line reads right to left after its label
await page("document.querySelector('#btn-history').click(); 1");
await until(() => page("document.querySelector('#dlg-history').open"), 3000);
await page(`document.querySelector('#hist-list button[data-id=${JSON.stringify(mB.id)}]').click(); 1`);
const rtl = JSON.parse(await until(() => page(`(() => {
  const li = [...document.querySelectorAll('#hist-detail li')].find((l) => l.textContent.includes('سارة بترسل'));
  const b = li?.querySelector('bdi[dir="auto"]');
  if (!b) return '';
  const t = b.firstChild; const g = (i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect(); };
  const label = li.querySelector('strong').getBoundingClientRect();
  return JSON.stringify({ text: b.textContent, firstRight: g(0).left > g(t.length - 2).left, labelFirst: label.left < g(t.length - 1).left, dir: getComputedStyle(b).direction });
})()`), 5000) || '{}');
log(`13. History line: ${JSON.stringify(rtl)}`);
check(rtl.text === 'سارة بترسل الميزانية يوم الجمعة، صح؟' && rtl.firstRight && rtl.labelFirst && rtl.dir === 'rtl', '13. History shows the Arabic line right to left, isolated after its label');
await page("document.querySelector('#dlg-history').close(); 1");

// ================================================================= 15. End & summarize when the deep model cannot start
// A deep model that is not installed, then one that never answers (a stub in front of Ollama that holds its requests,
// as a 27b model that cannot fit next to the live one did for 400 s): the meeting is in History within 3 s of the
// press, and the live model writes the notes within the deep model's time limit + 60 s, saying so at the top.
step = '15';
const DEEP_START_MS = Number(readFileSync(join(ROOT, 'src', 'app.mjs'), 'utf8').match(/const DEEP_START_MS = ([\d_]+)/)[1].replace(/_/g, ''));
const SLOW = 'maverick-slow-deep:27b';
// defect C: what qwen3.8:27b wrote on an Arabic Think harder Recap in the ghost pass (shortened), and nothing after it
const THINKER = 'maverick-thinker:27b';
const LEAKED = 'The user wants a recap of the meeting so far. Constraints:\n\nFormat: At most 8 short bullets.\nLanguage: Arabic (since previous answers were in Arabic).\n\n'
  + 'Key points from transcript:\n\n01:20 Jleeb branch sales down slightly due to parking maintenance.\n\nDrafting bullets in Arabic:\n\nانخفاض مبيعات فرع الجهراء بسبب صيانة المواقف01:20\n\nLooks good.';
const held = new Set();
const thinkerAsked = []; // what each request to the reasoning-only stub was for: 'unclear' (the unclear-words pass) or 'other'
const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && /^\/api\/(chat|generate)/.test(req.url) && body.includes(`"model":"${SLOW}"`)) { held.add(res); res.on('close', () => held.delete(res)); return; } // never answers
    if (req.method === 'POST' && req.url === '/api/chat' && body.includes(`"model":"${THINKER}"`)) { // writes only its reasoning (defect C)
      thinkerAsked.push(body.includes('You fill in [unclear] words') ? 'unclear' : 'other');
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': req.headers.origin || '*' }); // the page fetches it, as it does Ollama
      for (const w of LEAKED.match(/[\s\S]{1,24}/g)) res.write(`${JSON.stringify({ model: THINKER, message: { role: 'assistant', content: w }, done: false })}\n`);
      return res.end(`${JSON.stringify({ model: THINKER, message: { role: 'assistant', content: '' }, done: true })}\n`);
    }
    const up = httpRequest({ host: '127.0.0.1', port: 11434, path: req.url, method: req.method, headers: req.headers }, (r) => {
      if (req.url !== '/api/tags') { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', () => { // the slow model is "installed"
        const j = JSON.parse(Buffer.concat(parts));
        j.models.push({ name: SLOW, model: SLOW }, { name: THINKER, model: THINKER });
        const { 'content-length': _, 'transfer-encoding': __, ...h } = r.headers;
        res.writeHead(r.statusCode, h);
        res.end(JSON.stringify(j));
      });
    });
    up.on('error', () => res.destroy());
    up.end(body);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
const liveModel = await page("JSON.parse(localStorage.getItem('maverick.settings')).roles.live.model");
async function endWithDeep(deepModel, url, what, unclear = false) {
  await page(`window.maverickTest.useSettings({ connections: { ollama: { url: ${JSON.stringify(url)} } }, roles: { deep: { model: ${JSON.stringify(deepModel)} } } })`);
  const started = await page('window.maverickTest.backdate(90_000)');
  await page("window.maverickTest.addLine('Speaker 1', 'Thanks for joining the launch review.', 5_000)");
  await page("window.maverickTest.addLine('Speaker 2', 'Nadia will send the press kit on Tuesday.', 30_000)");
  await page("window.maverickTest.addLine('Speaker 1', 'Good, we ship the beta next week.', 60_000)");
  if (unclear) await page("window.maverickTest.addLine('Speaker 2', 'The launch party is at the [unclear] hall.', 70_000)"); // the deep model's unclear-words pass runs first
  const n = unclear ? 4 : 3;
  const find = `JSON.parse(localStorage.getItem('maverick.meetings') || '[]').find((x) => x.startedAt === ${started})`;
  const t0 = Date.now();
  await page("document.querySelector('[data-cmd=end], #btn-end').click(); 1");
  const inHistory = await until(() => page(`(() => { const m = ${find}; return m ? JSON.stringify({ lines: m.transcript.length }) : ''; })()`), 3000, 100);
  const savedMs = Date.now() - t0;
  check(inHistory && JSON.parse(inHistory).lines === n && savedMs <= 3000, `15. ${what}: the meeting is in History ${(savedMs / 1000).toFixed(1)} s after End & summarize (3 s at most), with its ${n} lines`);
  const limit = DEEP_START_MS + 60_000;
  const done = await until(() => page(`(() => { const m = ${find}; const b = document.querySelector('#sum-body').textContent; return m?.summary && b.includes('Written with') ? JSON.stringify({ summary: m.summary, shown: b.slice(0, 200) }) : ''; })()`), limit, 500);
  const doneMs = Date.now() - t0;
  const head = done ? JSON.parse(done).summary.split('\n')[0] : '';
  log(`15. ${what}: notes after ${(doneMs / 1000).toFixed(1)} s, first line: ${head}`);
  const want = `Written with ${liveModel}, because the deep model (${deepModel}) failed`;
  check(done && doneMs <= limit && head.startsWith(want) && JSON.parse(done).shown.startsWith(want) && /Nadia|press kit/i.test(JSON.parse(done).summary) && !/The user wants|Constraints|Looks good|Jleeb/i.test(done),
    `15. ${what}: the live model wrote the notes within ${limit / 1000} s (${(doneMs / 1000).toFixed(1)} s), and their first line says so`);
  await page("document.querySelector('#dlg-summary').close(); 1");
  return head;
}
await endWithDeep('maverick-no-such-model:1b', 'http://127.0.0.1:11434', 'a deep model that is not installed');
const slowHead = await endWithDeep(SLOW, STUB, 'a deep model that never answers');
check(new RegExp(`did not start writing within ${DEEP_START_MS / 1000} s`).test(slowHead), `15. the notes name the ${DEEP_START_MS / 1000} s limit`);
// C for the notes: a deep model that writes only its reasoning, in the notes and in the unclear-words pass before them.
// None of it is shown or saved; the live model writes the notes and their first line says why.
for (const unclear of [false, true]) {
  thinkerAsked.length = 0;
  const head = await endWithDeep(THINKER, STUB, `a deep model that writes only its reasoning${unclear ? ', in the unclear-words pass' : ''}`, unclear);
  check(/failed: it wrote only its reasoning, no notes\.$/.test(head), `C (notes${unclear ? ', unclear-words pass' : ''}). the first line says the deep model wrote only its reasoning: ${head}`);
  // the plain meeting: the deep model got the notes; with [unclear]: it got the unclear-words pass, failed there, and the live model wrote the notes
  check(thinkerAsked.join() === (unclear ? 'unclear' : 'other'), `C (notes${unclear ? ', unclear-words pass' : ''}). the reasoning-only model was asked for: ${thinkerAsked.join(', ') || 'nothing'}`);
}

// ---- acceptance 2, defect C: Think harder on an Arabic Recap, with a deep model that writes only its English reasoning
step = 'C';
await page(`window.maverickTest.useSettings({ connections: { ollama: { url: ${JSON.stringify(STUB)} } }, roles: { deep: { model: ${JSON.stringify(THINKER)} } } })`);
await page('window.maverickTest.backdate(150_000)');
await page("window.maverickTest.addLine('Speaker 1', 'ارتفعت مبيعات فرع السالمية بنسبة اثني عشر بالمئة هذا الأسبوع.', 35_000)");
await page("window.maverickTest.addLine('Speaker 2', 'مبيعات فرع الجهراء انخفضت قليلاً بسبب صيانة المواقف.', 80_000)");
await page("window.maverickTest.addLine('Speaker 1', 'الميزانية المقترحة للعرض ألفان وخمسمئة دينار.', 140_000)");
const latestDone = (n, kind) => until(() => page(`(() => { const a = document.querySelector('#answers .answer.latest'); return document.querySelectorAll('#answers .answer').length > ${n} && a.dataset.kind === '${kind}' && a.getAttribute('aria-busy') === 'false' ? a.querySelector('.md').textContent : ''; })()`), 180000, 500);
const nC = await page("document.querySelectorAll('#answers .answer').length");
await page("document.querySelector('[data-action=\"recap\"]').click(); 1");
const liveRecap = await latestDone(nC, 'recap');
await page("document.querySelector('#answers .answer.latest [data-cmd=\"deep\"]').click(); 1");
const deepRecap = (await latestDone(nC + 1, 'recap')) || '';
log(`C. Think harder Recap: ${deepRecap.replace(/\s+/g, ' ').slice(0, 400)}`);
const latin = (deepRecap.split('Answered with')[0].replace(/The deep model \([^)]*\) failed: it wrote only its reasoning, no answer\./, '').match(/[A-Za-z]/g) || []).length;
check(liveRecap && deepRecap && !/The user wants|Constraints|Looks good|Jleeb/i.test(deepRecap) && /[؀-ۿ]{3}/.test(deepRecap) && latin < 20,
  `C. no reasoning reaches the card, and the Recap stays in Arabic (${latin} Latin letters outside the note)`);
check(deepRecap.includes(`The deep model (${THINKER}) failed: it wrote only its reasoning, no answer. Answered with ${liveModel} instead.`), 'C. the live model answered, and the card says why');
await page('window.maverickTest.discard()');
await page("window.maverickTest.useSettings({ connections: { ollama: { url: 'http://127.0.0.1:11434' } }, roles: { deep: { model: '' } } })");
for (const r of held) r.destroy();
stub.close();

// ---- 12. the longest stalls over the run
const longs = JSON.parse(await page('JSON.stringify(window.__long)'));
const lag = await mainProc('globalThis.__lag');
log(`12. page long tasks: ${longs.length}, longest ${Math.max(0, ...longs)} ms, ${longs.filter((d) => d >= 200).length} of 200 ms or more; main process event loop: longest stall ${lag} ms`);
check(Math.max(0, ...longs) < 1000 && lag < 1000, '12. no stall near "not responding": the page and the main process each stayed under 1 s');

// ---- the end
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
killTree(app.pid);
await sleep(1500);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nacceptance fixes passed');
finish(fails.length ? 1 : 0);
