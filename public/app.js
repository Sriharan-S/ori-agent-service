/* Operator console — entry point.
 *
 * Owns three things and delegates the rest: the API client, the hash router,
 * and the shell (sidebar, topbar, page slot). Views live in views.js, the
 * function editor in function-editor.js, onboarding in setup.js, the manual in
 * guide.js.
 *
 * Routing is hash-based so the function editor can be a real page you can link
 * to, reload, and leave with the back button — it used to be a modal you
 * scrolled for a minute and lost by pressing Escape.
 */

import { el, mount, icon, initials, toast, closeModal, skeleton, empty, button } from './ui.js';
import { renderSetup } from './setup.js';
import { views } from './views.js';
import { functionEditor } from './function-editor.js';
import { guideView } from './guide.js';

export const state = {
  user: null,
  applications: [],
  applicationId: null,
  route: { name: 'overview', params: {} },
  timer: null,
  counts: {},
};

// ── API ─────────────────────────────────────────────────────────────────────

export async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (response.status === 401) {
    showLogin();
    throw new Error('Your session has expired. Sign in again.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

/** Convenience for the many per-application routes. */
export function appPath(suffix) {
  return `/applications/${state.applicationId}${suffix}`;
}

// ── Routes ──────────────────────────────────────────────────────────────────

const NAV = [
  {
    title: 'Monitor',
    items: [
      { id: 'overview', label: 'Activity', icon: 'activity' },
      { id: 'conversations', label: 'Conversations', icon: 'chat' },
      { id: 'audit', label: 'Audit log', icon: 'audit' },
    ],
  },
  {
    title: 'Configure',
    items: [
      { id: 'functions', label: 'Functions', icon: 'functions', countKey: 'functions' },
      { id: 'roles', label: 'Roles', icon: 'roles' },
      { id: 'models', label: 'Models', icon: 'models', countKey: 'models' },
      { id: 'applications', label: 'Applications', icon: 'apps' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'database', label: 'Database', icon: 'database' },
      { id: 'guide', label: 'Guide', icon: 'guide' },
    ],
  },
];

const TITLES = {
  overview: 'Activity',
  conversations: 'Conversations',
  audit: 'Audit log',
  functions: 'Functions',
  'function-new': 'New function',
  'function-edit': 'Edit function',
  roles: 'Roles',
  models: 'Models',
  applications: 'Applications',
  database: 'Database',
  guide: 'Guide',
};

/** Views that make sense before any application exists. */
const APPLICATION_OPTIONAL = new Set(['database', 'models', 'applications', 'guide']);

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/').filter(Boolean);

  if (!head) return { name: 'overview', params: {} };
  if (head === 'functions' && rest[0] === 'new') return { name: 'function-new', params: {} };
  if (head === 'functions' && rest[0]) {
    return { name: 'function-edit', params: { name: decodeURIComponent(rest[0]) } };
  }
  if (head === 'guide') return { name: 'guide', params: { section: rest[0] ?? null } };
  if (TITLES[head]) return { name: head, params: {} };
  return { name: 'overview', params: {} };
}

export function navigate(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

// ── Session ─────────────────────────────────────────────────────────────────

function showLogin(message) {
  clearInterval(state.timer);
  closeModal();
  document.getElementById('setup').hidden = true;
  document.getElementById('app').hidden = true;

  const emailInput = el('input', { type: 'email', autocomplete: 'username', required: true });
  const passwordInput = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const error = el('p', { class: 'notice notice--bad', hidden: true });

  const form = el('form', {
    class: 'card screen__card',
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      submit.textContent = 'Signing in…';

      try {
        await api('/login', {
          method: 'POST',
          body: { email: emailInput.value, password: passwordInput.value },
        });
        await boot();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    },
  },
    el('div', { class: 'screen__brand' },
      el('span', { class: 'mark' }, 'O'),
      el('div', {},
        el('strong', {}, 'Ori Agent'),
        el('small', {}, 'Operator console'))),
    message ? el('p', { class: 'notice notice--ok' }, message) : null,
    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Email'),
      emailInput),
    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Password'),
      passwordInput),
    error,
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Sign in'));

  const root = document.getElementById('login');
  root.className = 'screen';
  root.replaceChildren(form);
  root.hidden = false;
  emailInput.focus();
}

export { showLogin };

async function boot() {
  // Setup comes first: before the database is connected or an account exists,
  // there is nothing to sign in to and a login form would just be a wall.
  const setup = await fetch('/admin/api/setup', { credentials: 'same-origin' })
    .then((response) => response.json())
    .catch(() => null);

  if (setup && !setup.complete) {
    document.getElementById('login').hidden = true;
    document.getElementById('app').hidden = true;
    renderSetup(setup, {
      onFinished: (message) => {
        document.getElementById('setup').hidden = true;
        showLogin(message);
      },
    });
    return;
  }

  try {
    state.user = (await api('/me')).user;
  } catch {
    showLogin();
    return;
  }

  document.getElementById('setup').hidden = true;
  document.getElementById('login').hidden = true;

  const { applications } = await api('/applications');
  state.applications = applications;

  const remembered = Number(localStorage.getItem('ori-application') ?? 0);
  state.applicationId =
    applications.find((application) => application.id === remembered)?.id ??
    applications[0]?.id ??
    null;

  renderShell();
  render();
}

// ── Shell ───────────────────────────────────────────────────────────────────

let pageSlot = null;
let titleSlot = null;

function renderShell() {
  const shell = el('div', { class: 'shell' });

  const appSelect = el('select', {
    'aria-label': 'Application',
    onchange: (event) => {
      state.applicationId = Number(event.target.value);
      localStorage.setItem('ori-application', String(state.applicationId));
      render();
    },
  }, ...state.applications.map((application) =>
    el('option', { value: application.id }, application.name)));

  if (state.applications.length === 0) {
    appSelect.replaceChildren(el('option', {}, 'No applications yet'));
    appSelect.disabled = true;
  } else {
    appSelect.value = String(state.applicationId ?? '');
  }

  titleSlot = el('h1', {}, 'Activity');
  pageSlot = el('main', { class: 'page' }, el('div', { class: 'page__inner' }));

  const nav = el('nav', { class: 'sidebar__scroll' },
    ...NAV.map((group) =>
      el('div', { class: 'navgroup' },
        el('div', { class: 'navgroup__title' }, group.title),
        ...group.items.map((item) =>
          el('a', {
            class: 'navlink',
            href: `#/${item.id}`,
            'data-nav': item.id,
            onclick: () => { shell.classList.remove('is-open'); },
          },
            icon(item.icon, 16),
            el('span', { class: 'grow' }, item.label),
            item.countKey ? el('span', { class: 'count', 'data-count': item.countKey }) : null)))));

  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'sidebar__brand' },
      el('span', { class: 'mark' }, 'O'),
      el('div', { class: 'grow' },
        el('strong', {}, 'Ori Agent'),
        el('small', {}, 'Operator console'))),
    nav,
    el('div', { class: 'sidebar__foot' },
      el('div', { class: 'who' },
        el('span', { class: 'avatar' }, initials(state.user.email)),
        el('div', { class: 'who__id' },
          el('b', { title: state.user.email }, state.user.email),
          el('span', {}, state.user.role)),
        el('button', {
          class: 'iconbtn',
          type: 'button',
          title: 'Sign out',
          'aria-label': 'Sign out',
          onclick: async () => {
            await api('/logout', { method: 'POST' }).catch(() => {});
            showLogin('Signed out.');
          },
        }, icon('logout', 16)))));

  const content = el('div', { class: 'content' },
    el('header', { class: 'topbar' },
      el('button', {
        class: 'iconbtn menu-toggle',
        type: 'button',
        'aria-label': 'Menu',
        onclick: () => shell.classList.toggle('is-open'),
      }, icon('menu', 18)),
      titleSlot,
      el('div', { class: 'grow' }),
      appSelect,
      el('a', {
        class: 'iconbtn',
        href: '/docs',
        target: '_blank',
        rel: 'noopener',
        title: 'API reference',
        'aria-label': 'API reference',
      }, icon('link', 16)),
      themeToggle()),
    pageSlot);

  mount(shell, sidebar, content);

  // Tapping outside the drawer closes it, which is the gesture people expect
  // and the only way back if the menu button scrolled out of reach.
  shell.addEventListener('click', (event) => {
    if (shell.classList.contains('is-open') && !sidebar.contains(event.target)
        && !event.target.closest('.menu-toggle')) {
      shell.classList.remove('is-open');
    }
  });

  const root = document.getElementById('app');
  root.replaceChildren(shell);
  root.hidden = false;
}

