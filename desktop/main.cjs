// Maverick desktop shell. Runs serve.mjs in this process on 127.0.0.1 and loads the same web app,
// then adds what a browser cannot: the always-on-top bar, global hotkeys, a tray icon, and screen
// plus system-audio capture without a picker.
//   npm start    (or: npx electron .)
// Both windows are left out of screen capture and screen sharing by default (Settings, "Hide Maverick when I share my screen").

const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeTheme, safeStorage, screen, session, shell, Tray } = require('electron');
const publik = require('./publik.cjs');
// publik API self-test (https://publikhq.com/skills/setup.md, step 6): the built app prints one line and exits. It
// returns before anything else in this file runs: no single-instance lock, no server, no windows, no timers.
if (process.env.PUBLIK_SELF_TEST) {
  publik.selfTest().then((line) => process.stdout.write(`${line}\n`, () => app.exit(0)));
  return; // CommonJS: a return at module level ends this file here
}
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
// A separate profile (settings, meetings, bar position): test/glass-proof.mjs runs the app in a throwaway folder
// so it never reads or writes the real one. Must be set before anything asks for userData.
if (process.env.MAVERICK_USER_DATA) app.setPath('userData', path.resolve(process.env.MAVERICK_USER_DATA));
// Windows gets the .ico, which has hand-tuned 16 to 40 px frames for the tray and taskbar at 100 to 250 % scaling.
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
// Windows 11 22H2 (build 22621) and later draw Mica behind the main window; older Windows keeps a solid canvas.
const GLASS = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
// Two bar materials; the user picks one ("barMaterial" in maverick-desktop.json, or MAVERICK_BAR for a run):
//   capsule (default): a transparent window. bar.css draws a 26 px capsule over the live desktop with no blur,
//     so its text areas are nearly solid. The window is the slab plus a 12 px margin for its shadow and
//     40 px below for the tooltips; clicks on both pass through to the app underneath.
//   acrylic: an opaque frameless window sized to the slab, with Windows 11's acrylic material behind it. Real blur,
//     but the corners are the system's 8 px, not a capsule, and there is no room outside it for tooltips.
const BAR_SLAB_W = 760; // room for the ask field next to the timer and the Hidden badge during a meeting
const BAR_SLAB_MAX_H = 584;
const barMaterial = () => ((process.env.MAVERICK_BAR || state.barMaterial) === 'acrylic' && GLASS ? 'acrylic' : 'capsule');
const barGeo = () => (barMaterial() === 'acrylic' ? { pad: 0, tip: 0 } : { pad: 12, tip: 40 });
const barW = () => BAR_SLAB_W + 2 * barGeo().pad;
// The main window's header doubles as its title bar; the caption buttons are drawn over it, this tall.
const TITLE_H = 56;

// Ctrl+Enter is left alone: Teams sends the message with it.
const DEFAULT_KEYS = {
  answer: 'Ctrl+Shift+Enter',
  answer2: 'Ctrl+Shift+1',
  explain: 'Ctrl+Shift+2',
  solve: 'Ctrl+Shift+5', // not Ctrl+Shift+H: in Teams that hangs up the call
  assist: 'Ctrl+Shift+6', // smart assist: Answer, Explain screen or Solve, picked from what was heard and what is shown
  followup: 'Ctrl+Shift+3',
  recap: 'Ctrl+Shift+4',
  deep: 'Ctrl+Shift+T',
  flag: 'Ctrl+Shift+F',
  ask: 'Ctrl+Shift+Space',
  bar: 'Ctrl+\\',
  main: 'Ctrl+Shift+0',
};
// No global arrow keys: Ctrl+Shift+Arrow is word selection in every app. The bar moves by dragging, or with
// the arrow keys while the bar itself is focused (src/app.mjs, openBar).

// ---------------------------------------------------------------- state file (bar position, hotkeys, capture source, port)

const STATE_FILE = path.join(app.getPath('userData'), 'maverick-desktop.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
// Only known actions: this also drops the old up/down/left/right bar-move keys saved by earlier versions.
state.keys = Object.fromEntries(Object.keys(DEFAULT_KEYS).map((k) => [k, typeof state.keys?.[k] === 'string' ? state.keys[k] : DEFAULT_KEYS[k]]));
// Content protection (Windows: WDA_EXCLUDEFROMCAPTURE, Windows 10 2004 or later) keeps the main window and the bar out
// of screen shares and screenshots. On by default. MAVERICK_CAPTURE_VISIBLE=1 turns it off without touching the saved
// setting: test/glass-proof.mjs photographs the screen, so it needs the windows to show.
// While hiding, the main window also leaves the taskbar, and with it Alt+Tab and Win+Tab (the bar never has a taskbar
// button). The tray icon goes too unless the user keeps it (Settings, "Also hide the tray icon", on by default).
const hideFromShare = () => state.hideFromShare !== false && process.env.MAVERICK_CAPTURE_VISIBLE !== '1';
const hideTray = () => hideFromShare() && state.hideTray !== false;
function applyProtection() {
  const hide = hideFromShare();
  for (const w of [main, bar, menuWin]) if (w && !w.isDestroyed()) w.setContentProtection(hide);
  if (main && !main.isDestroyed()) main.setSkipTaskbar(hide);
  if (app.isReady()) syncTray();
}
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.warn(`Could not save ${STATE_FILE}: ${e.message}`); } };

// The web app keeps meetings in localStorage, which belongs to the page origin, port included. So the
// port is picked at random once and then reused. ponytail: if that port is taken on a later start, a new
// one is used and saved meetings stay under the old origin until it is free again.
function freePort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(port ? freePort(0) : 0));
    s.listen(port || 0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let main = null;
let bar = null;
let tray = null;
let quitting = false;
let listening = false;
let barBusy = false;
let ignoring = false;
let failedKeys = [];

// Renderer warnings and errors go to this terminal, so a failing page is visible without DevTools.
function logConsole(win, name) {
  win.webContents.on('console-message', (e, level, message) => {
    const lv = e.level ?? ['verbose', 'info', 'warning', 'error'][level];
    if (lv === 'warning' || lv === 'error') console.log(`[${name} ${lv}] ${e.message ?? message}`);
  });
}

// ---------------------------------------------------------------- hotkeys

function onHotkey(name) {
  if (name === 'bar') return toggleBar();
  if (name === 'main') return showMain();
  if (!main) return;
  if (bar && !bar.isVisible()) bar.showInactive();
  if (name === 'ask') focusBar();
  main.webContents.send('action', name === 'answer2' ? 'answer' : name);
}

// Registers every hotkey; returns the ones Windows refused (taken by another app, or a bad key name).
function registerKeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [name, accel] of Object.entries(state.keys)) {
    if (!accel) continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, () => onHotkey(name)); } catch { ok = false; }
    if (!ok) failed.push({ name, accel });
  }
  failedKeys = failed;
  if (failed.length) console.warn(`Hotkeys not registered: ${failed.map((f) => `${f.name}=${f.accel}`).join(', ')}`);
  return failed;
}

// ---------------------------------------------------------------- the bar

function defaultBarPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + (wa.width - barW()) / 2), y: wa.y + 12 };
}

