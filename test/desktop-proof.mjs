// node test/desktop-proof.mjs   (Windows, Ollama with gemma4:12b and qwen3.8:27b, speakers on)
// Launches the real desktop app with debug ports, then proves the desktop features end to end and
// writes shots/desktop/*.png plus shots/desktop/proof-log.txt:
//   1. main window and bar screenshots        4. global hotkey while another window has focus (SendKeys)
//   2. Start listening from the tray action   5. Think harder round trip on the deep model, with latency
//   3. loopback transcription of a TTS WAV    6. renderer console errors, then a clean quit
// SendKeys and the TTS playback are test harnesses only. The app is quit at the end.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'desktop');
const HARNESS = join(ROOT, 'test', 'desktop-harness.ps1');
const SENTENCE = "Hi team. Let's move the product launch to Thursday, and Sarah will send the budget by Friday.";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const ollamaPs = async () => (await (await fetch('http://127.0.0.1:11434/api/ps')).json()).models.map((m) => `${m.name} (vram ${(m.size_vram / 1e9).toFixed(1)} GB)`).join(', ') || 'none';

// Screen region to PNG (physical pixels), or a crop of an existing PNG.
const psDraw = 'Add-Type -AssemblyName System.Drawing, System.Windows.Forms; Add-Type -Name D -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; [W.D]::SetProcessDPIAware() | Out-Null;';
const grab = (file, r) => ps(`${psDraw} $b = New-Object System.Drawing.Bitmap ${r.width}, ${r.height}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${r.x}, ${r.y}, 0, 0, $b.Size); $b.Save('${file}'); $g.Dispose(); $b.Dispose()`);
const crop = (src, file, r) => ps(`${psDraw} $s = [System.Drawing.Bitmap]::FromFile('${src}'); $c = $s.Clone((New-Object System.Drawing.Rectangle ${r.x}, ${r.y}, ${r.width}, ${r.height}), $s.PixelFormat); $c.Save('${file}'); $c.Dispose(); $s.Dispose()`);

// ---- launch
const app = spawn(electron, ['.', '--remote-debugging-port=9333', '--inspect=9229'], { cwd: ROOT, windowsHide: false });
const out = [];
app.stdout.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
app.stderr.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); });
  return Object.assign(async (expression) => {
    const my = ++id;
    const res = await new Promise((resolve) => { pending.set(my, resolve); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval failed');
    return res.result?.result?.value;
  }, { close: () => ws.close() });
}
async function target(port, pick, ms = 20000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick); if (t) return t.webSocketDebuggerUrl; } catch { /* starting */ }
  }
  throw new Error(`no debug target on ${port}`);
}
async function until(fn, ms, every = 500) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) { const v = await fn(); if (v) return v; }
  return null;
}

