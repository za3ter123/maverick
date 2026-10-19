// Test harness only: a busy full-screen backdrop for the bar's glass screenshots (test/glass-proof.mjs).
// Left half a Windows wallpaper photo, right half a white document with coloured text, so the bar is seen
// over dark and light content at once. It floats above normal windows and below the bar.
//   npx electron test/glass-backdrop.cjs
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const { bounds } = screen.getPrimaryDisplay();
  const w = new BrowserWindow({ ...bounds, frame: false, focusable: false, skipTaskbar: true, show: false, title: 'Maverick glass backdrop' });
  w.setAlwaysOnTop(true, 'normal');
  w.loadFile(path.join(__dirname, 'glass-backdrop.html'));
  w.once('ready-to-show', () => w.showInactive());
});