// The saved spot, if it is still on a connected display; otherwise top center of the primary display.
function barPos() {
  const p = state.bar;
  const onScreen = p && screen.getAllDisplays().some(({ workArea: w }) => p.x >= w.x - barW() / 2 && p.x < w.x + w.width - barW() / 2 && p.y >= w.y && p.y < w.y + w.height - 40);
  return onScreen ? p : defaultBarPos();
}

function barOptions() {
  const { pad, tip } = barGeo();
  return {
    ...barPos(), width: barW(), height: 52 + 2 * pad + tip,
    ...(barMaterial() === 'acrylic'
      ? { frame: false, transparent: false, backgroundColor: '#00000000', backgroundMaterial: 'acrylic', hasShadow: true, roundedCorners: true }
      : { frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, roundedCorners: false }),
    // Not focusable: a click on a button runs it and Teams keeps the keyboard. focusBar() lifts this for typing.
    focusable: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Maverick bar', icon: ICON,
    webPreferences: { backgroundThrottling: false },
  };
}

// Windows 11 outlines the acrylic bar with the accent colour when "Show accent colour on title bars and window borders"
// is on. DWMWA_BORDER_COLOR (34) set to DWMWA_COLOR_NONE (0xFFFFFFFE) turns that border off and keeps the rounded
// corners (thickFrame: false would drop both). ponytail: Electron has no DWM call, so this goes through a one-shot
// PowerShell P/Invoke (about a second, before the bar is shown); a small native addon is the upgrade.
function noBorder(win) {
  const h = win.getNativeWindowHandle();
  const hwnd = h.length === 8 ? h.readBigUInt64LE() : BigInt(h.readUInt32LE());
  const cmd = 'Add-Type -Name W -Namespace D -MemberDefinition \'[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(System.IntPtr h, int a, ref uint v, int s);\'; '
    + `$v = [uint32]4294967294; exit [D.W]::DwmSetWindowAttribute([System.IntPtr]${hwnd}, 34, [ref]$v, 4)`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (e) => {
    if (e) console.warn(`Could not remove the window's accent border: ${e.message}`);
    resolve();
  }));
}

function setupBar(win) {
  bar = win;
  applyProtection(); // before it is first shown
  logConsole(bar, 'bar');
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true);
  ignoring = false;
  bar.on('moved', () => { const [x, y] = bar.getPosition(); state.bar = { x, y }; save(); });
  bar.on('show', () => scheduleShareCheck());
  bar.on('close', (e) => { if (!quitting) { e.preventDefault(); bar.hide(); buildTray(); } }); // Alt+F4 hides it
  bar.on('blur', () => bar.setFocusable(false));
  bar.on('closed', () => { bar = null; buildTray(); });
  // Shown once it has painted (or after 0.8 s), and for acrylic once the border is gone.
  const painted = new Promise((r) => { win.once('ready-to-show', r); setTimeout(r, 800); });
  Promise.all([painted, barMaterial() === 'acrylic' ? noBorder(win) : null])
    .then(() => { if (!win.isDestroyed() && !win.isVisible()) win.showInactive(); });
  buildTray();
}

// The ask field needs the keyboard: make the bar focusable for as long as it has focus.
function focusBar() {
  if (!bar) return;
  bar.setFocusable(true);
  bar.show();
  bar.focus();
}

function moveBar(dx, dy) {
  if (!bar) return;
  const [x, y] = bar.getPosition();
  bar.setPosition(x + dx, y + dy);
  state.bar = { x: x + dx, y: y + dy };
  save();
}

function toggleBar() {
  if (!bar) return main?.webContents.send('action', 'bar');
  if (bar.isVisible()) bar.hide(); else bar.showInactive();
  buildTray();
}

