// node test/glass-proof.mjs [--quick]   (Windows 11; Ollama with the live model for the answer shots, skipped with --quick)
// Screenshots and measurements for the glass design, written to shots/glass/ (overwritten) with proof-log.txt:
//   first run, main window in dark and light (real screen grabs of the Mica window);
//   the bar idle, mid-morph, streaming and finished, in dark and light, over a busy backdrop (real screen grabs);
//   hover and pressed states (forced with CDP); the bar at 100, 125 and 150 % (deviceScaleFactor emulation,
//   composited over the same backdrop) with 3x crops of the icons; Settings and History; an emulated Windows
//   light/dark flip caught mid-crossfade; the web app at 390 px; computed radii, strokes, hairlines, motion,
//   reduced motion, focus rings and layout-shift checks; renderer console errors.
// The app runs in a throwaway profile (MAVERICK_USER_DATA, a new temp folder), so the owner's settings, meetings and
// bar position are never read or written; the real profile's Local Storage is hashed before and after and must be
// byte-identical. The demo meeting (test/demo-meeting.json) is served through an in-memory localStorage shim.
// Also: both bar materials (capsule and acrylic) side by side, and a Think harder frame mid-progress.
// A check that fails prints FAIL and the run exits 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shots', 'glass');
const QUICK = process.argv.includes('--quick');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
let exitCode = 0;
const fails = [];
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); exitCode = 1; } return ok; };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const psDraw = 'Add-Type -AssemblyName System.Drawing; Add-Type -Name D -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; [W.D]::SetProcessDPIAware() | Out-Null;';
// 24-bit, no alpha: a 32-bit grab keeps the screen's undefined alpha byte, and a few pure-black pixels came out fully
// transparent, which image viewers draw as bright white dashes (they were never on the screen).
const grab = (file, r) => ps(`${psDraw} $b = New-Object System.Drawing.Bitmap ${r.width}, ${r.height}, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${r.x}, ${r.y}, 0, 0, $b.Size); $b.Save('${file}'); $g.Dispose(); $b.Dispose()`);
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { windowsHide: true });

const backdrop = spawn(electron, [join(ROOT, 'test', 'glass-backdrop.cjs')], { cwd: ROOT, windowsHide: false });
await sleep(1500);
// The owner's real profile: fingerprint every file of its Local Storage now, compare at the end.
const REAL = join(process.env.APPDATA || '', 'maverick', 'Local Storage');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);
const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-proof-'));
const app = spawn(electron, ['.', '--remote-debugging-port=9333', '--inspect=9229'], { cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_CAPTURE_VISIBLE: '1', MAVERICK_TEST_HOOKS: '1' } });
const out = [];
const finish = () => { writeFileSync(join(OUT, 'proof-log.txt'), `${lines.join('\n')}\n`); for (const f of ['tmp-behind.png', 'tmp-behind-tall.png', 'tmp-bar.png']) rmSync(join(OUT, f), { force: true }); };
const bail = (e) => { log(`FAIL: ${e?.stack || e}`); finish(); app.kill(); backdrop.kill(); process.exit(1); };
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));

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
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9333/json/list')).json(); } catch { return []; } };
async function target(pick, ms = 20000) {
  const t = await until(async () => (await targets()).find(pick), ms);
  if (!t) throw new Error('no debug target');
  return t;
}

const main = await cdp((await until(async () => { try { return (await (await fetch('http://127.0.0.1:9229/json/list')).json())[0]; } catch { return null; } }, 20000)).webSocketDebuggerUrl);
const M = (body) => main(`(async () => { const { app, BrowserWindow, screen, globalShortcut, nativeTheme } = process.mainModule.require('electron'); const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); const bar = W.find((w) => w.getTitle() === 'Maverick bar') || W.find((w) => w !== page && !/^(Maverick,|web390|proof)/.test(w.getTitle())); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
let barTarget = await target((t) => t.type === 'page' && t.url === 'about:blank');
let bar = await cdp(barTarget.webSocketDebuggerUrl);
await until(() => M('return !!bar && bar.isVisible();'), 10000);
const ready = () => until(() => page("(() => { const s = document.querySelector('#st-ai'); return !!s && !s.classList.contains('busy'); })()"), 20000);
await ready();
check(await page("document.querySelector('#st-ai').classList.contains('ok')"), 'the assistant is ready (Ollama answered the health check)');
const port = await page('location.port');
log(`prefers-reduced-motion on this PC: ${await page("matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'")}; emulating no-preference for the motion checks`);
const motionOn = async () => { for (const t of [page, bar]) await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); };
await motionOn();
const oldPos = await M('return JSON.stringify(bar.getPosition());');
const realTheme = await page("localStorage.getItem('maverick.theme') || ''");
const centreBar = () => M('const b = bar.getBounds(); const d = screen.getPrimaryDisplay().bounds; bar.setPosition(Math.round(d.x + (d.width - b.width) / 2), 60); return 1;');
const bounds = async () => JSON.parse(await M('return JSON.stringify(bar.getBounds());'));
log(`app: Electron ${await M('return process.versions.electron;')}, Windows ${await M("return process.getSystemVersion();")}, display scale ${await M('return screen.getPrimaryDisplay().scaleFactor;')}, main window ${await M('return JSON.stringify(page.getBounds());')}`);
log(`main window: Mica ${await M("return String(page.getBackgroundColor?.() ?? '');")} background, html.glass=${await page("document.documentElement.classList.contains('glass')")}`);

// ---- the storage shim, and a reload that puts it in place before app.mjs runs
await page.send('Page.enable');
let shimId = null;
async function reloadWith(fake) {
  if (shimId) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shimId });
  shimId = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const F = ${JSON.stringify(fake)};
    const own = (s, k) => s === window.localStorage && Object.prototype.hasOwnProperty.call(F, k);
    const { getItem, setItem, removeItem } = Storage.prototype;
    Storage.prototype.getItem = function (k) { return own(this, k) ? F[k] : getItem.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (own(this, k)) F[k] = String(v); else setItem.call(this, k, v); };
    Storage.prototype.removeItem = function (k) { if (own(this, k)) F[k] = null; else removeItem.call(this, k); };
  })();` })).identifier;
  const old = barTarget.id;
  await M('bar && bar.destroy(); return 1;');
  await page.send('Page.reload', { ignoreCache: true });
  barTarget = await target((t) => t.type === 'page' && t.url === 'about:blank' && t.id !== old);
  bar.close();
  bar = await cdp(barTarget.webSocketDebuggerUrl);
  await until(() => M('return !!bar && bar.isVisible();'), 10000);
  await ready();
  await motionOn();
  await centreBar();
  await sleep(600);
}

