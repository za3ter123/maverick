// node test/recording-proof.mjs   (Windows; ffprobe on PATH)
// Proves session recording end to end in the real desktop app on a temp profile (MAVERICK_USER_DATA), driven through the
// page the way feature-proof.mjs does it (MAVERICK_TEST_HOOKS adds transcript lines; buttons are clicked in the page):
//   1. Audio only: Settings set to Audio only and a temp folder; Share meeting starts the meeting and the recording; End &
//      summarize stops it after 10 s. The file is in the chosen folder; ffprobe finds exactly one stream, audio, and a
//      duration of 8 s or more.
//   2. Audio + screen: a window made here is picked from the in-app list in Settings. 10 s; ffprobe finds a video and an
//      audio stream. Halfway, the main window is hidden and another window takes the focus; the file must keep growing.
//   3. History: the meeting shows a player; clicking a transcript time seeks it there (within 1 s).
//   4. Edge cases: no window picked, the picked window gone, a folder that cannot be made, Off; and a crash: the app is
//      killed mid-recording (Audio + screen) and the file on disk still reads, with the audio up to the kill and a
//      finite duration (acceptance defect 5: an Audio + screen file that was not stopped cleanly had none).
//   Acceptance defect 10: the in-app window list leaves out Maverick's own windows.
//   Acceptance 2, B and G: a recording whose first chunk is 1 byte still gets a finite duration; a recording or a meeting
//      that got no byte leaves no empty .webm and no History player.
//   One app's sound (desktop/app-audio.exe): two PowerShell windows play 440 Hz (A) and 1000 Hz (B) from two processes.
//      a. Audio + screen of window A while the entire screen is shared (system sound, both tones): the file has A, not B.
//      b. Audio only while window A is shared: the meeting tap, which transcription reads too, has A, not B.
//      c. Fallback: Audio + screen of a silent window C (no audio session): a notice says so and the file has both tones.
//      Each tone is measured in the saved file by ffmpeg decode and a Goertzel filter (dBFS, from 2 s in).
//   5. The user's real profile (%APPDATA%\maverick) is byte-identical afterwards.
// Prints "recording proof passed" only when every check passed; otherwise exits 1.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const check = (ok, what) => { if (ok) log(`ok: ${what}`); else { log(`FAIL: ${what}`); fails.push(what); } return ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
// The foreground window: its process id, process name and title (read only; nothing here moves the focus).
const foreground = () => JSON.parse(ps('Add-Type -Name F -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); '
  + '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); '
  + '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);\'; '
  + '$h = [W.F]::GetForegroundWindow(); $p = [uint32]0; [W.F]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; $s = New-Object System.Text.StringBuilder 256; [W.F]::GetWindowText($h, $s, 256) | Out-Null; '
  + '[pscustomobject]@{ pid = [int]$p; name = [string](Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; title = $s.ToString() } | ConvertTo-Json -Compress'));
// Every process of the Maverick this proof started: its main process and everything under it.
// `except`: a process started under it that is not Maverick (the proof's focus window), left out with its own children.
const maverickPids = (root, except) => {
  const rows = JSON.parse(ps('Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress'));
  const pids = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (pids.has(r.ParentProcessId) && !pids.has(r.ProcessId) && r.ProcessId !== except) { pids.add(r.ProcessId); grew = true; } }
  return pids;
};

// ---- ffprobe
let ffprobe = '';
try { ffprobe = execFileSync('where', ['ffprobe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { /* missing */ }
if (!check(!!ffprobe, `ffprobe is installed: ${ffprobe || 'not found on PATH'}`)) {
  log('\nFAILED: ffprobe is needed to read the recordings. Nothing was installed.');
  process.exit(1);
}
const probe = (file) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));

// ---- the real profile: every file, now and at the end
const REAL = join(process.env.APPDATA || '', 'maverick');
const fingerprint = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = join(e.parentPath ?? e.path, e.name); return `${f.slice(dir.length)} ${createHash('sha256').update(readFileSync(f)).digest('hex')}`; }).sort().join('\n') : 'absent');
const realBefore = fingerprint(REAL);

