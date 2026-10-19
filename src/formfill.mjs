// Homework, Fill a form: the one script desktop/main.cjs runs inside the form window, in an isolated world (the page's
// own scripts cannot see or change it). It is sent as source text, so it uses nothing outside itself.
//   formScript('read')            -> { url, title, signin, captcha, submit, questions: [...] }, in page order, each
//       { i, kind, text, required } and for kind 'choice' { multi, options: [{ j, label, checked }] }, for 'text'
//       { long, max, value }, for 'upload' { files: [names] }
//   formScript('fill', i, j)      -> { checked }: the Maverick cursor moves to question i, then option j, and selects it
//   formScript('type', i, text)   -> { value }: the cursor moves to text question i, and the text goes into its box
//   formScript('submit')          -> { clicked, label }: one click on the form's Submit button
//   formScript('done')            -> removes the cursor
// Choice questions are radio and checkbox groups, ARIA (role=radiogroup with role=radio, as Microsoft Forms marks them) or
// native. Text questions are input, textarea, role=textbox and contenteditable boxes. Uploads are file inputs: they are
// read, never filled. Clicks are element.click() in the page and typing sets the value: never the real mouse or keyboard.
export async function formScript(op, qi = -1, arg = -1) {
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const byIds = (ids) => String(ids || '').split(/\s+/).map((id) => id && document.getElementById(id)).filter(Boolean).map(text).join(' ').trim();
  const firstId = (ids) => String(ids || '').split(/\s+/).map((id) => id && document.getElementById(id)).find(Boolean) || null;
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const usable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.readOnly && el.getAttribute('aria-readonly') !== 'true';
  const innermost = (list) => list.filter((o) => !list.some((x) => x !== o && o.contains(x)));
  // the nearest element with text before el, walking up: a question's title when nothing labels it
  const before = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      for (let s = a.previousElementSibling; s; s = s.previousElementSibling) if (text(s)) return s;
    }
    return null;
  };

  // ---- choice questions: options grouped by their radiogroup, group or fieldset, else by name
  const OPT = '[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]';
  // innermost only: a role=radio wrapper around a native radio is one option, the input
  const opts = innermost([...document.querySelectorAll(OPT)]).filter((o) => (shown(o) || shown(o.closest('label'))) && usable(o));
  const labelOf = (o) => (o.getAttribute('aria-label') || byIds(o.getAttribute('aria-labelledby'))
    || (o.id && text(document.querySelector(`label[for="${CSS.escape(o.id)}"]`))) || text(o.closest('label')) || text(o) || o.value || '').trim();
  const checked = (o) => (o.matches('input') ? o.checked : o.getAttribute('aria-checked') === 'true');
  const items = [];
  for (const o of opts) {
    const key = o.closest('[role="radiogroup"], [role="group"], fieldset') || (o.name ? `name:${o.name}` : o.parentElement);
    let g = items.find((x) => x.key === key);
    // a group of native radios by name has no box of its own: its first option stands for it (its title is the text before)
    if (!g) items.push(g = { kind: 'choice', key, el: typeof key === 'string' ? o.closest('label') || o : key, opts: [] });
    g.opts.push(o);
  }
  for (const g of items) {
    // the title: what labels the group, its legend, or the nearest text before it
    const legend = g.el.querySelector?.(':scope > legend');
    g.head = firstId(g.el.getAttribute?.('aria-labelledby')) || (text(legend) ? legend : null) || before(g.el);
    g.title = g.el.getAttribute?.('aria-label') || byIds(g.el.getAttribute?.('aria-labelledby')) || text(g.head);
  }
  const inChoice = (el) => items.some((g) => g.el.contains?.(el));

  // ---- text and upload questions: one box each
  const FIELD = 'textarea, [role="textbox"], [contenteditable=""], [contenteditable="true"], input:not([type]), input[type="text"], input[type="number"], ' +
    'input[type="email"], input[type="url"], input[type="tel"]';
  const fieldHead = (el) => firstId(el.getAttribute('aria-labelledby')) || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || before(el);
  const fieldTitle = (el, head) => byIds(el.getAttribute('aria-labelledby')) || text(head) || el.getAttribute('aria-label') || el.placeholder || '';
  for (const el of innermost([...document.querySelectorAll(FIELD)]).filter((x) => shown(x) && usable(x) && !inChoice(x))) {
    const head = fieldHead(el);
    items.push({ kind: 'text', el, head, title: fieldTitle(el, head) });
  }
  for (const el of document.querySelectorAll('input[type="file"]')) {
    const head = fieldHead(el);
    items.push({ kind: 'upload', el, head, title: fieldTitle(el, head) });
  }
  items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const valueOf = (el) => (el.matches('input, textarea') ? el.value : text(el));
  const required = (q) => [q.el, ...(q.opts || [])].some((x) => x.required || x.getAttribute?.('aria-required') === 'true')
    || !!q.el.closest?.('[aria-required="true"]') || /\*\s*$/.test(text(q.head)) || !!q.head?.parentElement?.querySelector('[aria-label*="required" i]');

  const submitBtn = () => document.querySelector('[data-automation-id="submitButton"], button[type="submit"], input[type="submit"]')
    || [...document.querySelectorAll('button, [role="button"]')].find((b) => /^(submit|send|إرسال|ارسال)$/i.test(text(b)));
  const cursor = () => {
    let c = document.getElementById('maverick-cursor');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'maverick-cursor';
    const arrow = document.createElement('div');
    const tag = document.createElement('div');
    tag.textContent = 'Maverick';
    // CSSOM, not style attributes or innerHTML: a page's CSP or Trusted Types do not block it
    const css = (el, o) => { for (const [k, v] of Object.entries(o)) el.style.setProperty(k, v, 'important'); };
    css(c, { position: 'fixed', left: '0', top: '0', 'z-index': '2147483647', 'pointer-events': 'none', transform: `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`, transition: 'transform 600ms cubic-bezier(.2,.7,.2,1)' });
    css(arrow, { width: '22px', height: '26px', background: '#7c3aed', 'clip-path': 'polygon(0 0, 100% 62%, 52% 64%, 34% 100%)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' });
    css(tag, { margin: '2px 0 0 14px', padding: '2px 8px', 'border-radius': '9px', background: '#7c3aed', color: '#fff', font: '600 12px/16px "Segoe UI", sans-serif', 'white-space': 'nowrap' });
    c.append(arrow, tag);
    document.documentElement.append(c);
    return c;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The question into view, then the cursor to its title and on to the target: it moves for every answer, also when
  // two in a row sit at the same place on the screen.
  const moveTo = async (head, target) => {
    head.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await sleep(150);
    const c = cursor();
    for (const [el, ms] of [[head, 450], [target, 700]]) {
      const r = el.getBoundingClientRect();
      c.style.setProperty('transform', `translate(${Math.round(r.left + Math.min(r.width / 2, 12))}px, ${Math.round(r.top + Math.min(r.height / 2, 14))}px)`, 'important');
      await sleep(ms);
    }
  };

  if (op === 'read') {
    document.getElementById('maverick-cursor')?.remove(); // the fill is over: the review reads the form
    const pw = [...document.querySelectorAll('input[type="password"]')].some(shown);
    return {
      url: location.href, title: document.title,
      signin: pw || /(^|\.)(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com)$/i.test(location.hostname),
      captcha: !!document.querySelector('iframe[src*="captcha" i], iframe[title*="captcha" i], .g-recaptcha, .h-captcha, [id*="captcha" i]'),
      submit: !!submitBtn(),
      questions: items.map((q, i) => ({
        i, kind: q.kind, text: q.title, required: required(q),
        ...(q.kind === 'choice' ? { multi: q.opts.some((o) => o.matches('[role="checkbox"], input[type="checkbox"]')), options: q.opts.map((o, j) => ({ j, label: labelOf(o), checked: checked(o) })) }
          : q.kind === 'text' ? { long: q.el.matches('textarea') || (!q.el.matches('input') && q.el.getAttribute('aria-multiline') !== 'false'), max: q.el.maxLength > 0 ? q.el.maxLength : 0, value: valueOf(q.el) }
            : { files: [...(q.el.files || [])].map((f) => f.name) }),
      })),
    };
  }
  if (op === 'fill') {
    const q = items[qi];
    const o = q?.kind === 'choice' ? q.opts[arg] : null;
    if (!o) return { error: 'that option is no longer on the page' };
    await moveTo(q.head || q.el, shown(o) ? o : o.closest('label'));
    if (!checked(o)) o.click();
    await sleep(150);
    return { checked: checked(o) };
  }
  if (op === 'type') {
    const q = items[qi];
    if (q?.kind !== 'text') return { error: 'that text box is no longer on the page' };
    const el = q.el;
    await moveTo(q.head || el, el);
    el.focus();
    if (el.matches('input, textarea')) {
      // the native setter, then input and change: a React-controlled box takes it as typing
      Object.getOwnPropertyDescriptor(el.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, String(arg));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = String(arg);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(arg) }));
    }
    el.blur();
    await sleep(150);
    return { value: valueOf(el) };
  }
  if (op === 'submit') {
    document.getElementById('maverick-cursor')?.remove();
    const b = submitBtn();
    if (!b) return { clicked: false };
    b.click();
    return { clicked: true, label: text(b) || b.value || '' };
  }
  if (op === 'done') document.getElementById('maverick-cursor')?.remove();
  return {};
}