// Click-through when idle: while the cursor is off the bar, nothing is streaming and the ask field is not
// in use, clicks go to the window underneath. Polling the cursor is used instead of mouseenter, because a
// drag region swallows the renderer's mouse events on Windows.
setInterval(() => {
  if (!bar || bar.isDestroyed() || !bar.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = bar.getBounds();
  const { pad, tip } = barGeo();
  const over = p.x >= b.x + pad && p.x < b.x + b.width - pad && p.y >= b.y + pad && p.y < b.y + b.height - pad - tip;
  const ignore = !over && !barBusy && !bar.isFocused();
  if (ignore !== ignoring) {
    ignoring = ignore;
    bar.setIgnoreMouseEvents(ignore, { forward: true });
  }
}, 100);

// ---------------------------------------------------------------- the "Hidden" badge: proof that shares cannot see Maverick
// Every 10 s, and soon after the bar shows, the theme or a setting changes, the main process takes a real capture of the
// display the bar is on (one frame of a getUserMedia desktop capture at the display's native size, grabbed in the main
// page: the path Chromium-based meeting apps use)
// and looks for the canary there: a fixed strip of grey cells drawn inside the bar (src/canary.mjs). Only a crop of the
// bar's area is read. So that a miss can never be reported as "Hidden": the bar's own render (capturePage, which content
// protection does not touch) must show the strip, the strip must lie inside the capture, and the bar must not show as a
// black box (Windows before 10 2004). Found, a black box, or hiding off: "visible". Not checkable (the bar is not on
// screen, no capture): "unknown", which the page shows as "Not checked". Electron's own content protection flag is
// reported too; the window's display affinity is not read, because Electron has no call for it and a PowerShell
// P/Invoke costs about a second each time. The pixel test decides.
let canary = null; // src/canary.mjs, loaded at start
let shareCheck = null;
let shareRun = null;
let shareTimer = null;
let shareHeld = false; // test hook: test/feature-proof.mjs freezes the badge while it photographs it
const scheduleShareCheck = (ms = 700) => { clearTimeout(shareTimer); shareTimer = setTimeout(checkShare, ms); };
let screenIds = null; // desktopCapturer's screen sources, listed once (shareProof); cleared when the displays change

async function shareProof() {
  const hiding = hideFromShare();
  const base = { at: Date.now(), hiding, flag: !!bar && !bar.isDestroyed() && bar.isContentProtected(), remote: remoteSession };
  const unknown = (reason) => ({ ...base, state: hiding ? 'unknown' : 'visible', found: null, reason });
  if (!canary) return unknown('the check is still starting');
  if (!bar || bar.isDestroyed() || !bar.isVisible()) return unknown('the bar is not on screen');
  const r = await bar.webContents.executeJavaScript(`(() => {
    const box = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && b.width ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; };
    return { strip: box('.canary'), slab: box('.mini') };
  })()`);
  if (!r.strip || !r.slab) return unknown('the check pattern is not drawn');
  const n = canary.CANARY.length;
  // 1. control: the strip is in the bar's own render, so it is on screen to be found
  const pad = { x: Math.floor(r.strip.x) - 4, y: Math.floor(r.strip.y) - 4, width: Math.ceil(r.strip.width) + 8, height: Math.ceil(r.strip.height) + 8 };
  const own = await bar.webContents.capturePage(pad);
  const ko = own.getSize().width / pad.width;
  const drawn = !own.isEmpty() && canary.findCanary(own.toBitmap(), own.getSize().width, own.getSize().height,
    { x: (r.strip.x - pad.x) * ko, y: (r.strip.y - pad.y) * ko, cell: (r.strip.width / n) * ko, h: r.strip.height * ko }).found;
  if (!drawn) return unknown('the check pattern did not render in the bar');
  // 2. the capture: the bar's display at native size, cropped to the bar
  const cb = bar.getContentBounds();
  const d = screen.getDisplayMatching(cb);
  // With --force-device-scale-factor (how test/feature-proof.mjs runs 150 %), Electron 44 reports the display's bounds
  // divided by the scale twice (853 x 480 for a 1920 x 1080 screen at 1.5), while windows and the work area use the
  // right DIPs. A work area wider than its display gives it away; then the bounds are scaled back once.
  const db = d.workArea.width > d.bounds.width + 1 ? Object.fromEntries(Object.entries(d.bounds).map(([k, v]) => [k, Math.round(v * d.scaleFactor)])) : d.bounds;
  // This used to be desktopCapturer.getSources with a full-size thumbnail every time, which held the main process for
  // about half a second (fix pass 2026-10-17, item 6): getSources itself blocks for about 400 ms even without a thumbnail. So the
  // screen ids are listed once, until the displays change, and the frame is grabbed in the page, off this process.
  screenIds ??= await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = screenIds.find((s) => s.display_id === String(d.id)) ?? (screenIds.length === 1 ? screenIds[0] : null);
  if (!src || !main || main.isDestroyed()) return unknown('no screen capture came back');
  const g = await main.webContents.executeJavaScript(`(${grabCrop})(${JSON.stringify(src.id)}, ${JSON.stringify({ x: cb.x - db.x, y: cb.y - db.y, width: cb.width, height: cb.height, dbw: db.width })})`)
    .catch((e) => { screenIds = null; throw e; }); // a stale id is listed again next time
  if (!g?.px) return unknown(g?.size ? 'the bar is partly off its display' : 'no screen capture came back');
  const { size, box, px } = g;
  const k = size.width / db.width; // capture pixels per DIP: the scale factor when the capture is full size
  const at = { x: (cb.x - db.x) * k, y: (cb.y - db.y) * k };
  const strip = { x: at.x - box.x + r.strip.x * k, y: at.y - box.y + r.strip.y * k, cell: (r.strip.width / n) * k, h: r.strip.height * k };
  if (strip.x < 0 || strip.y < 0 || strip.x + n * strip.cell > box.width || strip.y + strip.h > box.height) {
    return unknown('the bar is partly off its display');
  }
  if (px.length !== box.width * box.height * 4) return unknown('the capture came back at an unexpected size');
  const found = canary.findCanary(px, box.width, box.height, strip).found;
  const slab = { x: Math.round(at.x - box.x + r.slab.x * k), y: Math.round(at.y - box.y + r.slab.y * k), width: Math.round(r.slab.width * k), height: Math.round(r.slab.height * k) };
  const blackBox = canary.blackShare(px, box.width, box.height, slab) > 0.95;
  if (!bar.isVisible()) return unknown('the bar was hidden during the check');
  return {
    ...base, state: !hiding || found || blackBox ? 'visible' : 'hidden', found, blackBox, drawn,
    display: `${size.width} x ${size.height}`, scale: d.scaleFactor, ms: Date.now() - base.at,
  };
}

// Remote Desktop: the person at the other end sees this session through the RDP client, which content protection on
// this PC does not govern, so the page warns that hiding is not guaranteed (src/copilot.mjs, isRemoteSession). A warning
// only: nothing here looks for, or reacts to, any capture or recording software.
// SESSIONNAME says it at once; GetSystemMetrics(SM_REMOTESESSION, 0x1000) goes through a one-shot PowerShell P/Invoke
// (about a second, off the start path), like noBorder().
let remoteSession = false;
function readRemoteSession(copilot) {
  remoteSession = copilot.isRemoteSession({ sessionName: process.env.SESSIONNAME });
  if (process.platform !== 'win32') return;
  const cmd = 'Add-Type -Name M -Namespace R -MemberDefinition \'[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);\'; [R.M]::GetSystemMetrics(4096)';
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (e, out) => {
    if (e) return;
    const was = remoteSession;
    remoteSession = copilot.isRemoteSession({ sessionName: process.env.SESSIONNAME, metric: Number(String(out).trim()) || 0 });
    if (remoteSession !== was) scheduleShareCheck(0);
  });
}

// Runs in the main page (shareProof): one frame of the display `id` at its native size, cropped to the bar's area `r`
// (DIPs from the display's corner; dbw is the display's width in DIPs). Returns { size, box, px: RGBA } or, when the
// bar is off the frame, px null. RGBA where toBitmap gave BGRA: findCanary and blackShare do not mind the order.
async function grabCrop(id, r) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 8192, maxHeight: 8192 } } });
  try {
    // the track's own frames (ImageCapture.grabFrame failed now and then on a fresh desktop track)
    const reader = new MediaStreamTrackProcessor({ track: s.getVideoTracks()[0] }).readable.getReader();
    const { value: bmp } = await Promise.race([reader.read(), new Promise((_, no) => setTimeout(() => no(new Error('no frame came')), 5000))]);
    reader.cancel().catch(() => {});
    if (!bmp) throw new Error('no frame came');
    const size = { width: bmp.displayWidth, height: bmp.displayHeight };
    const k = size.width / r.dbw;
    const box = { x: Math.max(0, Math.floor(r.x * k)), y: Math.max(0, Math.floor(r.y * k)) };
    box.width = Math.min(size.width, Math.ceil((r.x + r.width) * k)) - box.x;
    box.height = Math.min(size.height, Math.ceil((r.y + r.height) * k)) - box.y;
    if (box.width <= 0 || box.height <= 0) { bmp.close(); return { size, box, px: null }; }
    const ctx = new OffscreenCanvas(box.width, box.height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    bmp.close();
    return { size, box, px: new Uint8Array(ctx.getImageData(0, 0, box.width, box.height).data.buffer) };
  } finally {
    s.getTracks().forEach((t) => t.stop());
  }
}

// Runs a check now (or joins the one running) and sends the result to the page.
function checkShare() {
  clearTimeout(shareTimer);
  if (shareHeld) return Promise.resolve(shareCheck);
  shareRun ??= shareProof()
    .catch((e) => ({ at: Date.now(), hiding: hideFromShare(), state: hideFromShare() ? 'unknown' : 'visible', found: null, reason: e.message, remote: remoteSession }))
    .then((r) => {
      shareCheck = r;
      shareRun = null;
      if (main && !main.isDestroyed()) main.webContents.send('share-check', r);
      return r;
    });
  return shareRun;
}
setInterval(() => { if (canary) checkShare(); }, 10_000);