const PROFILE = mkdtempSync(join(tmpdir(), 'maverick-recording-'));
const app = spawn(electron, ['.', '--force-device-scale-factor=1', '--remote-debugging-port=9336', '--inspect=9232'], {
  cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: PROFILE, MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
});
const out = [];
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
const finish = (code) => { writeFileSync(join(OUT, 'recording-proof-log.txt'), `${lines.join('\n')}\n`); process.exit(code); };
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
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9336/json/list')).json(); } catch { return []; } };
const target = async (pick) => { const t = await until(async () => (await targets()).find(pick), 20000); if (!t) throw new Error('no debug target'); return t; };
const main = await cdp((await until(async () => { try { return (await (await fetch('http://127.0.0.1:9232/json/list')).json())[0]; } catch { return null; } }, 20000)).webSocketDebuggerUrl);
const M = (body) => main(`(async () => { const { app, BrowserWindow, screen } = process.mainModule.require('electron'); const W = BrowserWindow.getAllWindows(); const page = W.find((w) => w.getTitle().startsWith('Maverick,')); ${body} })()`);
const page = await cdp((await target((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))).webSocketDebuggerUrl);
await until(() => page("!!document.querySelector('#st-ai') && !!window.maverickTest"), 20000);
check((await M("return app.getPath('userData');")).toLowerCase() === PROFILE.toLowerCase(), `the app runs in the temp profile ${PROFILE}`);

// ---- helpers
const webms = (dir) => readdirSync(dir).filter((f) => f.endsWith('.webm')).map((f) => join(dir, f));
const settingsUi = async () => {
  await page("document.querySelector('#btn-settings').click(); 1");
  const ui = await until(() => page("(() => { const o = [...document.querySelectorAll('#set-record-source option')].map((x) => x.textContent); return o.length > 1 ? JSON.stringify({ mode: document.querySelector('#set-record').value, source: document.querySelector('#set-record-source').value, sourceOff: document.querySelector('#set-record-source').disabled, dir: document.querySelector('#record-dir-note').textContent, options: o }) : ''; })()"), 10000);
  await page("document.querySelector('#dlg-settings').close(); 1");
  await sleep(300);
  return JSON.parse(ui || '{}');
};
const historyMeetings = () => page("localStorage.getItem('maverick.meetings') || '[]'").then(JSON.parse);
// One meeting: Share meeting, two transcript lines, `during` (may hide the window and move the focus), End & summarize.
async function meeting(name, during) {
  const before = (await historyMeetings()).length;
  await page("document.querySelector('#btn-share').click(); 1");
  const shared = await until(() => page("(document.querySelector('#preview').videoWidth || 0) > 0"), 15000);
  check(shared, `${name}: Share meeting started the meeting`);
  const t0 = Date.now();
  await sleep(3000);
  await page("window.maverickTest.addLine('Speaker 1', 'The first proof line, three seconds in.')");
  await sleep(3000);
  await page("window.maverickTest.addLine('Speaker 2', 'The second proof line, six seconds in.')");
  await during?.(t0);
  await sleep(Math.max(0, 10500 - (Date.now() - t0)));
  await M('page.showInactive(); return 1;'); // shown again without taking the foreground from whoever has it
  await page("document.querySelector('#btn-end').click(); 1");
  const saved = await until(async () => { const h = await historyMeetings(); return h.length > before && 'summary' in h.at(-1) ? h.at(-1) : null; /* saved at the press, then with its notes */ }, 300000, 1000);
  check(saved?.recording?.file, `${name}: End & summarize saved the meeting to History with its recording: ${JSON.stringify(saved?.recording)}`);
  await page("document.querySelector('#dlg-summary').close(); 1");
  return saved;
}

// ================================================================= 1. Audio only, into a chosen folder
const DIR_A = mkdtempSync(join(tmpdir(), 'maverick-rec-audio-'));
await page(`window.maverick.saveSettings({ recordMode: 'audio', recordDir: ${JSON.stringify(DIR_A)} }).then(() => 1)`);
let ui = await settingsUi();
check(ui.mode === 'audio' && ui.dir === DIR_A && ui.sourceOff, `Settings shows Record meetings: Audio only, the chosen folder ${ui.dir}, and the picture list switched off`);
const mA = await meeting('audio only');
const filesA = webms(DIR_A);
check(filesA.length === 1 && mA?.recording?.file === filesA[0], `audio only: one recording in the chosen folder: ${filesA.join(', ')}`);
if (filesA[0]) {
  const p = probe(filesA[0]);
  log(`ffprobe ${filesA[0]}: ${JSON.stringify(p)}`);
  check(p.streams.length === 1 && p.streams[0].codec_type === 'audio', `audio only: ffprobe finds exactly one stream, audio (${p.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(', ')})`);
  check(Number(p.format.duration) >= 8, `audio only: duration ${p.format.duration} s, 8 s or more`);
}

