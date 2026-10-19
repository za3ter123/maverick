// The library on this PC (browser side): files the user adds, read into pages of text, cut into chunks, embedded, and
// kept in IndexedDB ("maverick-library"), never in localStorage. PDFs and images keep their bytes too, so a citation
// can open them. Text PDFs are read with PDF.js page by page; a page with little or no text layer (a scan) is rendered
// and read by the vision model, as are images. .docx is unzipped here (library.mjs); .txt and .md are read as UTF-8.
// The models come in from app.mjs: read(prompt, jpegBase64) -> text, and embed(texts) -> vectors.

import { chunkPage, docxPages, joinItems, rankChunks, tokens, unzipEntry } from './library.mjs';

const DB = 'maverick-library';
const PDFJS = '/node_modules/pdfjs-dist/build/pdf.min.mjs';
const PDF_WORKER = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
export const KINDS = { pdf: ['pdf'], image: ['png', 'jpg', 'jpeg', 'webp'], docx: ['docx'], text: ['txt', 'md'] };
export const ACCEPT = Object.values(KINDS).flat().map((e) => `.${e}`).join(',');
export const MAX_BYTES = 60 * 1024 * 1024;
const SCANNED_CHARS = 25; // a page with fewer letters than this in its text layer is read as an image
export const EMBED_DOC = (name, text) => `title: ${name} | text: ${text}`; // embeddinggemma's document prompt
export const EMBED_QUERY = (q) => `task: search result | query: ${q}`;
export const READ_PROMPT = 'Read all the text in this image, in Arabic and English, exactly as written. Keep the layout: one line per printed line, ' +
  'headings and list items on their own lines, tables as rows with | between cells. If there is a diagram, chart or photo, add one short line ' +
  'starting "Figure:" that describes it. Output only that, with no comments.';

export const lib = { files: [], chunks: [] }; // in memory: file records, and the ready chunks with their vectors and tokens
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('chunks', { keyPath: 'id' }).createIndex('file', 'fileId');
      d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const out = fn(...[stores].flat().map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was cancelled'));
  });
}
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());

const prep = (c, name) => ({ ...c, name, tokens: tokens(c.text) });
// Loads the library. A file left in "reading" or "indexing" by a closed window is marked failed, with the reason.
export async function openLibrary() {
  const files = (await getAll('files')).sort((a, b) => a.addedAt - b.addedAt);
  for (const f of files.filter((x) => x.status === 'reading' || x.status === 'indexing')) {
    Object.assign(f, { status: 'failed', error: 'Maverick closed before this file was ready. Remove it and add it again.' });
    await tx('files', 'readwrite', (s) => s.put(f));
  }
  const names = new Map(files.map((f) => [f.id, f.name]));
  lib.files = files;
  lib.chunks = (await getAll('chunks')).filter((c) => names.has(c.fileId)).map((c) => prep(c, names.get(c.fileId)));
  changed();
}

export const kindOf = (name) => Object.entries(KINDS).find(([, ext]) => ext.includes(String(name).split('.').pop().toLowerCase()))?.[0] || '';
export const totalBytes = () => lib.files.reduce((n, f) => n + (f.size || 0), 0);

async function save(f) { await tx('files', 'readwrite', (s) => s.put(f)); changed(); }

// Adds files one after another: reading, then indexing, then ready, or failed with the reason. Duplicates (same name
// and size) are skipped.
export async function addFiles(list, models) {
  for (const file of list) {
    if (lib.files.some((f) => f.name === file.name && f.size === file.size)) continue;
    const f = { id: crypto.randomUUID(), name: file.name, size: file.size, kind: kindOf(file.name), mime: file.type, addedAt: Date.now(), status: 'reading', error: '', pages: [], read: [] };
    lib.files.push(f);
    try {
      if (!f.kind) throw new Error('Maverick reads PDF, PNG, JPG, WebP, .docx, .txt and .md files');
      if (file.size > MAX_BYTES) throw new Error(`Larger than ${MAX_BYTES / 1024 / 1024} MB`);
      await save(f);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (f.kind === 'pdf' || f.kind === 'image') await tx('blobs', 'readwrite', (s) => s.put({ id: f.id, bytes, mime: file.type }));
      f.pages = await readPages(f, bytes, models, async () => { await save(f); });
      if (!f.pages.some((p) => p.trim())) throw new Error('No text was found in it');
      f.status = 'indexing';
      await save(f);
      const chunks = f.pages.flatMap((text, i) => chunkPage(text, i + 1)).map((c, n) => ({ ...c, id: `${f.id}:${n}`, fileId: f.id }));
      for (let i = 0; i < chunks.length; i += 16) {
        const part = chunks.slice(i, i + 16);
        const vecs = await models.embed(part.map((c) => EMBED_DOC(f.name, c.text)));
        part.forEach((c, k) => { c.vec = Float32Array.from(vecs[k]); });
      }
      await tx('chunks', 'readwrite', (s) => { for (const c of chunks) s.put(c); });
      lib.chunks.push(...chunks.map((c) => prep(c, f.name)));
      f.status = 'ready';
      f.chunks = chunks.length;
      await save(f);
    } catch (e) {
      f.status = 'failed';
      f.error = String(e?.message || e).replace(/\.$/, '');
      await save(f).catch(() => changed());
    }
  }
}

