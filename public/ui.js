/* DOM helpers and the component vocabulary the whole console is built from.
 *
 * Plain DOM rather than a framework: the console is what you open when
 * something is wrong, so it should have as few moving parts as possible and
 * nothing it has to fetch to render.
 */

// ── Elements ────────────────────────────────────────────────────────────────

/**
 * Append children, skipping the empty ones.
 *
 * `Element.append(null)` stringifies to the text "null" and renders it, which
 * is how stray "null"s once appeared next to buttons wherever a conditional
 * child was passed. Everything that builds DOM goes through here or `el`.
 */
export function mount(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }

  return mount(node, ...children);
}

export function frag(...children) {
  return mount(document.createDocumentFragment(), ...children);
}

// ── Icons ───────────────────────────────────────────────────────────────────

/* 24×24 stroked paths, drawn inline. An icon font or sprite sheet would be one
 * more request that can fail; these cannot. */
const PATHS = {
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  functions: 'M4 7h16M4 12h10M4 17h7',
  roles: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87',
  models: 'M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5',
  database: 'M12 8c4.42 0 8-1.34 8-3s-3.58-3-8-3-8 1.34-8 3 3.58 3 8 3ZM4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15l2 2 4-4',
  guide: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M18 6 6 18M6 6l12 12',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  gauge: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 12l4-4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  back: 'M19 12H5M12 19l-7-7 7-7',
  chevron: 'M6 9l6 6 6-6',
  up: 'M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
  down: 'M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
  play: 'M5 3l14 9-14 9V3z',
  key: 'M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7-7 5 5 0 0 1 7 7ZM15 9l-1.5-1.5M18.5 5.5 17 4',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.activity);
  svg.append(path);
  return svg;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const fmt = {
  ms: (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString()} ms`),
  pct: (v) => `${Math.round((v || 0) * 100)}%`,
  num: (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString()),
  bytes: (v) => {
    const size = Number(v);
    if (!Number.isFinite(size) || size <= 0) return '—';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  },
  time: (v) => (v ? new Date(v).toLocaleString() : '—'),
  ago: (v) => {
    if (!v) return '—';
    const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
};

export function initials(email) {
  const name = String(email || '?').split('@')[0];
  const parts = name.split(/[._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)) || '?';
}

// ── Components ──────────────────────────────────────────────────────────────

export function pageHead(title, description, ...actions) {
  return el('div', { class: 'pagehead' },
    el('div', { class: 'pagehead__text' },
      el('h2', {}, title),
      description ? el('p', {}, description) : null),
    actions.length ? el('div', { class: 'btnrow' }, ...actions) : null);
}

export function kpi(label, value, { note, tone = '', iconName = 'activity' } = {}) {
  return el('div', { class: 'card kpi' },
    el('div', { class: 'kpi__top' },
      el('span', { class: 'kpi__label' }, label),
      el('span', { class: `kpi__icon ${tone ? `kpi__icon--${tone}` : ''}` }, icon(iconName, 15))),
    el('div', { class: 'kpi__value' }, value),
    note ? el('div', { class: 'kpi__note' }, note) : null);
}

/** A card with a header, optional toolbar buttons, and a body. */
export function panel(title, { count, tools = [], foot } = {}, ...body) {
  return el('section', { class: 'card panel' },
    el('div', { class: 'panel__head' },
      el('div', { class: 'panel__title' },
        el('h3', {}, title),
        count === undefined || count === null
          ? null
          : el('span', { class: 'count-pill' }, fmt.num(count))),
      tools.filter(Boolean).length
        ? el('div', { class: 'panel__tools' }, ...tools.filter(Boolean))
        : null),
    ...body,
    foot ? el('div', { class: 'panel__foot' }, foot) : null);
}

export function badge(text, tone = '') {
  return el('span', { class: `badge ${tone ? `badge--${tone}` : ''}` }, text);
}

/** Maps the vocabularies used across the API onto the four badge tones. */
const TONES = {
  live: 'ok', ok: 'ok', approved: 'info', enabled: 'ok', active: 'ok',
  answer: 'ok', single: 'ok', list: 'ok', completed: 'ok', success: 'ok',
  draft: '', disabled: '', off: '', empty: '', request: '',
  ambiguous: 'warn', clarification: 'warn', warn: 'warn', pending: 'warn',
  running: 'info', streaming: 'info', info: 'info',
  failed: 'bad', error: 'bad', denied: 'bad', revoked: 'bad', bad: 'bad',
};

export function statusBadge(value) {
  const key = String(value ?? '').toLowerCase();
  return badge(value ?? '—', TONES[key] ?? '');
}

export function notice(text, tone = 'info') {
  return el('div', { class: `notice notice--${tone}` }, text);
}

export function banner(tone, text, ...actions) {
  return el('div', { class: `banner ${tone ? `banner--${tone}` : ''}` },
    el('div', { class: 'banner__text' }, text),
    actions.filter(Boolean).length
      ? el('div', { class: 'btnrow' }, ...actions.filter(Boolean))
      : null);
}

export function empty(title, description, action, iconName = 'inbox') {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon(iconName, 20)),
    el('h4', {}, title),
    description ? el('p', {}, description) : null,
    action ? el('div', { class: 'btnrow' }, action) : null);
}

export function skeleton(rows = 4) {
  return el('div', { class: 'card panel' },
    el('div', { class: 'panel__body' },
      ...Array.from({ length: rows }, (_, index) =>
        el('div', {
          class: 'skeleton skel-row',
          style: `width:${[92, 74, 84, 60, 78][index % 5]}%;margin-left:0;margin-right:0`,
        }))));
}

export function button(label, { variant = '', size = '', onclick, iconName, disabled, title } = {}) {
  return el('button', {
    class: `btn ${variant ? `btn--${variant}` : ''} ${size ? `btn--${size}` : ''}`,
    onclick,
    disabled,
    title,
    type: 'button',
  }, iconName ? icon(iconName, 14) : null, label);
}

/**
 * Header labels are attached to every cell as `data-label`, which is what the
 * stylesheet uses to turn each row into a labelled card on a narrow screen.
 */
export function table(headers, rows) {
  const label = (head) => typeof head === 'string' ? head : '';

  return el('div', { class: 'tablewrap' },
    el('table', {},
      el('thead', {}, el('tr', {}, ...headers.map((head) => el('th', {}, head)))),
      el('tbody', {}, ...rows.map((cells) =>
        el('tr', {}, ...cells.map((cell, index) =>
          el('td', { 'data-label': label(headers[index]) }, cell)))))));
}

export function field(label, control, hint, { optional = false } = {}) {
  const id = `f${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;

  return el('div', { class: 'field' },
    el('label', { class: 'field__label', for: id },
      label,
      optional ? el('span', { class: 'opt' }, 'optional') : null),
    control,
    hint ? el('p', { class: 'field__hint', html: hint }) : null);
}

export function textInput(value = '', attrs = {}) {
  const node = el('input', { type: 'text', ...attrs });
  node.value = value ?? '';
  return node;
}

export function textArea(value = '', rows = 4, extraClass = '') {
  return el('textarea', { rows, class: extraClass }, value ?? '');
}

export function select(options, value) {
  const node = el('select', {}, ...options.map((option) =>
    typeof option === 'string'
      ? el('option', { value: option }, option)
      : el('option', { value: option.value }, option.label)));
  node.value = value;
  return node;
}

export function codeBlock(text, { wrap = false, tall = false } = {}) {
  const pre = el('pre', { class: `code${wrap ? ' wrap' : ''}${tall ? ' tall' : ''}` }, text);
  return el('div', { class: 'codeblock' }, pre, copyButton(text, pre));
}

function copyButton(text, pre) {
  return el('button', {
    class: 'btn btn--ghost btn--sm copy',
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied to the clipboard', 'ok');
      } catch {
        // The clipboard API needs a secure context. Over plain HTTP on a remote
        // host it is simply absent, so select the text instead of failing —
        // this SQL is the whole point of the screen showing it.
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        toast('Clipboard unavailable — the text is selected, press Ctrl+C');
      }
    },
  }, icon('copy', 13), 'Copy');
}