// ---------------------------------------------------------------- the shared window: can the capture still see it?
// A window source (Settings, Share meeting captures a window) shows only what its app paints. Covered by other windows,
// moved off every display or minimized, a Chromium-based app (Teams, Edge, Chrome, any Electron app) stops painting it,
// so the capture keeps repeating its last picture, or goes blank when minimized, while the slides move on (three proof
// runs read an old slide for minutes). The page asks here every 2 s and tells the user when its view may be stale
// (src/app.mjs, checkView). Electron has no call for another app's window, so one PowerShell, kept open while a window
// is shared, answers in a few ms: gone, minimized, or how many of 7 x 7 points inside the window hit it
// (WindowFromPoint; 0 is fully covered or off screen).
let sharedSource = null; // { id, name } of what Share meeting captures (setDisplayMediaRequestHandler)
let viewProbe = null;
const VIEW_PROBE = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class V {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(P p, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static string Q(long v) {
    IntPtr h = new IntPtr(v);
    if (!IsWindow(h) || !IsWindowVisible(h)) return "gone";
    if (IsIconic(h)) return "minimized";
    R r; GetWindowRect(h, out r);
    int seen = 0;
    for (int i = 1; i < 8; i++) for (int j = 1; j < 8; j++) {
      P p = new P { x = r.l + (r.r - r.l) * i / 8, y = r.t + (r.b - r.t) * j / 8 };
      if (MonitorFromPoint(p, 0) != IntPtr.Zero && GetAncestor(WindowFromPoint(p), 2) == h) seen++;
    }
    return "shown " + seen;
  }
}
'@
[V]::SetProcessDPIAware() | Out-Null
while ($null -ne ($l = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([V]::Q([long]$l)); [Console]::Out.Flush() }`;
function probeWindow(hwnd) {
  if (!viewProbe) {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(VIEW_PROBE, 'utf16le').toString('base64')], { windowsHide: true });
    viewProbe = { p, waiting: [], buf: '' };
    p.stdout.on('data', (d) => {
      viewProbe.buf += d;
      for (let i; (i = viewProbe.buf.indexOf('\n')) >= 0;) { const line = viewProbe.buf.slice(0, i).trim(); viewProbe.buf = viewProbe.buf.slice(i + 1); viewProbe.waiting.shift()?.(line); }
    });
    p.on('exit', () => { if (viewProbe?.p === p) { viewProbe.waiting.forEach((r) => r('')); viewProbe = null; } });
    p.on('error', () => {});
  }
  const probe = viewProbe;
  return new Promise((resolve) => {
    const t = setTimeout(() => { probe.waiting.splice(probe.waiting.indexOf(done), 1); resolve(''); }, 5000); // the first answer waits for Add-Type
    const done = (line) => { clearTimeout(t); resolve(line); };
    probe.waiting.push(done);
    probe.p.stdin.write(`${hwnd}\n`);
  });
}
const stopViewProbe = () => { viewProbe?.p.kill(); viewProbe = null; };
// { state: 'screen' (a whole display: always current), 'shown', 'covered', 'minimized', 'gone' or 'unknown', name }
async function shareView() {
  const s = sharedSource;
  const hwnd = /^window:(\d+):/.exec(s?.id ?? '')?.[1];
  if (!hwnd) return { state: s ? 'screen' : 'unknown', name: s?.name ?? '' };
  if (process.platform !== 'win32') return { state: 'unknown', name: s.name };
  const r = await probeWindow(hwnd);
  const state = r === 'gone' || r === 'minimized' ? r : /^shown (\d+)$/.test(r) ? (Number(r.slice(6)) ? 'shown' : 'covered') : 'unknown';
  return { state, name: s.name };
}

// ---------------------------------------------------------------- windows

// focus false (the page opened the Library, a cited page or History from the bar): the window comes up without taking
// the keyboard, so the meeting app in front keeps it until the user clicks into Maverick. The tray, the hotkey and a
// second launch ask for the window itself, so they focus it.
function showMain(focus = true) {
  if (!main) return;
  if (focus !== false) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return;
  }
  if (main.isFocused()) return;
  main.showInactive(); // also restores a minimized window, without activating it
  main.moveTop();
}

function buildTray() {
  if (!tray) return;
  // A tray tooltip is a native popup that screen captures would see, so there is none while Maverick hides.
  tray.setToolTip(hideFromShare() ? '' : listening ? 'Maverick, listening' : 'Maverick');
}

// The tray menu. A native menu (Menu.popup, a tray context menu) is its own OS window that content protection does not
// reach, so it would show in a share. This is a small protected window instead, with the same four items and the menu
// keyboard: arrows, Home, End, Enter or Space, Esc; it closes when it loses focus.
let menuWin = null;
const MENU_ITEMS = () => [
  ['bar', bar?.isVisible() ? 'Hide bar' : 'Show bar'],
  ['main', 'Open main window'],
  ['listen', listening ? 'Stop listening' : 'Start listening'],
  null,
  ['quit', 'Quit Maverick'],
];
function menuHtml(dark) {
  const c = dark
    ? { bg: '#1e1e22', text: '#f4f4f6', fill: 'rgb(118 118 128 / .28)', line: 'rgb(255 255 255 / .08)', ring: '#4c94ff', edge: 'rgb(255 255 255 / .1)', shadow: 'rgb(0 0 0 / .5)' }
    : { bg: '#fafafc', text: '#1c1c1e', fill: 'rgb(118 118 128 / .16)', line: 'rgb(0 0 0 / .08)', ring: '#0a66f0', edge: 'rgb(0 0 0 / .12)', shadow: 'rgb(0 0 0 / .18)' };
  const items = MENU_ITEMS().map((it) => (it
    ? `<button role="menuitem" data-cmd="${it[0]}">${it[1]}</button>`
    : '<hr role="separator">')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Maverick menu</title><style>
    html, body { margin: 0; background: transparent; color: ${c.text}; font: 13px/20px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; overflow: hidden; user-select: none; }
    body { padding: ${MENU_PAD}px; }
    [role=menu] { display: flex; flex-direction: column; padding: 6px; border-radius: 8px; background: ${c.bg}; box-shadow: 0 0 0 1px ${c.edge}, 0 6px 14px -2px ${c.shadow}; }
    button { all: unset; height: 32px; padding: 0 12px; border-radius: 6px; cursor: default; }
    button:hover, button:focus { background: ${c.fill}; }
    button:focus-visible { outline: 2px solid ${c.ring}; outline-offset: -2px; }
    hr { height: 0; margin: 4px 6px; border: 0; border-top: 1px solid ${c.line}; }
    [role=menu]:focus { outline: none; }
  </style></head><body><div role="menu" aria-label="Maverick" tabindex="-1">${items}</div><script>
    const items = [...document.querySelectorAll('[role=menuitem]')];
    const go = (cmd) => { location.hash = cmd; };
    items.forEach((b) => b.addEventListener('click', () => go(b.dataset.cmd)));
    addEventListener('keydown', (e) => {
      let i = items.indexOf(document.activeElement);
      if (i < 0 && e.key === 'ArrowUp') i = 0;
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); items[(to + items.length) % items.length].focus(); }
      else if (e.key === 'Escape') go('close');
    });
    document.querySelector('[role=menu]').focus();
  </script></body></html>`;
}
// The menu window is transparent and draws its own panel, corners and shadow, like the capsule bar. An opaque
// frameless window gets the Windows accent border when that setting is on, and DWMWA_BORDER_COLOR (noBorder, the
// acrylic bar's fix) does not hold for it: Windows restores the border every time the window is shown again, and
// the call takes about a second. A transparent window has no border to remove. Made once, hidden between uses.
const MENU_PAD = 12; // room for the shadow
function ensureMenu() {
  if (menuWin && !menuWin.isDestroyed()) return;
  menuWin = new BrowserWindow({
    width: 220 + 2 * MENU_PAD, height: 6 * 2 + 4 * 32 + 9 + 2 * MENU_PAD, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, minimizable: false, maximizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Maverick menu', icon: ICON,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  menuWin.setContentProtection(hideFromShare());
  menuWin.setAlwaysOnTop(true, 'pop-up-menu');
  menuWin.on('blur', () => menuWin?.hide());
  menuWin.on('closed', () => { menuWin = null; });
  menuWin.webContents.on('will-navigate', (e) => e.preventDefault());
  menuWin.webContents.on('did-navigate-in-page', (_e, url) => {
    const cmd = new URL(url).hash.slice(1);
    if (!cmd) return;
    menuWin?.hide();
    if (cmd === 'bar') toggleBar();
    else if (cmd === 'main') showMain();
    else if (cmd === 'listen') main?.webContents.send('action', 'listen');
    else if (cmd === 'quit') { quitting = true; app.quit(); }
  });
}
async function openMenu() {
  if (menuWin?.isVisible()) return menuWin.hide();
  ensureMenu();
  const { width, height } = menuWin.getBounds();
  const tb = tray?.getBounds();
  const at = tb?.width ? { x: tb.x + tb.width / 2, y: tb.y } : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(at).workArea;
  const gap = 8 - MENU_PAD; // the panel sits 8 px from the work area's edge
  const x = Math.round(Math.max(wa.x + gap, Math.min(wa.x + wa.width - width - gap, at.x - width / 2)));
  const y = Math.round(at.y > wa.y + wa.height / 2 ? wa.y + wa.height - height - gap : wa.y + gap);
  const dark = nativeTheme.shouldUseDarkColors;
  menuWin.setBounds({ x, y, width, height });
  await menuWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(menuHtml(dark))}`); // fresh labels and theme
  menuWin.show();
  menuWin.focus();
}

// The tray icon, unless Maverick hides it too (the notification area shows in a full-screen share). Without it,
// the global hotkeys bring Maverick back: the answer key shows the bar, "Open the main window" opens this.
function syncTray() {
  if (hideTray()) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    tray = new Tray(ICON);
    tray.on('click', () => showMain());
    tray.on('right-click', openMenu);
    ensureMenu(); // ready before the first right-click
  }
  buildTray();
}

// The window chrome follows the app's theme (set from the page, see 'theme' below): the caption buttons' colour,
// and without Mica the canvas colour behind the page.
const canvas = () => (nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#f0f0f3');
const overlay = () => ({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f4f4f6' : '#1c1c1e', height: TITLE_H });
function applyChrome() {
  if (!main || main.isDestroyed()) return;
  if (GLASS) main.setTitleBarOverlay(overlay()); else main.setBackgroundColor(canvas());
}
// Windows' own light or dark setting. nativeTheme reports the pinned theme once the page pins one, so the OS value is
// kept from the times the app follows the system (app start, and whenever it is unpinned).
let osDark = null;
const osIsDark = () => (nativeTheme.themeSource === 'system' ? (osDark = nativeTheme.shouldUseDarkColors) : osDark ?? nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => { osIsDark(); applyChrome(); });

async function createMain(port) {
  // First launch fits the screen: 90 % of the work area, at most 1440 x 900 (a 1366 x 768 laptop at 125 % has about
  // 1093 x 576 to give).
  const wa = screen.getPrimaryDisplay().workAreaSize;
  main = new BrowserWindow({
    width: Math.min(1440, Math.round(wa.width * 0.9)), height: Math.min(900, Math.round(wa.height * 0.9)),
    minWidth: 900, minHeight: 540, show: false, title: 'Maverick', icon: ICON,
    // Mica: the page canvas is transparent and the header is the title bar. Otherwise the canvas colour, so there is no flash.
    ...(GLASS ? { backgroundMaterial: 'mica', backgroundColor: '#00000000', titleBarStyle: 'hidden', titleBarOverlay: overlay() } : { backgroundColor: canvas() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false,
      additionalArguments: [GLASS && '--maverick-glass', process.env.MAVERICK_TEST_HOOKS === '1' && '--maverick-test'].filter(Boolean),
    },
  });
  applyProtection(); // before it is first shown
  main.removeMenu();
  logConsole(main, 'page');
  // The bar is a window.open() child of the main page, so the page drives it directly, like the browser pop-out.
  main.webContents.setWindowOpenHandler(({ frameName }) => (frameName === 'maverick-bar'
    ? { action: 'allow', overrideBrowserWindowOptions: barOptions() }
    : { action: 'deny' }));
  main.webContents.on('did-create-window', (win, { frameName }) => { if (frameName === 'maverick-bar') setupBar(win); });
  // Closing the main window hides it: the page owns the capture, the transcript and the bar.
  main.on('close', (e) => { if (!quitting) { e.preventDefault(); main.hide(); } });
  main.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) main.show(); });
  // Electron 44 race: when the app page is the window's first navigation and the renderer is still starting (a busy
  // PC), its sandboxed preload can start before Electron's pushed startup data lands: "binding.startupData is null",
  // no window.maverick. An empty document first (it paints nothing, so ready-to-show still waits for the app page) and
  // the app page then commits into a fresh frame, which gets the data in time. The CSP keeps Electron's insecure-CSP
  // warning off.
  await main.loadURL(`data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`);
  await main.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------------------------------------------------------------- IPC from the main page (the bar has no preload)

const fromMain = (e) => main && e.sender === main.webContents;
ipcMain.on('state', (e, s) => {
  if (!fromMain(e) || typeof s !== 'object' || !s) return;
  barBusy = !!s.busy;
  if (!!s.listening !== listening) { listening = !!s.listening; buildTray(); }
});
ipcMain.on('bar-size', (e, h) => {
  if (!fromMain(e) || !bar || !Number.isFinite(h)) return;
  const { pad, tip } = barGeo();
  const height = Math.max(40, Math.min(BAR_SLAB_MAX_H + 2 * pad + tip, Math.ceil(h) + tip));
  const b = bar.getBounds();
  if (b.height !== height) bar.setBounds({ ...b, height });
});
ipcMain.on('bar-focus', (e) => { if (fromMain(e)) focusBar(); });
ipcMain.on('show-main', (e, focus) => { if (fromMain(e)) showMain(focus !== false); });
// A web citation opens in the default browser: only http and https, never a file, a protocol handler or a script.
ipcMain.on('open-url', (e, u) => {
  if (!fromMain(e) || typeof u !== 'string' || u.length > 2000) return;
  let url;
  try { url = new URL(u); } catch { return; }
  if (url.protocol === 'http:' || url.protocol === 'https:') shell.openExternal(url.href).catch(() => {});
});
// publik API (desktop/publik.cjs): the disclosure the first-run offer shows verbatim, provisioning after the user's yes, and
// its links. The page gets the card (balance line, cost sentence, links) and whether this build has an app token, never
// the key or the token. Links open only on https publikhq.com.
ipcMain.handle('publik-info', (e) => (fromMain(e) ? { disclosure: publik.DISCLOSURE, card: publik.card(publik.readCredential()), hasToken: publik.hasAppToken() } : null));
ipcMain.handle('publik-provision', async (e) => {
  if (!fromMain(e)) return null;
  try { return publik.card(await publik.provision()); } catch (err) { return { error: err.message }; }
});
ipcMain.on('publik-open', (e, u) => { if (fromMain(e) && publik.isPublikUrl(u)) shell.openExternal(new URL(u).href).catch(() => {}); });
// '' follows Windows; 'light' or 'dark' pins Electron's theme too, so Mica and the caption buttons match the page.
ipcMain.on('bar-material', (e) => { e.returnValue = barMaterial(); });
ipcMain.on('os-theme', (e) => { e.returnValue = osIsDark() ? 'dark' : 'light'; });
// API keys at rest, for the main window only: encrypted with the Windows user's key (DPAPI), as base64. Never logged.
const canSeal = (e) => fromMain(e) && safeStorage.isEncryptionAvailable();
ipcMain.on('seal', (e, text) => { e.returnValue = canSeal(e) ? safeStorage.encryptString(String(text)).toString('base64') : null; });
ipcMain.on('unseal', (e, text) => {
  try { e.returnValue = canSeal(e) ? safeStorage.decryptString(Buffer.from(String(text), 'base64')) : null; } catch { e.returnValue = null; }
});
ipcMain.on('theme', (e, t) => {
  if (!fromMain(e)) return;
  osIsDark(); // remember the Windows setting before it is overridden
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
  applyChrome();
  scheduleShareCheck();
});
ipcMain.on('bar-move', (e, dx, dy) => { if (fromMain(e) && Number.isFinite(dx) && Number.isFinite(dy)) moveBar(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dy))); });
ipcMain.handle('desk-settings', (e) => (fromMain(e) ? {
  keys: state.keys, defaults: DEFAULT_KEYS, failed: failedKeys, source: state.source || '', hideFromShare: state.hideFromShare !== false, hideTray: state.hideTray !== false,
  recordMode: recording.recordMode(state.recordMode), recordSource: state.recordSource || '', recordDir: recording.recordDir(state.recordDir, app.getPath('videos')), vault: VAULT,
} : null));
ipcMain.handle('save-desk-settings', (e, s) => {
  if (!fromMain(e) || typeof s !== 'object' || !s) return null;
  if (s.keys && typeof s.keys === 'object') {
    for (const name of Object.keys(DEFAULT_KEYS)) {
      const v = s.keys[name];
      if (typeof v === 'string' && v.length <= 60) state.keys[name] = v.trim();
    }
  }
  if (typeof s.source === 'string' && s.source.length <= 300) state.source = s.source;
  if (typeof s.hideTray === 'boolean') state.hideTray = s.hideTray;
  if (typeof s.hideFromShare === 'boolean') state.hideFromShare = s.hideFromShare;
  if (typeof s.recordMode === 'string') state.recordMode = recording.recordMode(s.recordMode);
  if (typeof s.recordSource === 'string' && s.recordSource.length <= 300) state.recordSource = s.recordSource;
  if (recording.recordDirSetting(s.recordDir) !== null) state.recordDir = s.recordDir;
  applyProtection();
  save();
  scheduleShareCheck();
  return { failed: registerKeys() };
});
ipcMain.handle('share-check', (e) => (fromMain(e) ? checkShare() : null));
ipcMain.handle('share-view', (e) => (fromMain(e) ? shareView() : null));
ipcMain.on('share-stopped', (e) => { if (fromMain(e)) { sharedSource = null; stopViewProbe(); } });
ipcMain.handle('sources', async (e, screens) => {
  if (!fromMain(e)) return [];
  const list = await listSources(screens === true ? ['screen', 'window'] : ['window']);
  return [...new Set(notOwn(list).map((s) => s.name).filter(Boolean))];
});
// Electron's window list comes back empty for a few seconds after a capture ends (up to 5.8 s seen, recording-proof), so
// Settings would offer no windows and a pick would fall back to the screen: asked again until it has windows, up to 7 s.
async function listSources(types) {
  const ask = () => desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
  let list = await ask();
  for (const t0 = Date.now(); types.includes('window') && !list.some((s) => s.id.startsWith('window:')) && Date.now() - t0 < 7000;) {
    await new Promise((r) => setTimeout(r, 500));
    list = await ask();
  }
  return list;
}
// Maverick's own windows (main, bar, menu) are never offered or picked as a source: they hide from capture anyway.
const notOwn = (list) => { const own = new Set([main, bar, menuWin].filter((w) => w && !w.isDestroyed()).map((w) => w.getMediaSourceId())); return list.filter((s) => !own.has(s.id)); };

// ---------------------------------------------------------------- one app's sound
// desktop/app-audio.exe (desktop/app-audio/src/main.rs): Windows process loopback of the process that owns a window, and
// its children, so a recording or Share meeting of the Zoom or Teams window does not take in YouTube or a game. 48 kHz
// 16-bit stereo PCM, sent to the page in whole frames ('app-audio'); src/app.mjs plays it into its audio graph.
// { id, exe } or { error: 'no-session' | 'unavailable' | 'no-window' } (then the page keeps the system sound).
// Packaged, it sits outside the asar archive (package.json, build.asarUnpack): Windows cannot run an exe from inside one.
const APP_AUDIO = path.join(__dirname, 'app-audio.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const appAudio = new Map(); // id -> child process
let appAudioIds = 0;
ipcMain.handle('app-audio-start', (e, source) => {
  if (!fromMain(e)) return null;
  const hwnd = /^window:(\d+):/.exec(source === 'shared' ? sharedSource?.id || '' : String(source))?.[1];
  if (!hwnd) return { error: 'no-window' };
  if (!fs.existsSync(APP_AUDIO)) return { error: 'unavailable' };
  return new Promise((resolve) => {
    const p = spawn(APP_AUDIO, [hwnd], { windowsHide: true });
    p.stdin.on('error', () => {}); // closing it after the helper quit is not an error
    const id = ++appAudioIds;
    let err = '';
    let rest = Buffer.alloc(0);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { p.kill(); done({ error: 'unavailable' }); }, 8000);
    p.on('error', () => done({ error: 'unavailable' }));
    p.on('exit', () => { appAudio.delete(id); done({ error: 'unavailable' }); });
    p.stderr.on('data', (d) => {
      if (!settled && (err += d).includes('\n')) {
        let r = {};
        try { r = JSON.parse(err.split('\n')[0]); } catch { /* not ours */ }
        // No audio session in the app's process tree: it plays nothing (yet), so the system sound is the safer default.
        if (!r.ok || !r.session) { p.kill(); return done({ error: r.ok ? 'no-session' : r.error || 'unavailable', exe: r.exe }); }
        appAudio.set(id, p);
        done({ id, exe: r.exe });
      }
    });
    p.stdout.on('data', (d) => {
      const b = rest.length ? Buffer.concat([rest, d]) : d;
      const n = b.length & ~3; // whole stereo frames only
      rest = b.subarray(n);
      if (n && appAudio.has(id) && main && !main.isDestroyed()) main.webContents.send('app-audio', id, b.subarray(0, n));
    });
  });
});
ipcMain.on('app-audio-stop', (e, id) => { if (fromMain(e)) { appAudio.get(id)?.stdin.end(); appAudio.delete(id); } });
app.on('will-quit', () => { for (const p of appAudio.values()) p.kill(); });

// ---------------------------------------------------------------- session recording
// Settings, Record meetings (src/app.mjs records, this writes). Each chunk the page's MediaRecorder hands over (one a
// second) goes straight to disk, so a crash or a power cut keeps everything up to the last second. The duration goes into
// the space the first chunk left for it (src/recording.mjs, reserveDuration): after every chunk, as the time since the
// first chunk began, and at a clean stop as the page's exact length. So a file whose recording never stopped cleanly (the
// page reloaded or hung, a write failed, the app was killed) still has a length; one had none (acceptance defect 5).
let recording = null; // src/recording.mjs, loaded at start
let rec = null; // { fd, file, pos, voidAt, scale, t0 }
function recClose(ms) {
  if (!rec) return null;
  const r = rec;
  rec = null;
  try { if (r.head) fs.writeSync(r.fd, r.head, 0, r.head.length, 0); } catch { /* nothing more to save */ }
  try { if (ms > 0 && r.voidAt >= 0) fs.writeSync(r.fd, recording.durationElement(ms, r.scale), 0, 11, r.voidAt); } catch { /* the file plays without it */ }
  try { fs.closeSync(r.fd); } catch { /* already closed */ }
  // Nothing was recorded (the capture never started, or the meeting ended first): no empty file is left behind.
  if (!r.pos && !r.head) { try { fs.unlinkSync(r.file); } catch { /* gone already */ } return null; }
  return r.file;
}
// Opens the file for a new meeting: { file, mode, source } (source: the screen or window to capture, Audio + screen
// only), null while recording is off, or { error }.
ipcMain.handle('rec-start', async (e) => {
  if (!fromMain(e)) return null;
  const mode = recording.recordMode(state.recordMode);
  if (mode === 'off') return null;
  recClose(0); // a page that reloaded mid-recording left the last file open
  try {
    let source = '';
    if (mode === 'screen') {
      const want = state.recordSource || '';
      const sources = notOwn(await listSources(['screen', 'window']));
      let pick = want && sources.find((s) => s.name === want);
      if (want && !pick) main?.webContents.send('notice', `The window "${want}" was not found, so the primary screen is recorded instead.`);
      pick ||= sources.find((s) => s.display_id === String(screen.getPrimaryDisplay().id)) || sources.find((s) => s.id.startsWith('screen:'));
      if (!pick) throw new Error('no screen was found to record');
      source = pick.id;
    }
    const dir = recording.recordDir(state.recordDir, app.getPath('videos'));
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    for (let n = 1; ; n++) {
      const file = path.join(dir, recording.recordingName(now, n));
      try {
        rec = { fd: fs.openSync(file, 'wx'), file, pos: 0, voidAt: -1, scale: 1e6 };
        return { file, mode, source };
      } catch (err) { if (err.code !== 'EEXIST' || n >= 99) throw err; }
    }
  } catch (err) {
    return { error: err.code === 'ENOSPC' ? 'the disk is full' : err.message };
  }
});
ipcMain.handle('rec-chunk', (e, data) => {
  if (!fromMain(e) || !ArrayBuffer.isView(data)) return null;
  if (!rec) return { error: 'the recording file is closed' };
  let buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (rec.pos === 0) {
    if (rec.head) buf = Buffer.concat([rec.head, buf]);
    rec.t0 ??= Date.now() - 1000; // the first chunk holds the first second (the page's MediaRecorder timeslice)
    const r = recording.reserveDuration(buf);
    // The header is not whole yet (no video frame came in the first second): held until it is, so the Duration still
    // gets its space. An 18-minute file had none because its first chunk was 1 byte (acceptance 2, defect B).
    rec.head = r === recording.MORE && buf.length < 1 << 20 ? buf : null;
    if (rec.head) return { ok: true };
    if (r && r !== recording.MORE) { buf = r.buf; rec.voidAt = r.at; rec.scale = r.scale; }
  }
  try {
    for (let off = 0; off < buf.length;) off += fs.writeSync(rec.fd, buf, off, buf.length - off, rec.pos + off);
    rec.pos += buf.length;
    if (rec.voidAt >= 0) fs.writeSync(rec.fd, recording.durationElement(Date.now() - rec.t0, rec.scale), 0, 11, rec.voidAt);
    return { ok: true };
  } catch (err) {
    const file = recClose(0);
    return { error: err.code === 'ENOSPC' ? 'the disk is full' : err.message, file };
  }
});
ipcMain.handle('rec-stop', (e, ms) => (fromMain(e) ? { file: recClose(Number.isFinite(ms) ? ms : 0) } : null));
// The folder, on an explicit "Choose folder" click in Settings. A native dialog is its own window, which a screen share
// would show; that is accepted for this one click (no other native window is opened anywhere).
ipcMain.handle('pick-record-dir', async (e) => {
  if (!fromMain(e)) return null;
  const r = await dialog.showOpenDialog(main, { title: 'Save recordings in', defaultPath: recording.recordDir(state.recordDir, app.getPath('videos')), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0] || recording.recordDirSetting(r.filePaths[0]) === null) return null;
  state.recordDir = r.filePaths[0];
  save();
  return state.recordDir;
});

// ---------------------------------------------------------------- Memory: the vault
// Plain Markdown notes in one folder, <userData>/memory, that Obsidian can open as a vault (src/memory.mjs writes them).
// The page names a note; only a plain file name is taken, so nothing outside the folder is read or written.
const VAULT = path.join(app.getPath('userData'), 'memory');
const noteFile = (name) => (typeof name === 'string' && /^[^\\/:*?"<>|\x00-\x1f]{1,128}$/.test(name) && !/^[.\s]|[.\s]$/.test(name) ? path.join(VAULT, `${name}.md`) : null);
ipcMain.handle('memory-list', async (e) => {
  if (!fromMain(e)) return [];
  let files;
  try { files = (await fs.promises.readdir(VAULT)).filter((f) => /\.md$/i.test(f)); } catch { return []; }
  return (await Promise.all(files.map(async (f) => {
    const p = path.join(VAULT, f);
    try { return { name: f.slice(0, -3), text: await fs.promises.readFile(p, 'utf8'), mtime: (await fs.promises.stat(p)).mtimeMs }; } catch { return null; }
  }))).filter(Boolean);
});
// how: 'new' a fresh note (" 2", " 3"... after the name when it is taken), 'put' replaces the note, 'add' appends `text`
// unless the note has it already (an entity page: a missing one starts with `head`). Returns { name } or { error }.
ipcMain.handle('memory-write', async (e, name, text, how, head) => {
  if (!fromMain(e) || typeof text !== 'string' || text.length > 2_000_000) return null;
  if (!noteFile(name)) return { error: 'That is not a valid note name.' };
  try {
    await fs.promises.mkdir(VAULT, { recursive: true });
    if (how === 'new') {
      for (let n = 1; n < 100; n++) {
        const file = noteFile(n === 1 ? name : `${name} ${n}`);
        if (!file) break;
        try { await fs.promises.writeFile(file, text, { flag: 'wx' }); return { name: path.basename(file, '.md') }; } catch (err) { if (err.code !== 'EEXIST') throw err; }
      }
      return { error: 'Too many notes have this name.' };
    }
    if (how === 'put') { await fs.promises.writeFile(noteFile(name), text); return { name }; }
    let old = null;
    try { old = await fs.promises.readFile(noteFile(name), 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (old === null) await fs.promises.writeFile(noteFile(name), (typeof head === 'string' ? head : '') + text, { flag: 'wx' });
    else if (!old.includes(text)) await fs.promises.appendFile(noteFile(name), (old.endsWith('\n') ? '' : '\n') + text);
    return { name };
  } catch (err) {
    return { error: err.code === 'ENOSPC' ? 'the disk is full' : err.message };
  }
});
ipcMain.handle('memory-open', async (e) => {
  if (!fromMain(e)) return null;
  await fs.promises.mkdir(VAULT, { recursive: true });
  return shell.openPath(VAULT); // '' when it opened
});

// ---------------------------------------------------------------- Homework, Fill a form
// The form (a Microsoft Forms homework from Teams, say) opens in a normal window the user sees and uses: its own
// persistent session, so a Microsoft sign-in is done once, and no content protection (applyProtection never touches
// it): it is the user's own web page. src/formfill.mjs runs in it in an isolated world to read the questions, show the
// Maverick cursor and select an option or type an answer (never a file), and to click Submit, once per opened form and only when the page asks
// (src/app.mjs sends that only after the user typed yes or pressed Submit in the review).
const FORM_PARTITION = 'persist:homework-web';
const FORM_WORLD = 1001;
let formfill = null; // src/formfill.mjs, loaded at start
let formWin = null;
let formSubmitted = false;
const formRun = (args, gesture = false) => formWin.webContents.executeJavaScriptInIsolatedWorld(FORM_WORLD,
  [{ code: `(${formfill.formScript})(${args.map((a) => JSON.stringify(a)).join(', ')})` }], gesture);
ipcMain.handle('form-open', async (e, u) => {
  if (!fromMain(e) || typeof u !== 'string' || u.length > 4000) return null;
  let url;
  try { url = new URL(u.trim()); } catch { return { error: 'That is not a web link.' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Only http and https links open here.' };
  if (!formWin || formWin.isDestroyed()) {
    formWin = new BrowserWindow({ width: 1000, height: 860, title: 'Homework form', icon: ICON, autoHideMenuBar: true, webPreferences: { partition: FORM_PARTITION, sandbox: true, contextIsolation: true } });
    formWin.removeMenu();
    // a link that opens a new window (a sign-in popup) opens here instead, http and https only
    formWin.webContents.setWindowOpenHandler(({ url: next }) => { if (/^https?:/i.test(next)) formWin.loadURL(next).catch(() => {}); return { action: 'deny' }; });
    formWin.on('closed', () => { formWin = null; });
  }
  formSubmitted = false;
  formWin.show();
  try { await formWin.loadURL(url.href); } catch (err) { if (!/ERR_ABORTED/.test(err.message)) return { error: `The form did not load: ${err.message}` }; }
  return { ok: true };
});
const formReady = () => !!formWin && !formWin.isDestroyed() && !!formfill;
ipcMain.handle('form-read', async (e) => {
  if (!fromMain(e)) return null;
  if (!formReady()) return { error: 'Open the form first: paste its link and press Open.' };
  try { return await formRun(['read']); } catch (err) { return { error: `The form could not be read: ${err.message}` }; }
});
ipcMain.handle('form-fill', async (e, i, j) => {
  if (!fromMain(e) || !Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i > 999 || j > 99) return null;
  if (!formReady()) return { error: 'The form window was closed.' };
  try { return await formRun(['fill', i, j], true); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('form-type', async (e, i, text) => {
  if (!fromMain(e) || !Number.isInteger(i) || i < 0 || i > 999 || typeof text !== 'string' || text.length > 20000) return null;
  if (!formReady()) return { error: 'The form window was closed.' };
  try { return await formRun(['type', i, text], true); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('form-submit', async (e) => {
  if (!fromMain(e)) return null;
  if (!formReady()) return { error: 'The form window was closed.' };
  if (formSubmitted) return { error: 'This form was already submitted once; Maverick never submits again.' };
  formSubmitted = true; // before the click: a failed or unclear submit is never retried
  try { return await formRun(['submit'], true); } catch (err) { return { error: err.message }; }
});

// ---------------------------------------------------------------- start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // no default menu keys (Ctrl+W closes, Ctrl+R reloads) in any window
    const port = await freePort(state.port);
    if (!port) throw new Error('No free port on 127.0.0.1');
    if (port !== state.port) { state.port = port; save(); }
    process.env.PORT = String(port);
    await import(pathToFileURL(path.join(ROOT, 'serve.mjs')).href);
    canary = await import(pathToFileURL(path.join(ROOT, 'src', 'canary.mjs')).href);
    recording = await import(pathToFileURL(path.join(ROOT, 'src', 'recording.mjs')).href);
    formfill = await import(pathToFileURL(path.join(ROOT, 'src', 'formfill.mjs')).href);
    readRemoteSession(await import(pathToFileURL(path.join(ROOT, 'src', 'copilot.mjs')).href));
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Share meeting: no picker. The primary screen with system audio (Windows loopback), or the window
    // chosen in Settings. Audio is whatever plays on this PC; for a window, src/app.mjs swaps in that app's own sound
    // (app-audio-start 'shared') when Windows can.
    // A download from the page (History, Homework Export) is a blob: URL: the save dialog gets the file's name as its title.
    session.defaultSession.on('will-download', (_e, item) => {
      const name = item.getFilename();
      item.setSaveDialogOptions({ title: `Save ${name}`, defaultPath: path.join(app.getPath('downloads'), name) });
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const want = state.source || '';
        const sources = await listSources(want ? ['window', 'screen'] : ['screen']);
        const primary = String(screen.getPrimaryDisplay().id);
        let pick = want && sources.find((s) => s.name === want);
        if (want && !pick) main?.webContents.send('notice', `The window "${want}" was not found, so the primary screen is shared instead.`);
        pick ||= sources.find((s) => s.display_id === primary) || sources.find((s) => s.id.startsWith('screen:'));
        sharedSource = pick ? { id: pick.id, name: pick.name } : null;
        if (!pick?.id.startsWith('window:')) stopViewProbe();
        callback(pick ? { video: pick, audio: 'loopback' } : {});
      } catch (e) {
        console.warn(`Screen capture failed: ${e.message}`);
        callback({});
      }
    });

    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => { screenIds = null; });
    syncTray();
    registerKeys();
    await createMain(port);
  });
  // For test/glass-proof.mjs and test/feature-proof.mjs only: the tray menu and the tray without clicking the real
  // notification area, and the share check on demand, or held so the badge stays put while it is photographed.
  if (process.env.MAVERICK_TEST_HOOKS === '1') {
    global.maverickDesk = {
      openMenu, menu: () => menuWin, tray: () => tray, dropTray: () => { tray?.destroy(); tray = null; }, menuShown: () => !!menuWin?.isVisible(),
      checkShare, holdShare: (on) => { shareHeld = !!on; }, hotkey: onHotkey,
    };
  }
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); recClose(0); stopViewProbe(); });
  app.on('window-all-closed', () => app.quit());
}