// ================================================================= 2. Audio + screen, a window picked in Settings
const TARGET = 'Recording proof target';
const FOCUS = 'Recording proof focus';
const page2 = (title, bg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;background:${bg};color:#fff;font:48px Segoe UI,sans-serif;display:grid;place-items:center;height:100vh"><div id="c">0</div><script>let n = 0; setInterval(() => { document.getElementById('c').textContent = ++n; document.body.style.background = n % 2 ? '${bg}' : '#333'; }, 250);</script></body></html>`;
// Always on top: a window covered by another app's stops being painted, and its capture freezes (desktop/main.cjs,
// shareView). screenread-proof covers it on purpose once; anywhere else that would be a test accident.
await M(`const w = new BrowserWindow({ x: 80, y: 120, width: 640, height: 400, show: false, title: ${JSON.stringify(TARGET)}, skipTaskbar: true, focusable: false, alwaysOnTop: true, autoHideMenuBar: true });
  w.on('page-title-updated', (e) => e.preventDefault()); await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(page2(TARGET, '#0a66f0'))})); w.showInactive(); return 1;`);
await sleep(800);
const DIR_B = mkdtempSync(join(tmpdir(), 'maverick-rec-screen-'));
await page(`window.maverick.saveSettings({ recordMode: 'screen', recordDir: ${JSON.stringify(DIR_B)} }).then(() => 1)`);
// pick the window from the in-app list, the way a person does: the select in Settings
await page("document.querySelector('#btn-settings').click(); 1");
const listed = await until(() => page(`[...document.querySelectorAll('#set-record-source option')].some((o) => o.textContent === ${JSON.stringify(TARGET)})`), 10000);
check(listed, `Settings lists the window "${TARGET}" in its own list (no system picker)`);
const offered = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('#set-record-source option')].map((o) => o.textContent))"));
const own = JSON.parse(await M('return JSON.stringify(W.filter((w) => !w.isDestroyed()).map((w) => w.getTitle()));'));
check(!offered.some((o) => /^Maverick\b/.test(o)), `the list leaves out Maverick's own windows (${own.join(', ')}): ${offered.length} offered`);
await page(`(() => { const s = document.querySelector('#set-record-source'); s.value = ${JSON.stringify(TARGET)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(1200); // Settings saves a moment after a change
await page("document.querySelector('#dlg-settings').close(); 1");
ui = await settingsUi();
check(ui.mode === 'screen' && ui.source === TARGET && !ui.sourceOff, `Settings kept Audio + screen and the picked window: ${ui.source}`);
const sizes = [];
const mB = await meeting('audio + screen', async () => {
  // Halfway: Maverick's main window hidden, a throwaway window of another process (a plain PowerShell form) opened, and
  // the file must keep growing. Nothing forces the focus: when Windows keeps the foreground where the user is
  // (foreground lock), it stays in that app, which proves the same thing: the foreground is not Maverick.
  // The form is started by Maverick's main process: if Maverick holds the foreground, Windows' own rule (a process
  // started by the foreground process may take it) lets the form have it. It is a PowerShell form, not Maverick, so it
  // is left out of Maverick's processes below.
  // windowsHide (no console) also hides a program's first shown window; a see-through dummy form takes that first show.
  const form = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.Form; $d.Opacity = 0; $d.Show(); $d.Close(); $f = New-Object System.Windows.Forms.Form; $f.Text = '${FOCUS}'; $f.StartPosition = 'Manual'; $f.SetBounds(760, 160, 520, 320); [void]$f.ShowDialog()`;
  const focusPid = await M(`page.hide(); return process.mainModule.require('node:child_process').spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(form)}], { windowsHide: true, stdio: 'ignore' }).pid;`);
  await sleep(2500);
  const file = () => webms(DIR_B)[0];
  const ours = maverickPids(app.pid, focusPid);
  const state = JSON.parse(await M('return JSON.stringify({ mainVisible: page.isVisible(), mainFocused: page.isFocused(), anyFocused: !!BrowserWindow.getFocusedWindow() });'));
  const fg = foreground();
  const vis = await page('document.visibilityState');
  sizes.push(statSync(file()).size);
  await sleep(3000);
  sizes.push(statSync(file()).size);
  const state2 = JSON.parse(await M('return JSON.stringify({ mainVisible: page.isVisible(), mainFocused: page.isFocused(), anyFocused: !!BrowserWindow.getFocusedWindow() });'));
  const fg2 = foreground();
  log(`focus test: ${JSON.stringify({ state, state2, foreground: fg, foregroundAfter: fg2, maverickPids: [...ours], focusWindowPid: focusPid, page: vis, sizes })}`);
  const elsewhere = (f) => f.pid > 0 && !ours.has(f.pid);
  check(!state.mainVisible && !state2.mainVisible && !state.anyFocused && !state2.anyFocused && elsewhere(fg) && elsewhere(fg2) && sizes[1] > sizes[0],
    `audio + screen: main window hidden (page ${vis}), no Maverick window focused, foreground in another process: ${fg.name} pid ${fg.pid} "${fg.title}"${fg.pid === focusPid ? ' (the proof\'s focus window)' : ''}; the file grew from ${sizes[0]} to ${sizes[1]} bytes in 3 s`);
  killTree(focusPid);
});
const filesB = webms(DIR_B);
check(filesB.length === 1 && mB?.recording?.file === filesB[0] && mB.recording.mode === 'screen', `audio + screen: one recording in its folder: ${filesB.join(', ')}`);
if (filesB[0]) {
  const p = probe(filesB[0]);
  log(`ffprobe ${filesB[0]}: ${JSON.stringify(p)}`);
  const v = p.streams.find((s) => s.codec_type === 'video');
  check(v && p.streams.some((s) => s.codec_type === 'audio') && p.streams.length === 2, `audio + screen: ffprobe finds a video and an audio stream (${p.streams.map((s) => `${s.codec_type}/${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`).join(', ')})`);
  check(Number(p.format.duration) >= 8, `audio + screen: duration ${p.format.duration} s`);
  // the picture is the picked window (640 x 400 at scale 1), not the whole screen
  check(v && Math.abs(v.width - 640) <= 32 && Math.abs(v.height - 400) <= 48, `audio + screen: the picture is the picked window, ${v?.width}x${v?.height}`);
}
await M(`BrowserWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(TARGET)})?.destroy(); return 1;`);

// ---- edge cases through the same bridge the page uses: no window picked, the picked window gone, a folder that cannot be made
const DIR_C = mkdtempSync(join(tmpdir(), 'maverick-rec-edge-'));
await page(`window.maverick.saveSettings({ recordSource: '', recordDir: ${JSON.stringify(DIR_C)} }).then(() => 1)`);
let r = await page('window.maverick.recStart()');
await page('window.maverick.recStop(0)');
check(r?.source?.startsWith('screen:') && r.file.startsWith(DIR_C), `no window picked: the primary screen is recorded (${r?.source})`);
await page(`window.maverick.saveSettings({ recordSource: 'A window that is not open' }).then(() => 1)`);
r = await page('window.maverick.recStart()');
await page('window.maverick.recStop(0)');
check(r?.source?.startsWith('screen:'), `the picked window is gone: the primary screen is recorded instead (${r?.source})`);
const notAFolder = join(filesB[0] || filesA[0] || DIR_C, 'sub');
await page(`window.maverick.saveSettings({ recordDir: ${JSON.stringify(notAFolder)} }).then(() => 1)`);
r = await page('window.maverick.recStart()');
check(r?.error && !r.file, `a folder that cannot be made: recording does not start and says why ("${r?.error}")`);
await page("window.maverick.saveSettings({ recordMode: 'off', recordDir: '' }).then(() => 1)");
check(await page('window.maverick.recStart()') === null, 'Record meetings: Off starts nothing');

// ================================================================= 3. History: the player, and a transcript time seeks it
await page("document.querySelector('#btn-history').click(); 1");
await until(() => page("document.querySelector('#dlg-history').open"), 3000);
await page(`document.querySelector('#hist-list button[data-id=${JSON.stringify(mB.id)}]').click(); 1`);
const ready = await until(() => page("(() => { const v = document.querySelector('#hist-detail video'); return v && v.readyState >= 1 ? JSON.stringify({ duration: v.duration, w: v.videoWidth, h: v.videoHeight }) : ''; })()"), 15000);
check(ready && Number.isFinite(JSON.parse(ready).duration) && JSON.parse(ready).duration >= 8, `History shows a player for the meeting's recording: ${ready}`);
const stamps = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('#hist-detail li .cite[data-t]')].map((b) => b.dataset.t))"));
log(`transcript times in History: ${stamps.join(', ')}`);
const stamp = stamps.at(-1);
await page(`[...document.querySelectorAll('#hist-detail li .cite[data-t]')].at(-1).click(); 1`);
const want = stamp ? stamp.split(':').reduce((a, n) => a * 60 + Number(n), 0) : NaN;
await sleep(1500);
const at = await page("(() => { const v = document.querySelector('#hist-detail video'); v.pause(); return v.currentTime; })()");
// currentTime after 1.5 s of playing from the seek point; the seek itself lands within 1 s when it is at most 2.5 s past it
const landed = await page("new Promise((r) => { const v = document.querySelector('#hist-detail video'); r(v.played.length ? v.played.start(v.played.length - 1) : v.currentTime); })");
check(stamps.length >= 2 && Math.abs(landed - want) <= 1, `clicking the transcript time ${stamp} (${want} s) seeks the player to ${landed.toFixed(2)} s (now ${at.toFixed(2)} s)`);
await page("document.querySelector('#dlg-history').close(); 1");