function themeToggle() {
  const node = el('button', {
    class: 'iconbtn',
    type: 'button',
    title: 'Switch theme',
    'aria-label': 'Switch theme',
  });

  const paint = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    node.replaceChildren(icon(dark ? 'sun' : 'moon', 16));
  };

  node.onclick = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ori-theme', next); } catch { /* private mode */ }
    paint();
  };

  paint();
  return node;
}

// ── Render ──────────────────────────────────────────────────────────────────

const PAGES = {
  ...views,
  'function-new': () => functionEditor(null),
  'function-edit': (params) => functionEditor(params.name),
  guide: (params) => guideView(params.section),
};

export async function render() {
  clearInterval(state.timer);
  state.route = parseHash();

  if (!pageSlot) return;

  titleSlot.textContent = TITLES[state.route.name] ?? 'Console';
  document.title = `${titleSlot.textContent} · Ori Agent`;

  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === state.route.name ||
      (link.dataset.nav === 'functions' && state.route.name.startsWith('function-'));
    link.classList.toggle('is-active', active);
  }

  const inner = el('div', { class: 'page__inner' }, skeleton(5));
  pageSlot.replaceChildren(inner);
  pageSlot.scrollTop = 0;

  if (state.applicationId === null && !APPLICATION_OPTIONAL.has(state.route.name)) {
    inner.replaceChildren(
      empty(
        'No application yet',
        'An application is one product calling this service. Create one and it arrives ' +
        'with a live demo function, so there is something to test against immediately.',
        button('Create an application', {
          variant: 'primary',
          iconName: 'plus',
          onclick: () => navigate('#/applications'),
        }),
        'apps'));
    return;
  }

  try {
    const view = PAGES[state.route.name] ?? PAGES.overview;
    inner.replaceChildren(await view(state.route.params));
    refreshCounts();
  } catch (error) {
    inner.replaceChildren(
      empty('That did not load', error.message,
        button('Try again', { iconName: 'refresh', onclick: render }), 'alert'));
  }
}