const setTheme = async (t) => { await page(`(() => { const r = document.querySelector('input[name="appearance"][value="${t}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await sleep(700); };
const around = (b, extraH = 0) => ({ x: b.x - 60, y: b.y - 40, width: b.width + 120, height: b.height + 80 + extraH });
const shotBar = async (name) => { grab(join(OUT, `${name}.png`), around(await bounds())); log(`shot: ${name}.png`); };
const raw = async (png) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 28 });
// Opacity gate, in pixels on the real screen: the bar is grabbed over a pure-white window, then pure black, white
// again and black again, with nothing else changed. Inside the answer and the ask field (the capsule's straight
// middle), a pixel is the desktop showing through when it differs by more than 10/255 on a channel in every
// white/black pair in the sequence. A pixel that changes once and not back is the bar repainting between two grabs
// (a clock tick re-rasters the row's text), which is logged as repaint noise, not counted as see-through. More than
// 1 % see-through fails. The glass icon row is the positive control: it must show through.
async function opacityGate(label) {
  const b = await bounds();
  const boxes = JSON.parse(await bar(`JSON.stringify(['.mini-answer', '.mini .ask input', '.bar-acts'].map((s) => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); const inset = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.height / 2); return { s, x: Math.ceil(r.x + inset), y: Math.ceil(r.y), w: Math.floor(r.width - 2 * inset), h: Math.floor(r.height) }; }))`));
  const seq = [];
  for (const [k, c] of [['white', 'rgb(255,255,255)'], ['black', 'rgb(0,0,0)'], ['white', 'rgb(255,255,255)'], ['black', 'rgb(0,0,0)']]) { // no '#': in a data: URL it would start the fragment
    await M(`let g = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'proof gate'); if (!g) { g = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, show: false, focusable: false, skipTaskbar: true, title: 'proof gate' }); g.setAlwaysOnTop(true, 'floating'); g.on('page-title-updated', (e) => e.preventDefault()); } await g.loadURL('data:text/html,<html style="background:${c}"></html>'); g.showInactive(); g.moveTop(); bar.moveTop(); return 1;`); // above the backdrop, below the bar
    await sleep(700);
    const f = join(OUT, `tmp-gate-${seq.length}-${k}.png`); // the last set stays, for a look
    grab(f, b);
    seq.push(await raw(f));
  }
  await M("BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'proof gate')?.hide(); return 1;");
  const diff = (a, z, i) => Math.max(Math.abs(a[i] - z[i]), Math.abs(a[i + 1] - z[i + 1]), Math.abs(a[i + 2] - z[i + 2]));
  for (const box of boxes) {
    let n = 0; let bad = 0; let worst = 0; let noise = 0; let first = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const i = (y * b.width + x) * 3;
        const pairs = [diff(seq[0], seq[1], i), diff(seq[1], seq[2], i), diff(seq[2], seq[3], i)];
        n++;
        if (pairs[0] > 10) first++;
        if (diff(seq[0], seq[2], i) > 10 || diff(seq[1], seq[3], i) > 10) noise++;
        if (Math.min(...pairs) > 10) { bad++; worst = Math.max(worst, Math.min(...pairs)); }
      }
    }
    const pct = Math.round((bad / n) * 10000) / 100;
    if (box.s === '.bar-acts') { check(pct > 20, `opacity gate control (${label}): the glass icon row does let the desktop through, ${bad} of ${n} px (${pct} %) differ in every pair (largest ${worst}/255)`); continue; }
    check(n > 500 && pct <= 1, `opacity gate (${label}) ${box.s}: ${bad} of ${n} px (${pct} %) see-through (over 10/255 in all 3 white/black pairs), largest ${worst}/255; first pair alone ${first} px, repaint noise ${noise} px`);
  }
}
// Dialog gate, the same idea for the main window's sheets. With the dialog open, everything behind it is swapped for
// pure white, then black, white, black (a style that hides the page and paints the canvas). Inside the dialog (inset by
// its corner radius) a pixel that differs in every pair is the page reading through: more than 1 % fails. The scrim
// around it must change (control). Then the scrim itself: text is legible where neighbouring pixels step sharply, so
// outside the dialog a pixel whose right or lower neighbour differs by more than 12/255 counts as a sharp edge. The
// same count on the page without the dialog is the reference; behind the dialog it must be under 0.1 %.
async function dialogGate(label, sel) {
  await M("bar.hide(); page.show(); page.setAlwaysOnTop(true, 'screen-saver'); page.moveTop(); return 1;");
  await sleep(500);
  const cb = JSON.parse(await M('return JSON.stringify(page.getContentBounds());'));
  const z = await page('devicePixelRatio');
  const d = JSON.parse(await page(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`));
  const inset = 28;
  const box = { x: Math.ceil((d.x + inset) * z), y: Math.ceil((d.y + inset) * z), w: Math.floor((d.w - 2 * inset) * z), h: Math.floor((d.h - 2 * inset) * z) };
  const outer = { x: Math.ceil((d.x - 4) * z), y: Math.ceil((d.y - 4) * z), w: Math.floor((d.w + 8) * z), h: Math.floor((d.h + 8) * z) };
  // a constructed style sheet: the page's CSP blocks inline <style>, and this is how the proof paints behind the dialog
  const under = (css) => page(`(() => { const s = (window.proofUnder ??= new CSSStyleSheet()); s.replaceSync(${JSON.stringify(css)}); if (!document.adoptedStyleSheets.includes(s)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; return 1; })()`);
  const shoot = async (k) => { await sleep(400); const f = join(OUT, `tmp-dlg-${k}.png`); grab(f, cb); return raw(f); };
  const seq = [];
  for (const c of ['#fff', '#000', '#fff', '#000']) { await under(`html, body { background: ${c} !important; } body > :not(dialog) { visibility: hidden !important; }`); seq.push(await shoot(seq.length)); }
  await under(''); const real = await shoot('real');
  await M('page.setAlwaysOnTop(false); bar.showInactive(); return 1;');
  const W = cb.width;
  const diff = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
  let n = 0; let bad = 0; let worst = 0; let ctl = 0; let ctlN = 0; let legible = 0; let outN = 0; let ref = 0;
  // the scrim band within 40 px of the dialog: nothing bright on dark (over 200/255) or dark on light (under 55/255)
  const dark = label.endsWith('dark'); const band = 40 * z; let stray = 0; let bandN = 0; let extreme = dark ? 0 : 255;
  const shotAlpha = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(OUT, `${label.startsWith('History') ? 'history-empty' : 'settings'}-${dark ? 'dark' : 'light'}.png`), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { windowsHide: true, maxBuffer: 1 << 28 });
  let clear = 0; for (let i = 3; i < shotAlpha.length; i += 4) if (shotAlpha[i] < 255) clear++;
  await page(`document.querySelector('${sel}').close(); 1`); await M("page.setAlwaysOnTop(true, 'screen-saver'); page.moveTop(); bar.hide(); return 1;"); const open = await shoot('nodialog');
  await M('page.setAlwaysOnTop(false); bar.showInactive(); return 1;');
  await page(`document.querySelector('${sel}').showModal(); 1`); await sleep(500);
  const step = (a, i, x, y) => (x + 1 < W && diff(a, a.subarray(3), i) > 12) || (y + 1 < cb.height && diff(a, a.subarray(W * 3), i) > 12);
  for (let y = 0; y < cb.height; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      const inOuter = x >= outer.x && x < outer.x + outer.w && y >= outer.y && y < outer.y + outer.h;
      if (inBox) {
        n++;
        const m = Math.min(diff(seq[0], seq[1], i), diff(seq[1], seq[2], i), diff(seq[2], seq[3], i));
        if (m > 10) bad++; worst = Math.max(worst, m);
      } else if (!inOuter && y > 60 * z) { // below the title bar, whose Windows controls sit above the scrim
        ctlN++; if (diff(seq[0], seq[1], i) > 10) ctl++;
        outN++; if (step(real, i, x, y)) legible++; if (step(open, i, x, y)) ref++;
        if (x >= outer.x - band && x < outer.x + outer.w + band && y >= outer.y - band && y < outer.y + outer.h + band) {
          bandN++; const v = dark ? Math.max(real[i], real[i + 1], real[i + 2]) : Math.min(real[i], real[i + 1], real[i + 2]);
          extreme = dark ? Math.max(extreme, v) : Math.min(extreme, v); if (dark ? v > 200 : v < 55) stray++;
        }
      }
    }
  }
  const pct = (a, b) => Math.round((a / b) * 10000) / 100;
  check(pct(ctl, ctlN) > 50, `dialog gate control (${label}): the scrim does change with what is behind it, ${pct(ctl, ctlN)} % of its pixels`);
  check(n > 5000 && pct(bad, n) <= 1, `dialog gate (${label}): ${bad} of ${n} px (${pct(bad, n)} %) inside the dialog change with what is behind it (over 10/255 in all 3 white/black pairs), largest ${worst}/255`);
  check(stray === 0 && clear === 0, `scrim band (${label}): ${stray} of ${bandN} px within 40 px of the dialog are ${dark ? 'brighter than 200' : 'darker than 55'}/255 (${dark ? 'brightest' : 'darkest'} ${extreme}); the saved shot has ${clear} transparent pixels`);
  check(pct(legible, outN) < 0.1, `scrim (${label}): ${legible} of ${outN} px (${pct(legible, outN)} %) around the dialog are sharp edges (a neighbour over 12/255 away); the same page without the dialog has ${ref} (${pct(ref, outN)} %)`);
}
// The main window, grabbed from the screen so the Mica material is in the picture; it is lifted above the backdrop
// and the bar is hidden while it is taken.
const shotMain = async (name) => {
  await M("bar.hide(); page.show(); page.setAlwaysOnTop(true, 'screen-saver'); page.moveTop(); page.focus(); return 1;");
  await sleep(700);
  grab(join(OUT, `${name}.png`), JSON.parse(await M('return JSON.stringify(page.getContentBounds());')));
  await M('page.setAlwaysOnTop(false); bar.showInactive(); return 1;');
  log(`shot: ${name}.png`);
};

