// node test/fit-proof.mjs   (Windows 11; no model needed)
// The main window's header and the bar's ask field fit at 100, 125 and 150 % scaling (--force-device-scale-factor), in the
// real desktop app on a temp profile (MAVERICK_USER_DATA). For each scale, over every window width from the minimum (900)
// to 1440 in 10 px steps, the header's toolbar stays on one row and never runs under the Windows caption buttons (at
// 150 % its theme button used to drop to a second row). With a meeting an hour and a half in (the widest timer), the
// bar's "Ask Maverick" placeholder fits its field (it showed "Ask Maver"). The owner's real profile is byte-identical
// afterwards; only the PIDs started here are killed. Prints "fit proof passed" only when every check passed.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'}: ${what}`); if (!ok) fails.push(what); return !!ok; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } };
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
  return Object.assign(ev, { close: () => ws.close() });
}
async function until(fn, ms, every = 300) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) { const v = await fn().catch(() => null); if (v) return v; }
  return null;
}

async function run(scale) {
  const tag = Math.round(scale * 100);
  const PORT = 9361;
  const INSPECT = 9261;
  const app = spawn(electron, ['.', `--force-device-scale-factor=${scale}`, `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`], {
    cwd: ROOT, windowsHide: false, env: { ...process.env, MAVERICK_USER_DATA: mkdtempSync(join(tmpdir(), 'maverick-fit-')), MAVERICK_BAR: 'capsule', MAVERICK_TEST_HOOKS: '1', MAVERICK_CAPTURE_VISIBLE: '' },
  });
  try {
    const list = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; } };
    const main = await cdp((await until(async () => (await list(INSPECT))[0], 30000)).webSocketDebuggerUrl);
    const M = (body) => main(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); const pg = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http')); ${body} })()`);
    const page = await cdp((await until(async () => (await list(PORT)).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1')), 30000)).webSocketDebuggerUrl);
    const bar = await cdp((await until(async () => (await list(PORT)).find((t) => t.type === 'page' && t.url === 'about:blank'), 30000)).webSocketDebuggerUrl);
    await until(() => page('!!window.maverickTest && document.documentElement.classList.contains("glass")'), 30000);
    await sleep(1500);
    const [w0, h0] = JSON.parse(await M('return JSON.stringify(pg.getSize());'));
    await page('window.maverickTest.backdate(5400000)'); // a meeting 1:30:00 in: the timer at its widest
    await sleep(1500);
    const fit = () => page(`(() => {
      const c = [...document.querySelectorAll('.controls > :not(.sep)')].filter((e) => e.offsetParent);
      const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
      return JSON.stringify({ rows: new Set(c.map((e) => Math.round(e.getBoundingClientRect().top))).size,
        over: Math.round(Math.max(...c.map((e) => e.getBoundingClientRect().right)) - (area.x + area.width)) });
    })()`).then(JSON.parse);
    const bad = [];
    for (let w = 900; w <= 1440; w += 10) {
      await M(`pg.setSize(${w}, ${h0}); return 1;`);
      await sleep(250);
      const f = await fit();
      if (f.rows !== 1 || f.over > 0) bad.push(`${w} px: ${f.rows} rows, ${f.over} px under the caption buttons`);
    }
    await M(`pg.setSize(${w0}, ${h0}); return 1;`);
    await sleep(400);
    const first = await fit();
    check(!bad.length && first.rows === 1 && first.over <= 0, `${tag} %: the header toolbar is one row clear of the caption buttons at every width 900 to 1440 px and at the first-launch ${w0} px${bad.length ? `: ${bad.slice(0, 6).join('; ')}` : ''}`);
    const ask = JSON.parse(await bar(`(() => {
      const i = document.querySelector('form.ask input'); const cs = getComputedStyle(i);
      const ctx = document.createElement('canvas').getContext('2d'); ctx.font = cs.font;
      return JSON.stringify({ text: Math.ceil(ctx.measureText(i.placeholder).width), room: Math.floor(i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        placeholder: i.placeholder, timer: document.querySelector('.bar .pill')?.textContent.trim() });
    })()`));
    check(ask.text <= ask.room, `${tag} %: the bar's "${ask.placeholder}" (${ask.text} px) fits its field (${ask.room} px) beside the timer "${ask.timer}"`);
    await M('app.quit(); return 1;').catch(() => {});
    page.close(); bar.close(); main.close();
  } finally {
    if (!(await until(async () => app.exitCode !== null, 8000, 200))) killTree(app.pid);
  }
}

for (const scale of [1, 1.25, 1.5]) await run(scale);
await sleep(1000);
check(fingerprint(REAL) === realBefore, `the real profile is untouched: ${REAL} is byte-identical before and after`);
console.log(fails.length ? `\nFAILED ${fails.length} check(s):\n- ${fails.join('\n- ')}` : '\nfit proof passed');
process.exit(fails.length ? 1 : 0);