const errs = out.filter((l) => /\[(page|bar) (warning|error)\]/.test(l));
check(!errs.length, `renderer console warnings and errors: ${errs.length ? errs.join(' | ') : 'none'}`);

// ================================================================= acceptance 2, defects B and G, through the real rec-chunk
// B: with no video frame in its first second, MediaRecorder hands over a 1-byte first chunk; an 18-minute file then had
// no duration. A live WebM made in the page (no Duration, as MediaRecorder writes it) goes in as 1 byte, then 4 KB chunks.
const DIR_E = mkdtempSync(join(tmpdir(), 'maverick-rec-short-'));
await page(`window.maverick.saveSettings({ recordMode: 'audio', recordDir: ${JSON.stringify(DIR_E)} }).then(() => 1)`);
const fed = JSON.parse(await page(`(async () => {
  const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const mr = new MediaRecorder(d.stream, { mimeType: 'audio/webm;codecs=opus' }); const parts = [];
  mr.ondataavailable = (e) => parts.push(e.data);
  mr.start(1000); await new Promise((r) => setTimeout(r, 4000)); await new Promise((r) => { mr.onstop = r; mr.stop(); }); ac.close();
  const all = new Uint8Array(await new Blob(parts).arrayBuffer());
  const r = await window.maverick.recStart();
  const sizes = [1];
  await window.maverick.recChunk(all.subarray(0, 1));
  for (let i = 1; i < all.length; i += 4096) { const c = all.subarray(i, i + 4096); sizes.push(c.length); await window.maverick.recChunk(c); }
  const stop = await window.maverick.recStop(4000);
  return JSON.stringify({ file: r.file, stopped: stop.file, chunks: sizes.length, first: sizes[0] });
})()`));
const pE = probe(fed.file);
log(`short first chunk: ${JSON.stringify(fed)}; ffprobe ${JSON.stringify(pE)}`);
check(fed.stopped === fed.file && Number.isFinite(Number(pE.format.duration)) && Math.abs(Number(pE.format.duration) - 4) <= 1,
  `B: a recording whose first chunk is 1 byte (then ${fed.chunks - 1} more) has a finite duration: ${pE.format.duration} s`);
