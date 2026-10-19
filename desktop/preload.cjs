// The only bridge between the web app and the desktop shell. The page checks for window.maverick;
// in a normal browser it is undefined and the app runs as before.
const { contextBridge, ipcRenderer } = require('electron');

// Mica window (main.cjs passes the flag on Windows 11): mark <html> before the first paint, so the solid canvas
// never flashes before the glass one.
const glass = process.argv.includes('--maverick-glass');
if (glass) {
  const mark = () => document.documentElement?.classList.add('glass');
  mark();
  document.addEventListener('readystatechange', mark, { once: true });
}

contextBridge.exposeInMainWorld('maverick', {
  glass,
  test: process.argv.includes('--maverick-test'), // MAVERICK_TEST_HOOKS=1: test/feature-proof.mjs adds transcript lines
  theme: (t) => ipcRenderer.send('theme', String(t || '')),
  barMaterial: () => ipcRenderer.sendSync('bar-material'), // 'capsule' | 'acrylic' (desktop/main.cjs)
  osTheme: () => ipcRenderer.sendSync('os-theme'), // 'light' | 'dark': Windows' own setting, whatever the app pins
  // API keys at rest (src/app.mjs, storeSettings): safeStorage in main.cjs; null when it cannot encrypt or read one
  seal: (text) => ipcRenderer.sendSync('seal', String(text)),
  unseal: (text) => ipcRenderer.sendSync('unseal', String(text)),
  // hotkeys and the tray: 'answer' | 'explain' | 'solve' | 'assist' | 'followup' | 'recap' | 'deep' | 'flag' | 'ask' | 'listen' | 'bar'
  onAction: (fn) => ipcRenderer.on('action', (_e, name) => fn(String(name))),
  onNotice: (fn) => ipcRenderer.on('notice', (_e, msg) => fn(String(msg))),
  state: (s) => ipcRenderer.send('state', { listening: !!s.listening, busy: !!s.busy }),
  barSize: (h) => ipcRenderer.send('bar-size', Number(h)),
  barMove: (dx, dy) => ipcRenderer.send('bar-move', Number(dx), Number(dy)),
  barFocus: () => ipcRenderer.send('bar-focus'),
  showMain: (focus = true) => ipcRenderer.send('show-main', focus !== false), // false: show it without taking the keyboard
  openUrl: (u) => ipcRenderer.send('open-url', String(u)), // http and https only (main.cjs checks)
  // publik API (main.cjs, desktop/publik.cjs): { disclosure, card, hasToken }, provision after the user's yes -> card | { error }, and
  // its links (https publikhq.com only). No key ever comes back.
  publikInfo: () => ipcRenderer.invoke('publik-info'),
  publikProvision: () => ipcRenderer.invoke('publik-provision'),
  publikOpen: (u) => ipcRenderer.send('publik-open', String(u)),
  settings: () => ipcRenderer.invoke('desk-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-desk-settings', s), // { keys, source, hideFromShare, hideTray, recordMode, recordSource, recordDir }
  sources: (screens) => ipcRenderer.invoke('sources', screens === true), // window names; with screens too when true
  // session recording (main.cjs writes the file): start -> { file, mode, source } | null (off) | { error }
  recStart: () => ipcRenderer.invoke('rec-start'),
  recChunk: (bytes) => ipcRenderer.invoke('rec-chunk', bytes), // Uint8Array -> { ok } | { error }
  recStop: (ms) => ipcRenderer.invoke('rec-stop', Number(ms)),
  // one app's sound (main.cjs, app-audio.exe): a window source id or 'shared' -> { id, exe } | { error, exe }
  appAudioStart: (source) => ipcRenderer.invoke('app-audio-start', String(source)),
  appAudioStop: (id) => ipcRenderer.send('app-audio-stop', Number(id)),
  onAppAudio: (fn) => ipcRenderer.on('app-audio', (_e, id, bytes) => fn(id, bytes)), // 48 kHz 16-bit stereo PCM
  pickRecordDir: () => ipcRenderer.invoke('pick-record-dir'), // the folder picked, or null
  // Homework, Fill a form (main.cjs): a visible window of its own; submit only after the user's yes (src/app.mjs)
  formOpen: (url) => ipcRenderer.invoke('form-open', String(url)),
  formRead: () => ipcRenderer.invoke('form-read'),
  formFill: (i, j) => ipcRenderer.invoke('form-fill', Number(i), Number(j)),
  formType: (i, text) => ipcRenderer.invoke('form-type', Number(i), String(text)),
  formSubmit: () => ipcRenderer.invoke('form-submit'),
  // Memory (main.cjs): the vault's notes [{ name, text, mtime }], a write ('new' | 'put' | 'add') -> { name } | { error }, the folder
  memoryList: () => ipcRenderer.invoke('memory-list'),
  memoryWrite: (name, text, how, head) => ipcRenderer.invoke('memory-write', String(name), String(text), String(how), head == null ? null : String(head)),
  memoryOpen: () => ipcRenderer.invoke('memory-open'),
  // the "Hidden" badge: main.cjs checks a real screen capture for the bar; checkShare runs one now
  checkShare: () => ipcRenderer.invoke('share-check'),
  onShareCheck: (fn) => ipcRenderer.on('share-check', (_e, r) => fn(r)),
  // the shared window (main.cjs, shareView): { state: 'screen' | 'shown' | 'covered' | 'minimized' | 'gone' | 'unknown', name }
  shareView: () => ipcRenderer.invoke('share-view'),
  shareStopped: () => ipcRenderer.send('share-stopped'),
});