// ================================================================= first run (no history, no meeting)
log(`profile: ${await M("return app.getPath('userData');")} (throwaway; the real one, ${join(process.env.APPDATA || '', 'maverick')}, is not opened)`);
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), 'the app runs in the throwaway profile');
// A deep model this PC has, so Think harder can run (qwen3.8 is installed; the default name is qwen3.8:27b).
// PROOF_NO_DEEP=1 sets no deep model, so a run never loads it, and skips the Think harder frame.
const NO_DEEP = !!process.env.PROOF_NO_DEEP;
const SETTINGS = JSON.stringify({ providers: { ollama: { deepModel: NO_DEEP ? '' : 'qwen3.8' } } });
await reloadWith({ 'maverick.theme': realTheme, 'maverick.meetings': '[]', 'maverick.live': null, 'maverick.settings': SETTINGS });
check(await page("!document.querySelector('#first-run').hidden && document.querySelector('.grid').classList.contains('solo')"), 'first run: the checklist shows, in the single centred column');
check(await page("['answer', 'followup', 'recap'].every((a) => document.querySelector(`.act[data-action=\"${a}\"]`).disabled)"), 'no transcript: Answer, Follow-ups and Recap are switched off');
for (const t of ['dark', 'light']) { await setTheme(t); await shotMain(`first-run-${t}`); }
{ // shortcut copy: every label names a key that is registered, and says whether it is global or in-window
  const keys = JSON.parse(await M('return JSON.stringify(Object.fromEntries(["Ctrl+Shift+Enter", "Ctrl+Shift+3", "Alt+1"].map((k) => [k, process.mainModule.require("electron").globalShortcut.isRegistered(k)])));'));
  const copy = JSON.parse(await page("(() => { const k = document.querySelector('.keys'); return JSON.stringify({ main: k.textContent, fits: k.scrollWidth <= k.clientWidth, act: document.querySelector('.act[data-action=followup]').dataset.tip }); })()"));
  const first = await bar("document.querySelector('.mini-empty')?.textContent || ''");
  const tip = await bar("document.querySelector('.bar-acts .ib[data-action=followup] .tip').textContent");
  check(keys['Ctrl+Shift+Enter'] && keys['Ctrl+Shift+3'] && !keys['Alt+1'], `registered global keys: ${JSON.stringify(keys)} (Alt 1 to 5 are in-window keys, handled in the page)`);
  check(/Ctrl Shift Enter.*from any app/.test(first), `bar first run names the global key: "${first.slice(0, 90)}"`);
  check(/Ctrl Shift Enter answers from any app/.test(copy.main) && /Here: Alt 1 to Alt 4/.test(copy.main) && copy.fits, `main window key line says which is which, in full on one line (${copy.fits}): "${copy.main}"`);
  check(/Alt 3 in this window, Ctrl Shift 3 from any app/.test(copy.act), `action button title: "${copy.act}"`);
  check(/Ctrl Shift 3/.test(tip), `bar tooltip shows the global key: "${tip}"`);
}

// ================================================================= the demo meeting
const demo = JSON.parse(readFileSync(join(ROOT, 'test', 'demo-meeting.json'), 'utf8'));
const startedAt = Date.now() - (demo.lines.at(-1).at + 60) * 1000;
const live = { id: 'demo', title: demo.title, startedAt, transcript: demo.lines.map((l) => ({ who: l.who, text: l.text, t: startedAt + l.at * 1000 })), flags: [], answers: [] };
const DEMO_FAKE = { 'maverick.theme': 'dark', 'maverick.meetings': '[]', 'maverick.live': JSON.stringify(live), 'maverick.settings': SETTINGS };
await reloadWith(DEMO_FAKE);
check(await page(`document.querySelectorAll('#transcript .line').length === ${demo.lines.length}`), `demo meeting restored: ${demo.lines.length} transcript lines`);
await page("document.querySelector('.banner[data-key=\"recover\"] [data-dismiss]')?.click(); 1");
check(await page("!document.querySelector('.act[data-action=\"answer\"]').disabled"), 'with a transcript, Answer is on');

// ---- idle bar, both themes
for (const t of ['dark', 'light']) {
  await setTheme(t); await shotBar(`bar-idle-${t}`);
}
const slab = JSON.parse(await bar("JSON.stringify((({ width, height }) => ({ width, height }))(document.querySelector('.mini').getBoundingClientRect()))"));
check(slab.height === 52, `the bar is one row: slab ${slab.width}x${slab.height} (want 52 tall)`);