// ── Overlays ────────────────────────────────────────────────────────────────

export function toast(message, tone = '') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast ${tone ? `toast--${tone}` : ''}`;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 5200);
}

let closeModalHandler = null;

export function openModal(title, body, { wide = false } = {}) {
  const root = document.getElementById('modal-root');

  const card = el('div', {
    class: 'modal__card',
    style: wide ? 'width:min(1000px,100%)' : null,
    onclick: (event) => event.stopPropagation(),
  },
    el('div', { class: 'modal__head' },
      el('h3', {}, title),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: closeModal },
        icon('close', 17))),
    el('div', { class: 'modal__body' }, body));

  root.replaceChildren(el('div', { class: 'modal', onclick: closeModal }, card));
  root.hidden = false;

  closeModalHandler = (event) => { if (event.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', closeModalHandler);
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  root.hidden = true;
  root.replaceChildren();
  if (closeModalHandler) {
    document.removeEventListener('keydown', closeModalHandler);
    closeModalHandler = null;
  }
}

/**
 * Disables a button while its handler runs, so nothing is submitted twice.
 *
 * Saves the child nodes rather than `textContent`: restoring text alone would
 * silently drop the icon a button was built with, permanently, after the first
 * click.
 */
export async function busy(target, work, label = 'Working…') {
  const node = target.closest?.('button') ?? target;
  const original = [...node.childNodes];

  node.disabled = true;
  node.replaceChildren(document.createTextNode(label));

  try {
    return await work();
  } catch (error) {
    toast(error.message, 'bad');
    return undefined;
  } finally {
    node.disabled = false;
    node.replaceChildren(...original);
  }
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

export function lines(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

export function csv(text) {
  return String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function parseJson(text, fallback) {
  if (!String(text ?? '').trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    // Returning the fallback would silently discard what was typed. The server
    // rejects the raw string and says so, which is the honest outcome.
    return text;
  }
}