/** Sidebar counters. Best effort — a failure here must not blank the page. */
async function refreshCounts() {
  if (state.applicationId === null) return;

  const [functions, models] = await Promise.all([
    api(appPath('/functions')).then((result) => result.functions.length).catch(() => null),
    api('/models').then((result) => result.models.length).catch(() => null),
  ]);

  state.counts = { functions, models };

  for (const node of document.querySelectorAll('[data-count]')) {
    const value = state.counts[node.dataset.count];
    node.textContent = value === null || value === undefined ? '' : String(value);
    node.hidden = value === null || value === undefined;
  }
}

/** Reloads the application list after one is created or renamed. */
export async function reloadApplications(selectId) {
  const { applications } = await api('/applications');
  state.applications = applications;
  if (selectId) {
    state.applicationId = selectId;
    localStorage.setItem('ori-application', String(selectId));
  } else if (state.applicationId === null) {
    state.applicationId = applications[0]?.id ?? null;
  }
  renderShell();
  render();
}

/** Polls a view while it is on screen and the tab is visible. */
export function poll(name, ms = 5000) {
  state.timer = setInterval(() => {
    if (state.route.name === name && !document.hidden) render();
  }, ms);
}

window.addEventListener('hashchange', render);
boot().catch((error) => {
  toast(error.message, 'bad');
  showLogin();
});