// ---- hover and pressed, forced with CDP (the tooltip waits 350 ms, the lift and press run on their curves)
await setTheme('dark');
await bar.send('DOM.enable'); await bar.send('CSS.enable');
const docId = (await bar.send('DOM.getDocument')).root.nodeId;
const node = async (sel) => (await bar.send('DOM.querySelector', { nodeId: docId, selector: sel })).nodeId;
const explain = await node('.ib[data-action="followup"]');
const answerBtn = await node('.ib[data-action="answer"]');
await bar.send('CSS.forcePseudoState', { nodeId: explain, forcedPseudoClasses: ['hover'] });
await sleep(120);
const midHover = await bar(`getComputedStyle(document.querySelector('.ib[data-action="followup"]')).transform`);
await sleep(600);
const hoverStyle = await bar(`(() => { const s = getComputedStyle(document.querySelector('.ib[data-action="followup"]')); const t = getComputedStyle(document.querySelector('.ib[data-action="followup"] .tip')); return { transform: s.transform, background: s.backgroundColor, tipOpacity: t.opacity, tipTransform: t.transform }; })()`);
await shotBar('bar-hover-followup-dark');
log(`hover Follow-ups: 120 ms in transform=${midHover}; settled ${JSON.stringify(hoverStyle)}`);
await bar.send('CSS.forcePseudoState', { nodeId: explain, forcedPseudoClasses: [] });
await bar.send('CSS.forcePseudoState', { nodeId: answerBtn, forcedPseudoClasses: ['hover', 'active'] });
await sleep(40);
const midPress = await bar(`getComputedStyle(document.querySelector('.ib[data-action="answer"]')).transform`);
await sleep(300);
const pressStyle = await bar(`(() => { const s = getComputedStyle(document.querySelector('.ib[data-action="answer"]')); return { transform: s.transform, background: s.backgroundColor, transition: s.transitionDuration + ' ' + s.transitionTimingFunction.slice(0, 40) }; })()`);
await shotBar('bar-pressed-answer-dark');
log(`press Answer: 40 ms in transform=${midPress}; held ${JSON.stringify(pressStyle)}`);
await bar.send('CSS.forcePseudoState', { nodeId: answerBtn, forcedPseudoClasses: [] });
await sleep(400);
const b0 = await bounds();
const zoom = (src, dst, r, k = 3) => ffmpeg('-i', join(OUT, src), '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${r.w * k}:${r.h * k}:flags=neighbor`, join(OUT, dst));
const rectOf = async (sel) => JSON.parse(await bar(`JSON.stringify(document.querySelector('${sel}').getBoundingClientRect())`));
for (const [sel, name] of [['.ib[data-action="followup"]', 'bar-hover-followup-dark'], ['.ib[data-action="answer"]', 'bar-pressed-answer-dark']]) {
  const r = await rectOf(sel);
  zoom(`${name}.png`, `${name}-zoom3x.png`, { x: Math.round(r.x + 60 - 70), y: Math.round(r.y + 40 - 20), w: 180, h: 90 });
}

// ---- 100, 125 and 150 %: the bar page at deviceScaleFactor 1, 1.25 and 1.5 (CDP emulation), laid over the backdrop
// behind it (grabbed with the bar hidden, scaled by the same factor), plus a 3x crop of the icon row at each.
await bar.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await M('bar.hide(); return 1;'); await sleep(400);
grab(join(OUT, 'tmp-behind.png'), { x: b0.x, y: b0.y, width: b0.width, height: b0.height });
grab(join(OUT, 'tmp-behind-tall.png'), { x: b0.x, y: b0.y, width: b0.width, height: 624 });
await M('bar.showInactive(); return 1;'); await sleep(400);
const acts = await rectOf('.bar-acts');
for (const s of [1, 1.25, 1.5]) {
  await bar.send('Emulation.setDeviceMetricsOverride', { width: b0.width, height: b0.height, deviceScaleFactor: s, mobile: false });
  await sleep(500);
  const { data } = await bar.send('Page.captureScreenshot', { format: 'png' });
  const hair = await bar("getComputedStyle(document.documentElement).getPropertyValue('--hair').trim()"); // read after a frame at this scale
  writeFileSync(join(OUT, 'tmp-bar.png'), Buffer.from(data, 'base64'));
  const name = `bar-scale-${s * 100}-dark.png`;
  ffmpeg('-i', join(OUT, 'tmp-behind.png'), '-i', join(OUT, 'tmp-bar.png'), '-filter_complex', `[0]scale=iw*${s}:ih*${s}:flags=bicubic[bg];[bg][1]overlay=0:0`, join(OUT, name));
  zoom(name, `bar-icons-${s * 100}-zoom3x.png`, { x: Math.round((acts.x - 6) * s), y: Math.round((acts.y - 6) * s), w: Math.round((acts.width + 12) * s), h: Math.round((acts.height + 12) * s) }, 3);
  log(`shot: ${name} and bar-icons-${s * 100}-zoom3x.png (deviceScaleFactor ${s}, ${Math.round(b0.width * s)}x${Math.round(b0.height * s)} px); --hair = ${hair}`);
  check(hair === { 1: '1px', 1.25: '.8px', 1.5: '.67px' }[s], `hairline at ${s * 100} % is one device pixel (${hair})`);
}
await bar.send('Emulation.clearDeviceMetricsOverride');

// ---- measurements: geometry, strokes, optical centres
const measure = await bar(`(() => {
  const cs = (sel, props) => { const el = document.querySelector(sel); if (!el) return sel + ': missing'; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return Object.assign({ sel, box: Math.round(r.width) + 'x' + Math.round(r.height) }, Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]))); };
  return [
    cs('body.bar-win', ['padding']),
    cs('.mini', ['border-radius', 'padding', 'background-image']),
    cs('.bar .logo', ['border-radius']),
    cs('.ib', ['border-radius', 'transition-duration', 'transition-timing-function']),
    cs('.mini .ask input', ['border-radius', 'height', 'background-color']),
    cs('.tip', ['border-radius', 'background-color', 'transition-duration', 'transition-delay']),
  ];
})()`);
for (const m of measure) log(`measure bar ${JSON.stringify(m)}`);
const logoCentre = await bar(`(() => { const m = document.querySelector('.mini').getBoundingClientRect(); const l = document.querySelector('.bar .logo').getBoundingClientRect(); return [l.left + l.width / 2 - m.left, l.top + l.height / 2 - m.top]; })()`);
check(logoCentre[0] === 26 && logoCentre[1] === 26, `bar logo centre from the slab corner ${JSON.stringify(logoCentre)} is the corner's centre (26, 26)`);
const strokes = async (t) => JSON.parse(await t(`JSON.stringify([...document.querySelectorAll('svg.i')].filter((s) => s.getBoundingClientRect().width && !s.closest('.logo, .tick') && getComputedStyle(s).fill === 'none').map((s) => { const c = getComputedStyle(s); return Math.round(parseFloat(c.width) * parseFloat(c.strokeWidth.replace('calc(', '')) / 24 * 100) / 100; }))`));
for (const [name, t] of [['bar', bar], ['main', page]]) {
  const px = await strokes(t);
  check(px.length && px.every((p) => Math.abs(p - 1.3) < 0.02), `${name}: every outline icon draws a 1.3 px stroke (${px.length} icons, ${[...new Set(px)].join(', ')} px)`);
}
const flag = await page("(() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.innerHTML = document.querySelector('#i-flag').innerHTML; document.body.append(s); const b = s.firstElementChild.getBBox(); s.remove(); return b.x + b.width / 2; })()");
check(Math.abs(flag - 12) < 0.01, `the flag glyph is centred on its 24 grid (centre x ${flag})`);

// ---- keyboard: arrows nudge only while the bar is focused; no global arrow shortcuts
log(`global Ctrl+Shift+Up/Down/Left/Right registered: ${await M("return ['Up', 'Down', 'Left', 'Right'].map((k) => globalShortcut.isRegistered('Ctrl+Shift+' + k)).join(', ');")}`);
await M("page.webContents.send('action', 'ask'); return 1;"); await sleep(500);
const p1 = await M('return JSON.stringify(bar.getPosition());');
for (const [key, shift] of [['ArrowRight', false], ['ArrowDown', true]]) {
  const k = { key, code: key, windowsVirtualKeyCode: { ArrowRight: 39, ArrowDown: 40 }[key], modifiers: shift ? 8 : 0 };
  await bar.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }); await bar.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  await sleep(200);
}
log(`nudge with the bar focused: ${p1} -> Right (8 px), Shift+Down (40 px) -> ${await M('return JSON.stringify(bar.getPosition());')}`);
await centreBar();
await bar('document.activeElement.blur(); 1');