async function pdfjs() {
  const p = await import(PDFJS);
  p.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  return p;
}
const toBase64 = async (blob) => (await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); })).split(',')[1];
async function canvasJpeg(canvas) { return toBase64(await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))); }

// Pages of text. f.read lists the pages the vision model read (scans and images), for the library row. Homework reads
// a worksheet with it too (app.mjs, addWorksheet).
export async function readPages(f, bytes, models, progress) {
  if (f.kind === 'text') return [new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n')];
  if (f.kind === 'docx') {
    const xml = await unzipEntry(bytes, 'word/document.xml');
    if (!xml) throw new Error('This .docx has no document text (word/document.xml is missing)');
    return docxPages(new TextDecoder().decode(xml));
  }
  if (f.kind === 'image') {
    // At most 1600 px on the long side: enough for the model to read a page, and a sane request size.
    const bmp = await createImageBitmap(new Blob([bytes], { type: f.mime || 'image/png' }));
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    f.read = [1];
    return [await models.read(READ_PROMPT, await canvasJpeg(c))];
  }
  const task = (await pdfjs()).getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { text } = joinItems((await page.getTextContent()).items);
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length >= SCANNED_CHARS) { pages.push(text); continue; }
    const vp = page.getViewport({ scale: Math.min(2.5, 1600 / page.getViewport({ scale: 1 }).width) });
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
    await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
    f.read.push(n);
    await progress();
    pages.push(await models.read(READ_PROMPT, await canvasJpeg(canvas)));
  }
  await task.destroy(); // PDF.js 6: the loading task, not the document, ends the worker's copy
  return pages;
}

export async function removeFile(id) {
  await tx(['files', 'chunks', 'blobs'], 'readwrite', (files, chunks, blobs) => {
    files.delete(id);
    blobs.delete(id);
    const r = chunks.index('file').openKeyCursor(IDBKeyRange.only(id));
    r.onsuccess = () => { const cur = r.result; if (cur) { chunks.delete(cur.primaryKey); cur.continue(); } };
  });
  lib.files = lib.files.filter((f) => f.id !== id);
  lib.chunks = lib.chunks.filter((c) => c.fileId !== id);
  changed();
}

// The top chunks for a question, ranked by keywords and by meaning (library.mjs, rankChunks).
export async function search(query, embed, k = 6) {
  if (!lib.chunks.length) return [];
  const [qvec] = await embed([EMBED_QUERY(query)]);
  return rankChunks(query, Float32Array.from(qvec), lib.chunks, k);
}

export const fileById = (id) => lib.files.find((f) => f.id === id);
export const blobOf = (id) => tx('blobs', 'readonly', (s) => s.get(id));

// The viewer: one PDF page drawn into `canvas` at `scale` CSS px per PDF unit (times the screen's pixel ratio), and the
// boxes (CSS px) of the text items that overlap characters [start, end) of that page's text, to highlight them.
export async function renderPdfPage(fileId, n, canvas, width, range) {
  const { bytes } = await blobOf(fileId);
  const task = (await pdfjs()).getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(vp.width * dpr);
    canvas.height = Math.ceil(vp.height * dpr);
    canvas.style.setProperty('width', `${vp.width}px`);
    canvas.style.setProperty('height', `${vp.height}px`);
    await page.render({ canvas, viewport: vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0], background: '#ffffff' }).promise;
    const { items } = await page.getTextContent();
    const { at, len } = joinItems(items);
    const boxes = [];
    if (range) {
      items.forEach((it, i) => {
        if (typeof it.str !== 'string' || !it.str.trim() || at[i] + len[i] <= range.start || at[i] >= range.end) return;
        const [x, y] = [it.transform[4], it.transform[5]];
        const h = it.height || Math.hypot(it.transform[2], it.transform[3]);
        const [x1, y1] = vp.convertToViewportPoint(x, y - h * 0.2);
        const [x2, y2] = vp.convertToViewportPoint(x + it.width, y + h);
        boxes.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
      });
    }
    return { boxes, height: vp.height };
  } finally {
    await task.destroy();
  }
}