// G: no capture, no file. The bridge: a recording that got no byte; the app: a meeting ended before its recording began.
const DIR_G = mkdtempSync(join(tmpdir(), 'maverick-rec-empty-'));
await page(`window.maverick.saveSettings({ recordDir: ${JSON.stringify(DIR_G)} }).then(() => 1)`);
r = await page('window.maverick.recStart()');
const emptyStop = await page('window.maverick.recStop(5000)');
check(r?.file && !emptyStop.file && !existsSync(r.file), `G: a recording that got no byte leaves no file (${r?.file}: ${existsSync(r?.file || '') ? 'still there' : 'removed'})`);
const histBefore = (await historyMeetings()).length;
await page("window.maverickTest.backdate(0); const b = document.querySelector('#btn-end'); b.disabled = false; b.click(); 1");
await sleep(4000);
await page("document.querySelector('#dlg-summary').open && document.querySelector('#dlg-summary').close(); 1");
const histAfter = await historyMeetings();
check(!webms(DIR_G).length && histAfter.length === histBefore && !histAfter.some((m) => m.recording?.file?.startsWith(DIR_G)),
  `G: a meeting with no capture leaves no 0-byte .webm (${webms(DIR_G).length} files) and no History player (${histAfter.length - histBefore} meetings added)`);