// ================================================================= answers on the demo meeting
const ask = (q) => bar(`(() => { const f = document.querySelector('form.ask'); f.elements.q.value = ${JSON.stringify(q)}; f.requestSubmit(); return 1; })()`);
const barCard = () => bar("(() => { const a = document.querySelector('.mini-answer .answer'); return a ? JSON.stringify({ q: a.querySelector('.q').textContent, busy: a.getAttribute('aria-busy'), text: a.querySelector('.md').innerText.trim(), error: a.classList.contains('error'), quote: !!a.querySelector('.md blockquote') }) : 'null'; })()").then(JSON.parse);
// While a card streams, any raw markdown on screen (a ** or an unclosed [) is remembered: holdOpen should prevent it.
let rawSeen = '';
const watch = (c) => { if (c?.busy === 'true' && !rawSeen && /\*\*|\[[^\]]*$/.test(c.text)) rawSeen = c.text.slice(-60); return c; };
const finished = async () => { const c = watch(await barCard()); return c && c.busy === 'false'; };
const QUESTIONS = {
  dark: 'Omar wants a firm launch date for the board. Draft my reply in five short paragraphs: the date, what it depends on, the budget and launch spend, who owns support, and the plan for EU pricing.',
  // four paragraphs, not two: since the light morph is caught (and photographed) too, a two-paragraph answer could finish
  // during the streaming shot
  light: 'What exactly did Sarah say about launch spend? Quote her words as a markdown blockquote, then explain in four short paragraphs what it means for Thursday, for the budget, for support and for EU pricing.',
};
if (!QUICK) {
  for (const t of ['dark', 'light']) {
    await setTheme(t);
    const q = QUESTIONS[t];
    await ask(q);
    // Mid-morph: the morph is paused 14 % of the way through (the spring is 40 % open there), the bar page is captured with CDP and laid over the
    // backdrop that was behind it, then the morph plays on.
    const morph = await bar(`(() => {
      const m = document.querySelector('.mini'); const a = m.getAnimations().find((x) => x.animationName === 'morph');
      if (!a) return JSON.stringify({ running: false, class: m.className });
      a.pause(); a.currentTime = 0.14 * a.effect.getTiming().duration;
      return JSON.stringify({ running: true, at: a.currentTime + ' of ' + a.effect.getTiming().duration + ' ms', from: m.style.getPropertyValue('--from'), clip: getComputedStyle(m).clipPath, easing: getComputedStyle(m).animationTimingFunction.slice(0, 40) });
    })()`).then(JSON.parse);
    check(morph.running, `morph on open (${t}): ${JSON.stringify(morph)}`);
    if (morph.running) {
      await sleep(350);
      const { data } = await bar.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, 'tmp-bar.png'), Buffer.from(data, 'base64'));
      ffmpeg('-i', join(OUT, 'tmp-behind-tall.png'), '-i', join(OUT, 'tmp-bar.png'), '-filter_complex', '[0][1]overlay=0:0:shortest=0', join(OUT, `bar-morph-midframe-${t}.png`));
      log(`shot: bar-morph-midframe-${t}.png (clip ${morph.clip})`);
      await bar("document.querySelector('.mini').getAnimations().find((x) => x.animationName === 'morph')?.play(); 1");
    }
    const c0 = await barCard();
    check(c0 && c0.q === q, `the question on screen is the one asked (${t}): "${c0?.q.slice(0, 70)}..."`);
    const streaming = await until(async () => { const c = watch(await barCard()); return c && c.busy === 'true' && c.text.length > 60; }, 90000, 50);
    if (check(streaming, `a streamed answer appeared (${t})`)) {
      await shotBar(`bar-streaming-${t}`);
      const after = await barCard();
      check(after.busy === 'true', `bar-streaming-${t}.png was taken mid-stream: the card still says it is writing after the grab (${after.text.length} characters so far)`);
    }
    if (check(await until(finished, 120000), `the answer finished (${t})`)) {
      await sleep(500);
      await shotBar(`bar-answer-${t}`);
      const c = await barCard();
      check(!c.error && !/can(?:not|['’]t) see (?:a|the|any) transcript|no transcript/i.test(c.text), `the answer works from the transcript (${t}): "${c.text.replace(/\s+/g, ' ').slice(0, 160)}..."`);
      if (t === 'light') check(c.quote, 'the quote answer renders a blockquote');
      check(await page(`document.querySelector('#answers .answer.latest .q').textContent === ${JSON.stringify(q)}`), `the main window shows the same question (${t})`);
    }
  }
  // Answer, the main use: someone asked a question at the end of the transcript.
  await bar("document.querySelector('.ib[data-action=\"answer\"]').click(); 1");
  if (check(await until(finished, 120000), 'Answer finished')) {
    const c = await barCard();
    log(`Answer: "${c.text.replace(/\s+/g, ' ').slice(0, 220)}..."`);
    check(!/can(?:not|['’]t) see (?:a|the|any) transcript|no transcript/i.test(c.text), 'Answer works from the transcript');
    const when = await page("document.querySelector('#answers .answer.latest .when')?.textContent");
    check(/^\d{2}:\d{2}$/.test(when ?? ''), `answer times are meeting time, like the transcript and citations: "${when}"`);
  }
  check(!rawSeen, `no raw markdown marks (** or an open [) showed while streaming${rawSeen ? `: "${rawSeen}"` : ''}`);
  // Variant B, the capsule, with the answer open, in both themes (variant A, acrylic, is captured at the end)
  for (const t of ['dark', 'light']) { await setTheme(t); await shotBar(`bar-variant-capsule-${t}`); await opacityGate(`capsule, ${t}`); }
}

// ================================================================= screen sharing: nothing of Maverick in a capture
// Maverick hides from screen shares by default; the proof runs with MAVERICK_CAPTURE_VISIBLE=1 so its screenshots show
// the app, and lifts it here. Each leak is captured the way a share would see it, twice: a GDI screen copy and
// Electron's desktopCapturer at full size (the path Chromium-based meeting apps use). A region is grabbed with Maverick
// closed, then with the thing on screen, then closed again; a pixel counts when it differs by more than 10/255 from the
// first closed grab while the two closed grabs agree (a clock or a live window changing on its own is noise, logged).
// With hiding on, every leak must show under 1 % (0 is the aim); with hiding off, the control, it must show over the
// floor given. Full-screen grabs (a window in front, Task View, the taskbar) hold whatever else is open, so they stay in the temp profile.
// No real mouse or keyboard input anywhere: the hover is a CDP mouse event inside the page, Task View is opened and
// closed by the shell (Shell.Application.WindowSwitcher), and the window in front is raised with moveTop (SetWindowPos).
const CAP = join(PROFILE, 'capture');
mkdirSync(CAP, { recursive: true });
const hover = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
const PS_FG = 'Add-Type -Name F -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);\'; $c = New-Object System.Text.StringBuilder 256; [W.F]::GetClassName([W.F]::GetForegroundWindow(), $c, 256) | Out-Null;';
const TASK_VIEW = 'XamlExplorerHostIslandWindow'; // the foreground window's class while Task View is open
const foreground = () => ps(`${PS_FG} $c.ToString()`);
const dcGrab = (file, r) => M(`const { desktopCapturer } = process.mainModule.require('electron'); const d = screen.getPrimaryDisplay(); const f = d.scaleFactor;
  const [s] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * f), height: Math.round(d.bounds.height * f) } });
  const img = s.thumbnail.crop({ x: Math.round(${r.x} * f), y: Math.round(${r.y} * f), width: Math.round(${r.width} * f), height: Math.round(${r.height} * f) }).resize({ width: ${r.width}, height: ${r.height} });
  process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(file)}, img.toPNG()); return 1;`);
const px3 = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
function stable(c1, shown, c2) {
  let n = 0; let noise = 0;
  for (let i = 0; i < c1.length; i += 3) { if (px3(c1, c2, i) > 10) noise++; else if (px3(c1, shown, i) > 10) n++; }
  const all = c1.length / 3;
  return { pct: Math.round((n / all) * 10000) / 100, noise: Math.round((noise / all) * 10000) / 100 };
}
// hiding on or off through the saved setting's IPC path; MAVERICK_CAPTURE_VISIBLE decides what is applied
const hiding = async (on) => { await M(`process.env.MAVERICK_CAPTURE_VISIBLE = '${on ? '' : '1'}'; return 1;`); await page('window.maverick.saveSettings({}).then(() => 1)'); await sleep(500); };
const lift = (on) => M(on ? "page.setAlwaysOnTop(true, 'screen-saver'); page.showInactive(); page.moveTop(); return 1;" : 'page.setAlwaysOnTop(false); page.hide(); return 1;');
async function leak(name, rectOf, show, hide, grabWith) {
  await hide(); await sleep(600);
  const r = await rectOf();
  const dir = /front|wintab|taskbar/.test(name) ? CAP : OUT;
  const g = []; const d = [];
  const snap = async (k) => {
    const fg = join(dir, `cap-${name}-${k}-gdi.png`); const fd = join(dir, `cap-${name}-${k}-dc.png`);
    if (grabWith) await grabWith(fg, fd, r); else { grab(fg, r); await dcGrab(fd, r); } // Task View is open for every grab
    g.push(await raw(fg)); d.push(await raw(fd));
  };
  await snap('closed1'); await show(); await sleep(900); await snap('shown'); await hide(); await sleep(700); await snap('closed2');
  return { gdi: stable(g[0], g[1], g[2]), dc: stable(d[0], d[1], d[2]) };
}
const report = (what, on, off, floor = 20) => {
  const f = (x) => `GDI ${x.gdi.pct} % (noise ${x.gdi.noise} %), desktopCapturer ${x.dc.pct} % (noise ${x.dc.noise} %)`;
  check(on.gdi.pct < 1 && on.dc.pct < 1, `captureGate, hiding on, ${what}: ${f(on)}`);
  check(off.gdi.pct > floor || off.dc.pct > floor, `captureGate control, hiding off, ${what} shows: ${f(off)}`);
};

async function captureGate() {
  // the Settings switches, on by default
  await page("document.querySelector('#btn-settings').click(); 1"); await sleep(700);
  const sw = JSON.parse(await page("JSON.stringify({ share: document.querySelector('#set-hide-share').checked, tray: document.querySelector('#set-hide-tray').checked, trayOn: !document.querySelector('#set-hide-tray').disabled, note: document.querySelector('#hide-tray-note').textContent })"));
  check(sw.share && sw.tray && sw.trayOn, `Settings: "Hide Maverick when I share my screen" and "Also hide the tray icon" are on by default; the note: "${sw.note}"`);
  check(/Ctrl Shift Enter brings the bar back/.test(sw.note), 'Settings says, in one line, which key brings the bar back without the tray icon');
  await page("document.querySelector('#dlg-settings').close(); 1"); await sleep(300);
  const d = JSON.parse(await M('const d = screen.getPrimaryDisplay(); return JSON.stringify({ b: d.bounds, wa: d.workArea });'));
  const res = {};
  for (const on of [true, false]) {
    await hiding(on);
    const k = on ? 'on' : 'off';
    const state = await M("const t = global.maverickDesk.tray(); return JSON.stringify({ protected: [page, bar].map((w) => w.isContentProtected?.()), skipTaskbar: page.isSkipTaskbar?.() ?? 'n/a', tray: !!t && !t.isDestroyed() });").catch((e) => e.message);
    log(`captureGate, hiding ${k}: ${state}`);
    const r = res[k] = {};
    // 1. the bar
    r.bar = await leak(`bar-${k}`, bounds, () => M('bar.showInactive(); return 1;'), () => M('bar.hide(); return 1;'));
    // 2. a dropdown open in Settings (an in-page list now; a native one would be its own window)
    let open = false;
    r.select = await leak(`select-${k}`, async () => JSON.parse(await M('return JSON.stringify(page.getContentBounds());')), async () => {
      await lift(true);
      await page("(() => { const d = document.querySelector('#dlg-settings'); if (!d.open) document.querySelector('#btn-settings').click(); return 1; })()"); await sleep(500);
      await page("document.querySelector('#set-answer-lang').focus(); 1");
      for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined });
      await sleep(400);
      open = await page("document.querySelector('#set-answer-lang').matches(':open')");
    }, async () => { await page("document.querySelector('#set-answer-lang').blur(); 1"); await lift(false); });
    check(open, `the Settings dropdown was open for the capture (hiding ${k})`);
    await page("document.querySelector('#dlg-settings').close(); 1"); await sleep(300);
    // 3. a tooltip, hovered until it shows
    let tipShown = false;
    r.tip = await leak(`tooltip-${k}`, async () => JSON.parse(await M('return JSON.stringify(page.getContentBounds());')), async () => {
      await lift(true); await sleep(300);
      const b = JSON.parse(await page("JSON.stringify(document.querySelector('#btn-history').getBoundingClientRect())"));
      await hover(b.x + b.width / 2, b.y + b.height / 2); await sleep(1100);
      tipShown = await page("(() => { const t = document.querySelector('.float-tip'); return t?.matches(':popover-open') ? t.textContent : ''; })()");
    }, async () => { await hover(2, await page('innerHeight - 2')); await lift(false); }); // off the button, so the next hover is a new one
    check(!!tipShown, `the in-page tooltip was showing for the capture (hiding ${k}): "${tipShown}"`);
    // 4. the tray menu (the protected in-app one)
    await M('await global.maverickDesk.openMenu(); return 1;'); await sleep(500);
    const mb = JSON.parse(await M("const m = global.maverickDesk.menu(); const b = m.getBounds(); m.hide(); return JSON.stringify(b);"));
    const pad = (b) => ({ x: b.x - 16, y: b.y - 16, width: b.width + 32, height: b.height + 32 });
    r.menu = await leak(`traymenu-${k}`, async () => pad(mb), () => M('if (!global.maverickDesk.menuShown()) await global.maverickDesk.openMenu(); return 1;'), () => M('global.maverickDesk.menu()?.hide(); return 1;'));
    if (!on) { // the menu's edge, 3x: no accent-coloured border (the window is made with it removed, as the acrylic bar)
      await M('if (!global.maverickDesk.menuShown()) await global.maverickDesk.openMenu(); return 1;'); await sleep(500);
      const e = { x: mb.x - 10, y: mb.y - 10, width: 90, height: 60 };
      grab(join(OUT, 'tmp-bar.png'), e);
      ffmpeg('-i', join(OUT, 'tmp-bar.png'), '-vf', 'scale=270:180:flags=neighbor', join(OUT, 'cap-traymenu-edge-zoom3x.png'));
      const px = await raw(join(OUT, 'tmp-bar.png'));
      const edge = [...Array(90 * 60).keys()].map((i) => i * 3); // the whole corner: window edge, panel edge and inside
      const blue = edge.filter((i) => px[i + 2] > 150 && px[i + 1] > 60 && px[i + 2] - px[i] > 100).length;
      check(blue === 0, `tray menu: no accent border (${blue} of ${edge.length} pixels in its top-left corner are accent blue; 3x crop: cap-traymenu-edge-zoom3x.png)`);
      await M('global.maverickDesk.menu()?.hide(); return 1;');
    }
    // 5. the whole screen with the main window and the bar up, as in a meeting: another window raised in front over half
    // the bar, then Task View open (the focus moves to the shell). The Alt+Tab switcher only opens from a held Alt key.
    const full = { x: d.b.x, y: d.b.y, width: d.b.width, height: d.b.height };
    const up = () => M('page.showInactive(); bar.showInactive(); return 1;');
    const down = () => M('page.hide(); bar.hide(); return 1;');
    if (on) log('skipped: Alt+Tab held: the switcher only opens from a held Alt key, which needs real keyboard input; Task View and a window in front stand in for it');
    // the window in front is there for all three grabs; only Maverick comes and goes under it
    await M("const b = bar.getBounds(); const f = new BrowserWindow({ x: b.x - 40, y: b.y - 20, width: Math.round(b.width / 2) + 40, height: b.height + 200, frame: false, show: false, focusable: false, skipTaskbar: true, backgroundColor: '#2a6f3a', title: 'proof front' }); f.setAlwaysOnTop(true, 'screen-saver'); f.showInactive(); global.proofFront = f; return 1;");
    r.front = await leak(`front-${k}`, async () => full, async () => { await up(); await M('global.proofFront.moveTop(); return 1;'); }, down);
    await M('global.proofFront.destroy(); delete global.proofFront; return 1;');
    let tvOpen = 0;
    const openTaskView = async () => {
      ps('(New-Object -ComObject Shell.Application).WindowSwitcher()'); // opens Task View; a second call closes it
      const open = !!await until(async () => foreground() === TASK_VIEW, 4000, 200);
      if (open) { tvOpen++; await sleep(1200); } // the open animation
      return open;
    };
    const closeTaskView = async () => { if (foreground() === TASK_VIEW) ps('(New-Object -ComObject Shell.Application).WindowSwitcher()'); await sleep(900); };
    // The shell opens Task View only while this process tree may take the foreground; with another app in front it does nothing.
    if (await openTaskView()) {
      await closeTaskView(); tvOpen = 0;
      r.wintab = await leak(`wintab-${k}`, async () => full, up, down, async (fg, fd, rr) => { await openTaskView(); grab(fg, rr); await dcGrab(fd, rr); await closeTaskView(); });
      check(tvOpen === 3, `Task View was open for all three grabs (hiding ${k}): ${tvOpen} of 3`);
    } else log(`skipped: Task View (hiding ${k}): Shell.Application.WindowSwitcher did not open it (foreground: ${foreground()}); the shell opens it only for the app in front, and without real input this run cannot be that app`);
    // 6. the taskbar with the notification area, Maverick up versus closed (no windows, no tray icon)
    const band = { x: d.b.x, y: d.wa.y + d.wa.height, width: d.b.width, height: d.b.y + d.b.height - (d.wa.y + d.wa.height) };
    if (band.height > 0) {
      r.taskbar = await leak(`taskbar-${k}`, async () => band, async () => { await page('window.maverick.saveSettings({}).then(() => 1)'); await up(); },
        async () => { await down(); await M('global.maverickDesk.dropTray(); return 1;'); });
      await page('window.maverick.saveSettings({}).then(() => 1)');
    }
    await M('bar.showInactive(); return 1;');
  }
  await hiding(false); // the proof's own screenshots go on with the app visible (the saved setting stays on)
  report('the bar', res.on.bar, res.off.bar);
  report('an open Settings dropdown', res.on.select, res.off.select);
  report('a hovered tooltip', res.on.tip, res.off.tip);
  report('the tray menu', res.on.menu, res.off.menu, 5); // a light menu over the white backdrop: the text and edge differ
  report('another window in front of the bar', res.on.front, res.off.front, 0.5);
  if (res.on.wintab && res.off.wintab) report('Task View (opened by the shell, the focus on it)', res.on.wintab, res.off.wintab, 0.5);
  if (res.on.taskbar) report('the taskbar and notification area', res.on.taskbar, res.off.taskbar, 0.2);
  else log('captureGate: no taskbar band on the primary display (auto-hide or on another edge), not measured');
  log(`captureGate grabs: shots/glass/cap-*.png; the full-screen ones (window in front, Task View, taskbar) stay in ${CAP}`);
}
await captureGate();

// ================================================================= main window, Settings, History
for (const t of ['dark', 'light']) {
  await setTheme(t);
  await shotMain(`main-${t}`);
  await page("document.querySelector('#btn-settings').click(); 1"); await sleep(700);
  if (t === 'dark') {
    check(await page("document.activeElement?.id === 'set-title'"), `Settings opens with focus on its heading, not on Close (active: ${await page('document.activeElement?.id || document.activeElement?.tagName')})`);
    const sel = await page("(() => { const s = document.querySelector('#set-answer-lang'); return JSON.stringify({ text: s.selectedOptions[0].text, fits: s.scrollWidth <= s.clientWidth }); })()");
    check(JSON.parse(sel).fits, `Answer language shows in full: ${sel}`);
    const foot = await page("[...document.querySelectorAll('#dlg-settings button')].filter((b) => /close|cancel|done|save/i.test(b.textContent + (b.getAttribute('aria-label') || ''))).map((b) => b.textContent.trim() || b.getAttribute('aria-label')).join(', ')");
    check(foot === 'Done', `Settings applies changes as they are made and has one button to leave: ${foot}`);
  }
  await shotMain(`settings-${t}`);
  await dialogGate(`Settings, ${t}`, '#dlg-settings');
  if (t === 'dark') {
    // Scrolled to the end, the last note clears the footer's fade: its bottom sits above where the fade starts.
    const end = JSON.parse(await page("(() => { const b = document.querySelector('#dlg-settings .dlg-body'); b.scrollTop = b.scrollHeight; const r = b.getBoundingClientRect(); const last = [...b.querySelectorAll('.foot')].filter((p) => p.offsetParent).pop().getBoundingClientRect(); return JSON.stringify({ lastBottom: Math.round(last.bottom), fadeTop: Math.round(r.bottom - 24), mask: getComputedStyle(b).maskImage.slice(0, 60) }); })()"));
    check(end.lastBottom <= end.fadeTop, `Settings scrolled to the end: the last note ends at ${end.lastBottom}, above the 24 px fade at ${end.fadeTop} (${end.mask})`);
    await shotMain('settings-end-dark');
    await page("document.querySelector('#dlg-settings .dlg-body').scrollTop = 0; 1");
  }
  await page("document.querySelector('#dlg-settings').close(); 1"); await sleep(300);
  await page("document.querySelector('#btn-history').click(); 1"); await sleep(700);
  check(await page("document.querySelector('.history').classList.contains('none') && getComputedStyle(document.querySelector('.hist-empty')).display !== 'none'"), `History with no meetings shows one empty state (${t})`);
  await shotMain(`history-empty-${t}`);
  await dialogGate(`History, ${t}`, '#dlg-history');
  await page("document.querySelector('#dlg-history').close(); 1"); await sleep(300);
}
await setTheme('dark');

// ---- Windows flips light and dark while Maverick follows it (emulated): the page crossfades from the old theme.
// The flip is the pages' prefers-color-scheme (CDP) plus Electron's theme, which is what turns the Mica material.
// Animations run 33 times slower so a screen grab can land in the middle of the 280 ms crossfade.
await setTheme('');
const osFlip = async (v) => { await M(`nativeTheme.themeSource = '${v}'; return 1;`); for (const t of [page, bar]) await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: v }] }); };
await osFlip('dark');
await sleep(900);
await M("bar.hide(); page.setAlwaysOnTop(true, 'screen-saver'); page.moveTop(); page.focus(); return 1;"); await sleep(500);
await page.send('Animation.enable'); await page.send('Animation.setPlaybackRate', { playbackRate: 0.03 });
await osFlip('light');
await sleep(1500); // 45 ms into the crossfade, slowed 33x; the grab itself takes about a second more
const vt = await page("JSON.stringify(document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith('::view-transition')).map((a) => a.effect.pseudoElement + ' ' + Math.round(a.currentTime) + ' ms'))");
check(JSON.parse(vt).length > 0, `OS flip crossfades: view-transition animations running ${vt}`);
grab(join(OUT, 'os-flip-midframe.png'), JSON.parse(await M('return JSON.stringify(page.getContentBounds());')));
log(`shot: os-flip-midframe.png (the crossfade from dark to light, slowed 33x; after the grab it is at ${await page("Math.round(document.getAnimations().find((a) => a.effect?.pseudoElement === '::view-transition-new(root)')?.currentTime ?? -1)")} ms of 280)`);
await page.send('Animation.setPlaybackRate', { playbackRate: 1 });
await sleep(1200);
grab(join(OUT, 'os-flip-after.png'), JSON.parse(await M('return JSON.stringify(page.getContentBounds());')));
log(`shot: os-flip-after.png (theme now ${await page("getComputedStyle(document.body).color")})`);
await M('page.setAlwaysOnTop(false); bar.showInactive(); return 1;');
await motionOn();
await setTheme('dark');