let exitCode = 0;
try {
  const main = await cdp(await target(9229, () => true));
  const M = (body) => main(`(async () => { const { app, BrowserWindow, screen } = process.mainModule.require('electron'); const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); const bar = W.find((w) => w !== page); ${body} })()`);
  const page = await cdp(await target(9333, (t) => t.url.startsWith('http://127.0.0.1')));
  const barEval = await cdp(await target(9333, (t) => t.url === 'about:blank'));
  await until(() => M('return !!bar && bar.isVisible();'), 10000);
  log(`app: Electron ${await M('return process.versions.electron;')}, page ${await page('location.href')}`);
  log(`hotkeys: ${await page('window.maverick.settings().then((s) => s.failed.length ? "FAILED " + JSON.stringify(s.failed) : "all " + Object.keys(s.keys).length + " registered")')}`);
  log(`bar: ${await M('const b = bar.getBounds(); return JSON.stringify({ ...b, alwaysOnTop: bar.isAlwaysOnTop(), focusable: bar.isFocusable(), contentProtection: bar.isContentProtected?.() ?? "n/a" });')}`);

  // 1. screenshots: the main window (capturePage) and the bar over the desktop (a real screen grab)
  await M(`const img = await page.webContents.capturePage(); process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(join(OUT, 'main-window.png'))}, img.toPNG()); return 1;`);
  const scale = await M('return screen.getPrimaryDisplay().scaleFactor;');
  const bb = JSON.parse(await M('return JSON.stringify(bar.getBounds());'));
  const region = (b, pad) => ({ x: Math.max(0, Math.round((b.x - pad) * scale)), y: Math.max(0, Math.round((b.y - 10) * scale)), width: Math.round((b.width + 2 * pad) * scale), height: Math.round((b.height + 140) * scale) });
  grab(join(OUT, 'bar-over-desktop.png'), region(bb, 160));
  // Acrylic check: with the page background cleared, whatever shows through is the Windows material.
  await barEval("document.querySelector('.mini').style.background = 'transparent'; 1");
  await sleep(400);
  grab(join(OUT, 'bar-acrylic-see-through.png'), region(bb, 160));
  await barEval("document.querySelector('.mini').style.background = ''; 1");
  log('shots: main-window.png (capturePage), bar-over-desktop.png (screen grab around the bar), bar-acrylic-see-through.png (page background cleared)');

  // 2. and 3. Start listening exactly as the tray does, then play speech through the speakers
  await M("page.webContents.send('action', 'listen'); return 1;");
  const rec = await until(() => page("document.querySelector('#st-rec').innerText.includes('Meeting') && document.querySelector('#st-rec').innerText.replace(/\\s+/g, ' ')"), 15000);
  log(`listening: ${rec}`);
  const wav = join(tmpdir(), `maverick-proof-${process.pid}.wav`);
  const t0 = Date.now();
  log(ps(`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${SENTENCE.replace(/'/g, "''")}'); $s.Dispose(); $p = New-Object System.Media.SoundPlayer '${wav}'; $p.PlaySync(); 'played ${wav.replace(/'/g, '')} through the speakers'`));
  rmSync(wav, { force: true });
  const heard = await until(() => page("[...document.querySelectorAll('#transcript .line')].map((l) => l.innerText.replace(/\\s+/g, ' ')).find((t) => /thursday|budget|sarah/i.test(t))"), 45000);
  log(`spoken:     ${SENTENCE}`);
  log(`transcript: ${heard || 'NOT HEARD'} (${((Date.now() - t0) / 1000).toFixed(1)} s after playback started)`);
  if (!heard) exitCode = 1;

  // Two voices in a row through the speakers: the meeting lines should get two speaker labels; then rename one.
  const n0 = await page('document.querySelectorAll("#transcript .line").length');
  const wav2 = join(tmpdir(), `maverick-proof-two-${process.pid}.wav`);
  log(ps(`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav2}'); $s.SelectVoice('Microsoft David Desktop'); $s.Speak('The server costs went up by twenty percent last month.'); $s.SelectVoice('Microsoft Zira Desktop'); $s.Speak('Then we should move the old reports to cheaper storage this week.'); $s.Dispose(); (New-Object System.Media.SoundPlayer '${wav2}').PlaySync(); 'played a male then a female voice'`));
  rmSync(wav2, { force: true });
  const two = await until(() => page(`(() => { const ls = [...document.querySelectorAll('#transcript .line')].slice(${n0}).filter((l) => /server|cost|storage|report/i.test(l.innerText)); return ls.some((l) => /storage|report/i.test(l.innerText)) && JSON.stringify(ls.map((l) => [l.querySelector('.who')?.textContent, l.querySelector('p').textContent, l.querySelector('p').getAttribute('dir')])); })()`), 45000);
  log(`two voices -> [label, text, dir]: ${two || 'NOT HEARD'}`);
  const renamed = await page(`(async () => { const w = [...document.querySelectorAll('#transcript .who[data-spk]')].at(-1); if (!w) return 'no speaker label'; const id = w.dataset.spk; w.click(); const i = document.querySelector('.who-edit'); i.value = 'Zira'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 200)); return id + ' -> ' + [...document.querySelectorAll('#transcript .who[data-spk="' + id + '"]')].map((x) => x.textContent).join(', '); })()`);
  log(`rename the last speaker: ${renamed}`);
  await M(`const img = await page.webContents.capturePage(); process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(join(OUT, 'transcript-speakers.png'))}, img.toPNG()); return 1;`);

  // 4. global hotkey while another window has focus: Ctrl+Shift+4 is Recap
  const before = await page('document.querySelectorAll("#answers .answer").length');
  const tmpShot = join(tmpdir(), `maverick-hotkey-${process.pid}.png`);
  const h = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Keys', '^+4', '-Shot', tmpShot, '-WaitMs', '15000'], { encoding: 'utf8' });
  h.trim().split(/\r?\n/).forEach((l) => log(`harness: ${l}`));
  const recap = await until(() => barEval("(() => { const a = document.querySelector('.mini-answer .answer'); return a && a.dataset.kind === 'recap' && a.getAttribute('aria-busy') === 'false' && a.innerText.replace(/\\s+/g, ' ').slice(0, 160); })()"), 60000);
  log(`hotkey Ctrl+Shift+4 -> bar card: ${recap || 'NONE'}; cards ${before} -> ${await page('document.querySelectorAll("#answers .answer").length')}`);
  if (!recap) exitCode = 1;
  const bb2 = JSON.parse(await M('return JSON.stringify(bar.getBounds());'));
  const top = Math.min(bb2.y, 640);
  crop(tmpShot, join(OUT, 'hotkey-ctrl-shift-4-recap.png'), { x: Math.round(Math.min(bb2.x, 580) * scale) - 20, y: Math.max(0, Math.round(top * scale) - 10), width: Math.round((Math.max(bb2.x + bb2.width, 1340) - Math.min(bb2.x, 580)) * scale) + 40, height: Math.round((940 - top) * scale) + 20 });
  rmSync(tmpShot, { force: true });
  log('shots: hotkey-ctrl-shift-4-recap.png (harness window focused, answer in the bar)');

  // 5. Think harder on the deep model via its hotkey, Ctrl+Shift+T; the live model must come back after
  log(`ollama before: ${await ollamaPs()}`);
  const d0 = Date.now();
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Keys', '^+t', '-WaitMs', '500'], { encoding: 'utf8' });
  const deepCard = "document.querySelector('.mini-answer .answer')";
  const started = await until(() => barEval(`!!${deepCard}?.querySelector('.tag.deep')`), 15000, 200);
  log(`think harder: card with the Deep tag ${started ? 'shown' : 'NOT shown'}`);
  await sleep(8000);
  log(`think harder, progress: ${await barEval(`${deepCard}?.querySelector('.state')?.textContent + ' | ' + (${deepCard}?.querySelector('.deep-wait')?.textContent || '')`)}; transcript header: "${await page("document.querySelector('#tr-status').textContent")}"`);
  grab(join(OUT, 'think-harder-progress.png'), region(JSON.parse(await M('return JSON.stringify(bar.getBounds());')), 40));
  let firstText = 0;
  const seen = [];
  const done = await until(async () => {
    const now = await ollamaPs();
    if (seen.at(-1)?.[1] !== now) seen.push([((Date.now() - d0) / 1000).toFixed(0), now]);
    const s = await barEval(`(() => { const a = ${deepCard}; return a ? JSON.stringify({ busy: a.getAttribute('aria-busy'), text: a.querySelector('.md').innerText.trim(), deep: !!a.querySelector('.tag.deep'), note: [...a.querySelectorAll('.stopped')].map((p) => p.textContent).join(' ') }) : null; })()`);
    const j = s && JSON.parse(s);
    if (j?.text && !firstText && !/Thinking harder/.test(j.text)) firstText = Date.now();
    return j?.busy === 'false' ? j : null;
  }, 300000, 1000);
  const secs = ((Date.now() - d0) / 1000).toFixed(1);
  log(`think harder: ${done ? `done in ${secs} s, first text after ${firstText ? ((firstText - d0) / 1000).toFixed(1) : '?'} s, deep tag kept: ${done.deep}${done.note ? `, note: ${done.note}` : ''}` : `NOT DONE after ${secs} s`}`);
  log(`think harder answer: ${done?.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  log(`ollama while thinking: ${seen.map(([t, m]) => `${t} s: ${m}`).join('; ')}`);
  if (!done?.deep) exitCode = 1;
  grab(join(OUT, 'think-harder-done.png'), region(JSON.parse(await M('return JSON.stringify(bar.getBounds());')), 40));
  const r0 = Date.now();
  const back = await until(async () => { const m = await ollamaPs(); return /gemma/.test(m) && !/qwen/.test(m) && m; }, 120000, 1000);
  log(`ollama after: ${back ? `${back}, the live model was back ${((Date.now() - r0) / 1000).toFixed(1)} s after the deep answer (deep model unloaded)` : `NOT BACK: ${await ollamaPs()}`}`);

  // 6. console errors, stop listening, leave no test meeting behind, quit
  await M("page.webContents.send('action', 'listen'); return 1;");
  await sleep(1500);
  await page("localStorage.removeItem('maverick.live'); 1");
  // Node keeps a process alive while a debugger is attached, so detach before quitting.
  await main('setTimeout(() => process.mainModule.require("electron").app.quit(), 300); 1');
  main.close();
  page.close();
  barEval.close();
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
  exitCode = 1;
}
const code = await Promise.race([new Promise((r) => app.on('exit', r)), sleep(10000).then(() => 'still running')]);
if (code === 'still running') app.kill();
const errors = out.filter((l) => /\[(page|bar) error\]/.test(l));
log(`app exit: ${code}; renderer console errors: ${errors.length}${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
log(`renderer warnings: ${out.filter((l) => /\[(page|bar) warning\]/.test(l)).length}`);
if (errors.length) exitCode = 1;
writeFileSync(join(OUT, 'proof-log.txt'), `${new Date().toISOString()}\n${lines.join('\n')}\n\n--- app stdout ---\n${out.join('\n')}\n`);
process.exit(exitCode);
