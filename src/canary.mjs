// The canary behind the "Hidden" badge: a fixed strip of grey cells drawn inside the desktop bar (app.mjs openBar,
// bar.css .canary). desktop/main.cjs captures the display the bar is on and looks for the strip where the bar is.
// Pure: pixels in, yes or no out. Bitmaps are 4 bytes a pixel (BGRA from Electron's toBitmap, or RGBA): the order does
// not matter, because the cells are grey and only their brightness is compared.

// 1 is a bright cell, 0 a dark one. Not periodic, so stripes or text do not match it shifted by a cell.
export const CANARY = [1, 0, 1, 1, 0, 0, 1, 0];

// Looks for the strip with its top-left near (x, y), in pixels of the bitmap, cells `cell` pixels wide and `h` tall,
// at every offset up to `slack` pixels each way (window positions and display scaling round). A match: each cell's
// centre is grey (channels within 12), the bright cells agree with each other and so do the dark ones (within 16),
// and the darkest bright cell is at least 24 levels above the brightest dark one.
export function findCanary(px, width, height, { x, y, cell, h }, slack = 3) {
  for (let dy = -slack; dy <= slack; dy++) {
    for (let dx = -slack; dx <= slack; dx++) if (matchAt(px, width, height, x + dx, y + dy, cell, h)) return { found: true, dx, dy };
  }
  return { found: false };
}

function matchAt(px, width, height, x, y, cell, h) {
  const row = Math.floor(y + h / 2);
  if (row < 0 || row >= height) return false;
  const on = [];
  const off = [];
  for (const [i, bit] of CANARY.entries()) {
    const col = Math.floor(x + (i + 0.5) * cell);
    if (col < 0 || col >= width) return false;
    const o = (row * width + col) * 4;
    const c = [px[o], px[o + 1], px[o + 2]];
    if (Math.max(...c) - Math.min(...c) > 12) return false;
    (bit ? on : off).push((c[0] + c[1] + c[2]) / 3);
  }
  const spread = (v) => Math.max(...v) - Math.min(...v);
  return spread(on) <= 16 && spread(off) <= 16 && Math.min(...on) - Math.max(...off) >= 24;
}

// The share of pixels in a box that are black (every channel 8 or less). Before Windows 10 2004 a protected window
// shows in captures as a black box instead of disappearing, so a black bar is as visible as the bar itself.
export function blackShare(px, width, height, box) {
  let n = 0;
  let black = 0;
  for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.height); y++) {
    for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.width); x++) {
      const o = (y * width + x) * 4;
      n++;
      if (px[o] <= 8 && px[o + 1] <= 8 && px[o + 2] <= 8) black++;
    }
  }
  return n ? black / n : 0;
}
