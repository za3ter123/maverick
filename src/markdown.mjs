// Tiny markdown renderer. Escapes ALL HTML first, then adds a fixed set of tags,
// so model output can never inject markup. No links on purpose.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Typographic quotes in prose (code keeps its straight ones): an opening quote after a space, a bracket or the start,
// a closing one everywhere else, and an apostrophe for every single quote that is not opening one.
const curly = (s) => s
  .replace(/(^|[\s(\[\u2014-])&quot;/g, '$1\u201C').replace(/&quot;/g, '\u201D')
  .replace(/(^|[\s(\[\u2014-])&#39;(?=\w)/g, '$1\u2018').replace(/&#39;/g, '\u2019');

// LaTeX the models write ($s = \frac{1}{2} g t^2$) as plain math: \times ×, \cdot ·, \div ÷, \frac{a}{b} (a)/(b), ^{n} ^n.
export function latexMath(s) {
  return String(s ?? '')
    .replace(/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\div/g, '÷')
    .replace(/\\(?:le|leq)\b/g, '≤').replace(/\\(?:ge|geq)\b/g, '≥').replace(/\\(?:ne|neq)\b/g, '≠').replace(/\\approx\b/g, '≈').replace(/\\pm\b/g, '±')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)').replace(/\\text\{([^{}]*)\}/g, '$1').replace(/\\left|\\right/g, '').replace(/\\,|\\;|\\!/g, ' ')
    .replace(/\^\{([^{}]+)\}/g, '^$1').replace(/_\{([^{}]+)\}/g, '_$1');
}

// Math inside right-to-left (Arabic) text: each formula is isolated left to right in <bdi dir="ltr">, so the bidi
// algorithm cannot reorder it ("5 - 3 = 2" read as "2 = 3 - 5") or mirror its brackets. A formula is $...$ or \(...\),
// or a run of numbers, terms like 5x, single-letter variables and operators with at least one operator between two
// operands; a whole equation ("5x - 3 = 2x + 9") is one run. Powers are raised (x^2 to x<sup>2</sup>). Works on escaped
// HTML. TeX delimiters ($3x = 18$) never show, in any language: their content becomes plain math, isolated only in
// Arabic text. A $ is TeX only when a non-space follows the opening one and precedes the closing one, and no digit
// follows the closing one, so prices ("$5 and $10") stay as they are.
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const OPERAND = String.raw`(?:[\d٠-٩]+(?:[.,٫][\d٠-٩]+)*(?:[%٪]|[A-Za-zπθα-ω]{1,2}(?![A-Za-z]))?|[A-Za-zπθα-ω](?![A-Za-z]))(?:\^-?\w+|[²³])?`;
const MOP = String.raw`(?:[=+\-−×÷*/^≤≥≈≠±·]|&lt;|&gt;)`;
const TERM = String.raw`(?:√)?(?:[-−](?=[\d٠-٩A-Za-z(]))?\(*${OPERAND}\)*`;
const RUN = new RegExp(String.raw`(?<![\w.,&;])${TERM}(?:\s*${MOP}\s*${TERM})+(?![\w])`, 'g');
const TEX = /(\$\$[^$]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s$]\$(?!\d)|\$[^\s$]\$(?!\d)|\\\([^\n]+?\\\)|\\\[[^\n]+?\\\])/;
const sup = (m) => m.replace(/\^(-?\w+)/g, '<sup>$1</sup>');
const ltr = (m) => `<bdi dir="ltr">${sup(m)}</bdi>`;
export function isolateMath(escaped) {
  const s = String(escaped);
  const rtl = ARABIC_LETTER.test(s);
  return s.split(TEX).map((p, i) => {
    if (i % 2) { const m = latexMath(p.replace(/^\$\$?|\$\$?$|^\\[([]|\\[)\]]$/g, '')).trim(); return rtl ? ltr(m) : sup(m); }
    return rtl ? p.replace(RUN, (m) => (/[\d٠-٩]|[=<>≤≥]|&[lg]t;/.test(m) ? ltr(m) : m)) : p;
  }).join('');
}


function inline(escaped) {
  return escaped.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return `<code${ARABIC_LETTER.test(escaped) ? ' dir="ltr"' : ''}>${part.slice(1, -1)}</code>`;
    return isolateMath(curly(part))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  }).join('');
}

// While an answer streams, a mark that has opened but not closed yet (**bold, `code, a [12:40] citation) is held
// back until it closes, so raw asterisks and brackets never flash on screen. Code blocks are left alone.
export function holdOpen(md) {
  let s = String(md ?? '');
  if ((s.match(/```/g) || []).length % 2) return s;
  const cutAt = (i) => { if (i >= 0) s = s.slice(0, i); };
  if ((s.match(/\*\*/g) || []).length % 2) cutAt(s.lastIndexOf('**'));
  if ((s.replace(/```/g, '').match(/`/g) || []).length % 2) cutAt(s.lastIndexOf('`'));
  if (s.lastIndexOf('[') > s.lastIndexOf(']')) cutAt(s.lastIndexOf('['));
  s = s.replace(/(^|[^*\n])\*$/, '$1'); // the first half of a ** that has not arrived yet
  return s.replace(/(^|\n)[ \t]*>[ \t]*["'\u201C\u2018]?[ \t]*$/, '$1'); // a quote block waits for its first word
}

// bidi (answer cards, the notes, History): a block with Arabic in it takes its direction from its first strong letter,
// so an Arabic answer reads right to left. A block that starts with a Latin label ("**00:20 Speaker 1:**", "*Arabic:*",
// as History's transcript lines and subtitles do) and goes on in Arabic keeps the label's direction, and the Arabic after
// it is isolated in <bdi dir="auto">, so its words and its full stop stay in Arabic order (acceptance defect 13). An
// Arabic label ("**تصحيح:**") is part of an Arabic block like any other word. Without bidi, as before.
const LABELLED = /^(\*\*[^*]+?:\*\*|\*[^*]+?:\*)\s+(.+)$/;
const latinLabel = (text) => { const m = text.match(LABELLED); return m && !ARABIC_LETTER.test(m[1]) && ARABIC_LETTER.test(m[2]) ? m : null; };
export function renderMarkdown(md, { bidi = false } = {}) {
  const da = (text) => (bidi && ARABIC_LETTER.test(text) && !latinLabel(text) ? ' dir="auto"' : '');
  const body = (text) => {
    const m = bidi && latinLabel(text);
    return m ? `${inline(m[1])} <bdi dir="auto">${inline(m[2])}</bdi>` : inline(text);
  };
  const out = [];
  let para = [];
  let list = null;
  let code = null;
  let quote = [];
  const flushQuote = () => {
    if (!quote.length) return;
    const paras = quote.join('\n').split(/\n\s*\n/).map((q) => q.replace(/\n/g, ' ').trim()).filter(Boolean);
    out.push(`<blockquote>${paras.map((q) => `<p${da(q)}>${inline(q)}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  const flush = () => { flushQuote(); if (para.length) { out.push(`<p${da(para.join(' '))}>${body(para.join(' '))}</p>`); para = []; } };
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const open = (tag) => { if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; } };

  for (const raw of String(md ?? '').split('\n')) {
    if (code) {
      if (/^\s*```/.test(raw)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { flush(); close(); code = []; continue; }
    const line = escapeHtml(raw);
    let m;
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) { if (!quote.length) { flush(); close(); } quote.push(m[1]); continue; }
    flushQuote();
    if (!line.trim()) { flush(); close(); }
    else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); close(); const h = Math.min(m[1].length + 2, 5); out.push(`<h${h}${da(m[2])}>${inline(m[2])}</h${h}>`); }
    else if ((m = line.match(/^\s*[-*+]\s+(?:\[( |x)\]\s+)?(.*)$/i))) {
      flush(); open('ul');
      const box = m[1] === undefined ? '' : `<span class="check${m[1] === ' ' ? '' : ' done'}"></span>`;
      out.push(`<li${da(m[2])}>${box}${body(m[2])}</li>`);
    }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); open('ol'); out.push(`<li${da(m[1])}>${inline(m[1])}</li>`); }
    else { close(); para.push(line.trim()); }
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush(); close();
  return out.join('');
}

// [12:40] or [12:40, 13:05] in an answer becomes buttons that scroll the transcript to that line.
export const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
// A citation reads as a footnote: it goes after the sentence's punctuation, touching it, never after a bare word
// ("Thursday [10:52]." becomes "Thursday.[10:52]"), so a time never reads as the time of that word.
const CITE = String.raw`\[${TIME}(?:\s*[,;]\s*${TIME})*\]`;
const placeCites = (html) => html
  .replace(new RegExp(String.raw`\s*(${CITE})([.,;:!?])`, 'g'), '$2$1')
  .replace(new RegExp(String.raw`\s+(${CITE})(?=</(?:p|li)>)`, 'g'), '$1');
// Answer cards pass `here` and `earlier`. here(t): whether t is a moment of this meeting (a line or a screen read at it);
// earlier: the earlier meetings the prompt gave ([{ id, title, summary }], copilot.mjs, E1 first). [E1 00:20] links to
// that meeting in History, unless its notes do not cite 00:20 and this meeting has that moment (the model tagged a line
// of this meeting). A bare time that is no moment of this meeting links to the earlier meeting whose notes cite it, or is
// dropped like a bad Sources label: it must not jump to an unrelated line. Without `earlier`, [E1 00:20] stays text.
const earlierChip = (m, t) => `<button type="button" class="cite" data-cmd="earlier" data-m="${escapeHtml(m.id)}" data-t="${t}" data-tip="From the earlier meeting ${escapeHtml(m.title)}. Open it in History">${escapeHtml(m.title)}, ${t}</button>`;
const jumpChip = (t) => `<button type="button" class="cite" data-cmd="cite" data-t="${t}" data-tip="Show this moment in the transcript">${t}</button>`;
export function linkCites(html, { here = null, earlier = [] } = {}) {
  const cites = (m, t) => String(m.summary ?? '').includes(`[${t}]`);
  return placeCites(html)
    .replace(new RegExp(String.raw`\[E(\d) (${TIME})\]`, 'g'), (all, n, t) => {
      const m = earlier[n - 1];
      if (!m) return all;
      return !cites(m, t) && here?.(t) ? jumpChip(t) : earlierChip(m, t);
    })
    .replace(new RegExp(String.raw`\[(${TIME}(?:\s*[,;]\s*${TIME})*)\]`, 'g'), (_, list) => list.split(/\s*[,;]\s*/).map((t) => {
      if (!here || here(t)) return jumpChip(t);
      const m = earlier.find((e) => cites(e, t));
      return m ? earlierChip(m, t) : '';
    }).join(' '));
}