// ---- detail checks in the main window
const mainMeasure = await page(`(() => {
  const cs = (sel, props) => { const el = document.querySelector(sel); if (!el) return sel + ': missing'; const s = getComputedStyle(el); return Object.assign({ sel }, Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]))); };
  return [cs('body', ['background-color']), cs('.copilot', ['border-radius', 'padding', 'background-color']), cs('.actions', ['border-radius', 'padding', 'background-color']),
    cs('.act', ['border-radius', 'height', 'transition-property', 'transition-duration']), cs('.btn', ['border-radius', 'height', 'transition-property']), cs('.controls', ['border-radius', 'padding']),
    cs('.status', ['font-size', 'color']), cs('.ask input', ['border-radius', 'height']), cs('.dlg', ['border-radius']), cs('.group', ['border-radius']),
    cs('.answer.latest', ['border-radius', 'padding']), cs('.md blockquote', ['border-left-width', 'border-radius', 'background-color', 'box-shadow'])];
})()`);
for (const m of mainMeasure) log(`measure main ${JSON.stringify(m)}`);
check(await page("[...document.styleSheets].every((s) => [...s.cssRules].every((r) => !/transition[^;]*box-shadow/.test(r.cssText)))"), 'no transition animates box-shadow (lifts fade a ::after shadow instead)');
// no layout shift: the checking ring against the dot, and a banner appearing mid-meeting
const shift = await page(`(async () => {
  const ai = document.querySelector('#st-ai'); const x0 = ai.getBoundingClientRect().x; const cls = ai.className;
  ai.className = 'pill busy'; const x1 = ai.getBoundingClientRect().x; ai.className = cls;
  const tr = document.querySelector('.transcript-card').getBoundingClientRect().y;
  const b = Object.assign(document.createElement('div'), { className: 'banner', textContent: 'Test banner' }); document.querySelector('#banners').append(b);
  const tr2 = document.querySelector('.transcript-card').getBoundingClientRect().y; b.remove();
  return JSON.stringify({ statusMoves: x1 - x0, transcriptMoves: tr2 - tr });
})()`);
check(JSON.parse(shift).statusMoves === 0 && JSON.parse(shift).transcriptMoves === 0, `no layout shift from the checking ring or a new banner: ${shift}`);
// focus rings: the glow on a citation, the transcript's rounded ring
await page.send('DOM.enable'); await page.send('CSS.enable');
const pdoc = (await page.send('DOM.getDocument')).root.nodeId;
for (const sel of ['.answer .cite', '#transcript']) {
  const id = (await page.send('DOM.querySelector', { nodeId: pdoc, selector: sel })).nodeId;
  if (!id) { log(`focus ring ${sel}: not on screen`); continue; }
  await page.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['focus', 'focus-visible'] });
  log(`focus ring ${sel}: ${await page(`(() => { const s = getComputedStyle(document.querySelector('${sel}')); return s.outlineStyle + ' ' + s.outlineOffset + ', radius ' + s.borderRadius + ', glow ' + (s.boxShadow.includes('0px 0px 0px 4px') ? 'yes' : 'no'); })()`)}`);
  await page.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
}
// scrollbars fade in while scrolling: the registered --sb colour transitions, and the thumb's pixels follow it
const tr = JSON.parse(await page("JSON.stringify(document.querySelector('#transcript').getBoundingClientRect())"));
const strip = async () => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: tr.right - 8, y: tr.top, width: 8, height: tr.height, scale: 1 } });
  writeFileSync(join(OUT, 'tmp-bar.png'), Buffer.from(data, 'base64'));
  // over black: the glass card is near-transparent white, which reads bright when alpha is dropped
  const px = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(OUT, 'tmp-bar.png'), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { windowsHide: true });
  let max = 0;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, Math.round((Math.max(px[i], px[i + 1], px[i + 2]) * px[i + 3]) / 255));
  return max;
};
const lit = [await strip()];
await page("document.querySelector('#transcript').classList.add('scrolling'); 1");
await sleep(60); lit.push(await strip()); await sleep(400); lit.push(await strip());
const sb = await page("getComputedStyle(document.querySelector('#transcript')).getPropertyValue('--sb')");
await page("document.querySelector('#transcript').classList.remove('scrolling'); 1");
check(lit[2] > lit[0], `the transcript scrollbar thumb is drawn while scrolling: brightest pixel in its strip ${lit.join(' -> ')} (0, 60, 460 ms), --sb ${sb}`);
// reduced motion: everything stops except the Think harder fill, which runs linear from where it was
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const rm = await page(`(async () => {
  const p = Object.assign(document.createElement('span'), { className: 'deep-prog' }); p.append(document.createElement('i')); document.querySelector('#answers').prepend(p);
  p.firstElementChild.style.setProperty('animation-delay', '-20000ms', 'important');
  await new Promise((r) => setTimeout(r, 300));
  const s = getComputedStyle(p.firstElementChild); const w = p.getBoundingClientRect().width; const x = p.firstElementChild.getBoundingClientRect().right - p.getBoundingClientRect().left;
  const r = { fill: s.animationName + ' ' + s.animationDuration + ' ' + s.animationTimingFunction, filledAt20s: Math.round(x / w * 100) + '%', buttonTransition: getComputedStyle(document.querySelector('.btn')).transitionDuration };
  p.remove();
  return JSON.stringify(r);
})()`);
check(JSON.parse(rm).filledAt20s !== '96%' && JSON.parse(rm).filledAt20s !== '0%', `reduced motion: Think harder still fills, from where it was: ${rm}`);
await motionOn();