await page("window.maverick.saveSettings({ recordMode: 'off', recordDir: '' }).then(() => 1)");

// ================================================================= one app's sound: tone A in, tone B out
let ffmpeg = '';
try { ffmpeg = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { /* missing */ }
check(!!ffmpeg, `ffmpeg is installed: ${ffmpeg || 'not found on PATH'}`);
const TONES = mkdtempSync(join(tmpdir(), 'maverick-tones-'));
// 2 s of a whole number of cycles, so PlayLooping has no click
const wav = (hz) => {
  const n = 96000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 48000) * 0.3 * 32767), 44 + i * 2);
  const f = join(TONES, `${hz}.wav`);
  writeFileSync(f, b);
  return f;
};
// A window of its own process; hz 0 plays nothing (window C). Started here, not by Maverick, so no tree holds two of them.
const player = (title, hz, x) => spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.Form; $d.Opacity = 0; $d.Show(); $d.Close(); `
  + (hz ? `$p = New-Object System.Media.SoundPlayer '${wav(hz)}'; $p.PlayLooping(); ` : '')
  + `$f = New-Object System.Windows.Forms.Form; $f.Text = '${title}'; $f.StartPosition = 'Manual'; $f.SetBounds(${x}, 600, 300, 160); [void]$f.ShowDialog()`], { windowsHide: true, stdio: 'ignore' }).pid;
const TONE_A = 'Tone A 440 Hz';
const TONE_B = 'Tone B 1000 Hz';
const SILENT = 'Silent window C';
const players = [player(TONE_A, 440, 40), player(TONE_B, 1000, 360), player(SILENT, 0, 680)];
const windowNames = () => M("const { desktopCapturer } = process.mainModule.require('electron'); return JSON.stringify((await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).map((s) => s.name));").then(JSON.parse);
const listed3 = await until(async () => { const n = await windowNames(); return [TONE_A, TONE_B, SILENT].every((t) => n.includes(t)) && n; }, 20000, 500);
check(listed3, `the three player windows are open and listed: ${[TONE_A, TONE_B, SILENT].join(', ')}`);
await sleep(1000);
// dBFS of each tone in a recording: decoded to 48 kHz mono, a Goertzel filter over everything from 2 s in
const tones = (file) => {
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { windowsHide: true, maxBuffer: 1 << 28 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1).subarray(96000);
  const level = (hz) => {
    const k = 2 * Math.cos((2 * Math.PI * hz) / 48000);
    let a = 0, b = 0;
    for (const x of s) { const c = x / 32768 + k * a - b; b = a; a = c; }
    return 20 * Math.log10((2 * Math.sqrt(Math.max(1e-30, a * a + b * b - k * a * b))) / Math.max(1, s.length));
  };
  return { a: Math.round(level(440) * 10) / 10, b: Math.round(level(1000) * 10) / 10, quiet: Math.round(level(700) * 10) / 10, seconds: Math.round(s.length / 4800) / 10 };
};
await page("window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const t of m.addedNodes) if (t.classList?.contains('toast')) window.__toasts.push(t.dataset.msg); }).observe(document.body, { childList: true, subtree: true }); 1");
const toastsSaid = () => page("JSON.stringify(window.__toasts.splice(0))").then(JSON.parse);
const oneApp = async (name, settings, want) => {
  const dir = mkdtempSync(join(tmpdir(), 'maverick-rec-app-'));
  await page(`window.maverick.saveSettings(${JSON.stringify({ ...settings, recordDir: dir })}).then(() => 1)`);
  // A save starts the share check, whose desktopCapturer.getSources (screens only) can answer a getSources made at the
  // same moment (Share meeting's pick of the window), which then finds no window. A person never clicks that fast.
  await sleep(2000);
  await toastsSaid();
  await meeting(name);
  const said = await toastsSaid();
  const file = webms(dir)[0];
  if (!check(file, `${name}: the recording is on disk: ${file}`)) return;
  const t = tones(file);
  log(`${name}: ${JSON.stringify({ file, dBFS: t, notices: said })}`);
  want(t, said);
};
const PRESENT = -40; // dBFS: a 0.3 amplitude tone reads about -10 to -16 after loopback, Opus and the mix
const GAP = 30; // dB: a leaked tone would sit near A's level; the per-app path keeps it down at the noise floor
await oneApp('one app (record window A, share the screen)', { recordMode: 'screen', recordSource: TONE_A, source: '' }, (t, said) => {
  check(t.a > PRESENT, `one app, record window A: A's 440 Hz is in the file at ${t.a} dBFS (over ${PRESENT})`);
  check(t.b < t.a - GAP, `one app, record window A: B's 1000 Hz is out, ${t.b} dBFS, ${Math.round(t.a - t.b)} dB under A (${GAP} or more), though the shared screen plays it`);
  check(!said.some((m) => /all the sound on this PC/.test(m)), `one app, record window A: no fallback notice (${said.length} notices)`);
});
await oneApp('one app (share window A, audio only)', { recordMode: 'audio', recordSource: '', source: TONE_A }, (t) => {
  check(t.a > PRESENT, `one app, share window A: A's 440 Hz is in the meeting sound at ${t.a} dBFS`);
  check(t.b < t.a - GAP, `one app, share window A: B's 1000 Hz is out of the meeting sound transcription hears, ${t.b} dBFS, ${Math.round(t.a - t.b)} dB under A`);
});
await oneApp('fallback (record silent window C)', { recordMode: 'screen', recordSource: SILENT, source: '' }, (t, said) => {
  check(said.some((m) => /is not playing any sound yet, so the recording takes all the sound on this PC instead/.test(m)), `fallback: the notice says the system sound is used: "${said.find((m) => /sound/.test(m))}"`);
  check(t.a > PRESENT && t.b > PRESENT, `fallback: the system sound is recorded, both tones in: A ${t.a} dBFS, B ${t.b} dBFS`);
});
for (const p of players) killTree(p);
await page("window.maverick.saveSettings({ recordMode: 'off', recordDir: '', recordSource: '', source: '' }).then(() => 1)");