// ---- Think harder, mid-progress: the fill slides in with translateX inside its clipping track
if (NO_DEEP) log('skipped: Think harder mid-progress: PROOF_NO_DEEP is set, so no deep model is loaded');
else if (!QUICK) {
  await setTheme('dark');
  await bar("document.querySelector('.ib[data-cmd=\"think\"]').click(); 1");
  const prog = await until(() => bar("!!document.querySelector('.mini-answer .deep-prog')"), 10000, 100);
  if (check(prog, 'Think harder shows its progress bar')) {
    await sleep(7000);
    await shotBar('bar-think-harder-dark');
    const fill = JSON.parse(await bar(`(() => { const p = document.querySelector('.mini-answer .deep-prog'); const i = p.firstElementChild; const m = new DOMMatrix(getComputedStyle(i).transform); return JSON.stringify({ filled: Math.round((1 + m.m41 / p.getBoundingClientRect().width) * 100), transform: getComputedStyle(i).transform, rightEndRadius: getComputedStyle(i).borderTopRightRadius, text: document.querySelector('.mini-answer .deep-wait')?.textContent }); })()`));
    check(fill.filled > 2 && fill.filled < 96, `bar-think-harder-dark.png: the fill is ${fill.filled} % in after 7 s, moved by ${fill.transform}, its end still round (${fill.rightEndRadius})`);
    await bar("document.querySelector('.mini-answer [data-cmd=\"stop\"]')?.click(); 1");
    await sleep(1500);
  }
}

// ---- the smallest first launch: a 1366 x 768 laptop at 125 % gives about 984 x 540
const big = await M('return JSON.stringify(page.getBounds());');
await M('page.setBounds({ width: 984, height: 540 }); return 1;'); await sleep(600);
await shotMain('main-small-dark');
check(await page('document.documentElement.scrollWidth <= innerWidth'), `984 x 540: nothing overflows sideways (${await page('innerWidth + "x" + innerHeight')})`);
await M(`page.setBounds(${big}); return 1;`); await sleep(400);

// ---- web at 390 px (no preload, its own storage partition, so this is a fresh browser build)
await M(`const w = new BrowserWindow({ width: 390, height: 844, show: false, title: 'web390', useContentSize: true, webPreferences: { offscreen: true, partition: 'maverick-proof-web' } }); w.webContents.setFrameRate(30); await w.loadURL('http://127.0.0.1:${port}/'); await new Promise((r) => setTimeout(r, 1500)); const img = await w.webContents.capturePage(); process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(join(OUT, 'web-390.png'))}, img.toPNG()); const o = await w.webContents.executeJavaScript('JSON.stringify({ inner: innerWidth, scroll: document.documentElement.scrollWidth, desk: !!window.maverick, thumb: getComputedStyle(document.documentElement).getPropertyValue("--sb"), segmentsClip: [...document.querySelectorAll(".act")].some((a) => a.scrollWidth > a.clientWidth) })'); globalThis.__web = o; w.destroy(); return o;`);
log(`web 390: ${await M('return globalThis.__web;')}`);
check(!JSON.parse(await M('return globalThis.__web;')).segmentsClip, 'web 390: no segment label is clipped (icons only below 480 px)');
// the browser pop-out (Document Picture-in-Picture), previewed in a 400 x 560 tab with #mini
await M(`const w = new BrowserWindow({ width: 400, height: 380, show: false, title: 'web390', useContentSize: true, webPreferences: { offscreen: true, partition: 'maverick-proof-web' } }); w.webContents.setFrameRate(30); await w.loadURL('http://127.0.0.1:${port}/#mini'); await new Promise((r) => setTimeout(r, 1500)); const img = await w.webContents.capturePage(); process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(join(OUT, 'web-popout.png'))}, img.toPNG()); w.destroy(); return 1;`);
log('shot: web-popout.png (the browser pop-out at 400 x 380, the size it now opens at)');
{ // the web version cannot hide itself: Settings says so and shows no hide switch
  const web = JSON.parse(await M(`const w = new BrowserWindow({ width: 900, height: 700, show: false, title: 'web390 settings', webPreferences: { offscreen: true, partition: 'maverick-proof-web' } }); await w.loadURL('http://127.0.0.1:${port}/'); await new Promise((r) => setTimeout(r, 1200));
    const out = await w.webContents.executeJavaScript("document.querySelector('#btn-settings').click(); document.querySelector('#tab-connections').click(); new Promise((r) => setTimeout(() => r(JSON.stringify({ note: document.querySelector('#web-share-note').checkVisibility() ? document.querySelector('#web-share-note').textContent : '', toggle: document.querySelector('#set-hide-share').checkVisibility() })), 500))"); w.destroy(); return out;`));
  check(/cannot hide itself from screen shares/.test(web.note) && !web.toggle, `web Settings: no hide switch (${web.toggle}), and it says: "${web.note}"`);
}

// ---- Variant A: the acrylic bar. The bar window is rebuilt with Windows 11 acrylic (MAVERICK_BAR), the page reloads
// with the same demo meeting, and a short answer is asked so it is seen open, in both themes.
if (!QUICK) {
  await M("process.env.MAVERICK_BAR = 'acrylic'; return 1;");
  await reloadWith(DEMO_FAKE);
  await page("document.querySelector('.banner[data-key=\"recover\"] [data-dismiss]')?.click(); 1");
  check(await bar("document.body.classList.contains('acrylic')") && (await bounds()).width === 760, `acrylic bar: the window is the slab (${JSON.stringify(await bounds())})`);
  await ask('When can we launch, and what does it depend on?');
  if (check(await until(finished, 120000), 'acrylic bar: the answer finished')) {
    await sleep(500);
    for (const t of ['light', 'dark']) { await setTheme(t); await shotBar(`bar-variant-acrylic-${t}`); await opacityGate(`acrylic, ${t}`); }
    // the window edge, 3x: no accent-coloured border around the acrylic bar
    const e = await bounds();
    grab(join(OUT, 'tmp-bar.png'), { x: e.x - 12, y: e.y - 12, width: 90, height: 60 });
    ffmpeg('-i', join(OUT, 'tmp-bar.png'), '-vf', 'scale=270:180:flags=neighbor', join(OUT, 'bar-variant-acrylic-edge-zoom3x.png'));
    const edge = await raw(join(OUT, 'tmp-bar.png'));
    // the window's own first row and first column (12 px into the crop), past the rounded corner: accent blue is about (0, 120, 212)
    const line = [...[...Array(70).keys()].map((x) => (12 * 90 + 20 + x) * 3), ...[...Array(40).keys()].map((y) => ((20 + y) * 90 + 12) * 3)];
    const blue = line.filter((i) => edge[i + 2] > 150 && edge[i + 1] > 60 && edge[i + 2] - edge[i] > 100).length;
    check(blue === 0, `acrylic bar: no accent border on its edge (${blue} of ${line.length} edge pixels are accent blue; 3x crop: bar-variant-acrylic-edge-zoom3x.png)`);
  }
  await M("process.env.MAVERICK_BAR = 'capsule'; return 1;");
}

// ---- restore, console errors, quit. Nothing was saved: the shim kept the demo meeting and the theme in memory.
await M(`bar.setPosition(...${oldPos}); nativeTheme.themeSource = 'system'; return 1;`);
const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await M('app.quit(); return 1;').catch(() => {});
backdrop.kill();
await sleep(1500);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nall checks passed');
finish();
if (fails.length) console.error(`\nglass-proof FAILED ${fails.length} check(s)`);
process.exit(exitCode);