// ================================================================= 4. a crash mid-recording keeps what was recorded
const DIR_D = mkdtempSync(join(tmpdir(), 'maverick-rec-crash-'));
await page(`window.maverick.saveSettings({ recordMode: 'screen', recordSource: '', recordDir: ${JSON.stringify(DIR_D)} }).then(() => 1)`);
await page("document.querySelector('#btn-share').click(); 1");
await until(() => webms(DIR_D).length, 10000);
await sleep(6000);
page.close(); main.close();
killTree(app.pid); // no quit, no End: the process tree dies the way a crash ends it
await until(async () => app.exitCode !== null || app.signalCode !== null, 8000, 200);
await sleep(1000);
const crashed = webms(DIR_D)[0];
if (check(crashed, `crash: the recording file is on disk: ${crashed}`)) {
  const p = probe(crashed);
  const last = Number(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', crashed], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).at(-1));
  log(`ffprobe after the crash: ${JSON.stringify(p)}, last audio packet at ${last} s`);
  check(p.streams.length === 2 && p.streams.some((x) => x.codec_type === 'video') && last >= 4, `crash: the Audio + screen file still reads, ${last} s of audio kept from about 6 s recorded`);
  check(Number.isFinite(Number(p.format.duration)) && Math.abs(Number(p.format.duration) - last) <= 1.5, `crash: the file has a finite duration too, ${p.format.duration} s`);
}

// ---- the end
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after (${realBefore.split('\n').length} files)`);
log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nrecording proof passed');
finish(fails.length ? 1 : 0);
