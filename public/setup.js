/* Onboarding.
 *
 * Shown instead of the login form whenever the service cannot yet do its job:
 * no database configured, a database it cannot reach, tables it may not create,
 * or no operator account. Each of those has a different fix, so each gets its
 * own screen with the fix on it rather than a generic "check your config".
 *
 * The screen never says "restart the service". Every step ends in a button that
 * re-checks in place, because an onboarding loop that needs a redeploy between
 * attempts is one people give up on.
 */

import {
  el, frag, icon, notice, codeBlock, button, field, textInput, toast, mount, busy,
} from './ui.js';

const STEP_ORDER = ['database', 'tables', 'read', 'account'];

const STEP_NAMES = {
  database: 'Database',
  tables: 'Tables',
  read: 'Read-only access',
  account: 'Administrator',
};

let current = null;
let onFinishedCallback = null;

export function renderSetup(status, { onFinished } = {}) {
  current = status;
  if (onFinished) onFinishedCallback = onFinished;

  const root = document.getElementById('setup');
  root.className = 'screen';
  root.replaceChildren(
    el('div', { class: 'card screen__card screen__card--wide' },
      el('div', { class: 'wizard' },
        stepRail(status),
        el('div', { class: 'wizard__main' }, stepBody(status)))));
  root.hidden = false;
}

async function recheck(target) {
  await busy(target, async () => {
    const response = await fetch('/admin/api/setup/check', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const status = await response.json();

    if (status.complete) {
      onFinishedCallback?.('Setup finished. Sign in to continue.');
      return;
    }

    const before = current?.stage;
    renderSetup(status);

    const step = status.steps.find((entry) => entry.id === status.stage);
    if (status.stage === before) {
      toast(step ? `Still to do: ${step.title}` : 'Still not ready', 'bad');
    } else {
      toast(`Done. Next: ${step?.title ?? 'finish setup'}`, 'ok');
    }
  }, 'Checking…');
}

function stepRail(status) {
  return el('div', { class: 'wizard__steps' },
    ...STEP_ORDER.map((id, index) => {
      const step = status.steps.find((entry) => entry.id === id);
      const isCurrent = id === status.stage;
      const done = step?.state === 'done';
      const blocked = !isCurrent && step?.state === 'blocked';

      return el('div', {
        class: `step ${done ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''} ${blocked ? 'is-blocked' : ''}`,
      },
        el('span', { class: 'step__dot' }, done ? icon('check', 12) : String(index + 1)),
        el('span', { class: 'step__label' }, STEP_NAMES[id]));
    }));
}

function stepBody(status) {
  const step = status.steps.find((entry) => entry.id === status.stage) ??
    status.steps.find((entry) => entry.state !== 'done');

  const header = frag(
    el('div', { class: 'screen__brand' },
      el('span', { class: 'mark' }, 'O'),
      el('div', {},
        el('strong', {}, 'Set up Ori Agent'),
        el('small', {}, 'Four steps, then the console opens'))),
    step ? el('h3', { style: 'font-size:16px;font-weight:600;margin-bottom:6px' }, step.title) : null,
    step ? el('p', { class: 'muted', style: 'font-size:13px;max-width:66ch' }, step.summary) : null,
    step?.action ? notice(step.action, step.state === 'blocked' ? 'warn' : 'info') : null,
    step?.detail ? el('div', { style: 'margin-top:8px' }, codeBlock(step.detail, { wrap: true })) : null,
  );

  const body =
    status.stage === 'database' ? databaseStep(status)
    : status.stage === 'tables' ? tablesStep(status)
    : status.stage === 'read' ? readStep(status)
    : status.stage === 'account' ? accountStep(status)
    : el('div', {});

  return mount(el('div', {}), header, el('div', { style: 'margin-top:16px' }, body));
}

// ── Step 1: the database ────────────────────────────────────────────────────

function databaseStep(status) {
  const blocking = status.problems.filter((problem) => problem.severity === 'blocking');

  return frag(
    el('p', { class: 'muted', style: 'font-size:13px;margin-bottom:12px' },
      'This service does not have a database of its own. Point it at a Postgres you ' +
      'already run and it creates its own ',
      el('code', {}, 'agent_*'),
      ' tables inside it, touching nothing else.'),

    blocking.length
      ? el('div', {}, ...blocking.map((problem) =>
          el('div', { style: 'margin-bottom:12px' },
            notice(`${problem.variable} — ${problem.message}`, 'bad'),
            codeBlock(problem.fix, { wrap: true }))))
      : null,

    el('h4', { style: 'font-size:13px;font-weight:600;margin:16px 0 6px' },
      'Set these in the environment'),
    codeBlock(
      'DATABASE_URL=postgres://user:password@host:5432/your_database\n' +
      'DATABASE_READ_URL=postgres://ori_reader:password@host:5432/your_database\n' +
      'ENCRYPTION_KEY=<openssl rand -base64 32>',
      { wrap: true }),
    el('p', { class: 'field__hint' },
      'In development that is the <code>.env</code> file next to package.json. ' +
      'In production it is whatever supplies the container its environment.'),

    checkRow('I have set them — check now'),
  );
}

// ── Step 2: the tables ──────────────────────────────────────────────────────

function tablesStep(status) {
  const missing = status.tables.filter((entry) => !entry.exists);

  return frag(
    el('p', { class: 'muted', style: 'font-size:13px' },
      `The service tried to create ${status.tables.length} tables in the `,
      el('code', {}, status.schema),
      ' schema and was not allowed to. That normally means the role can read and ' +
      'write rows but not create objects, which is common on managed Postgres.'),

    el('h4', { style: 'font-size:13px;font-weight:600;margin:16px 0 6px' },
      `Missing (${missing.length} of ${status.tables.length})`),
    el('div', { class: 'tablegrid', style: 'margin-bottom:16px' },
      ...status.tables.map((entry) => el('div', {},
        el('span', { class: entry.exists ? 'tick' : 'cross' }, entry.exists ? '✓' : '✗'),
        entry.name))),

    el('h4', { style: 'font-size:13px;font-weight:600;margin:16px 0 6px' },
      'Run this as a role that may create objects'),
    codeBlock(status.sql, { tall: true }),
    el('p', { class: 'field__hint' },
      'Pure DDL — no data is written. Once the tables exist the service records its own ' +
      'migration history on the next check, so nothing here has to be repeated.'),

    checkRow('I have run it — check now'),
  );
}

// ── Step 3: the read-only connection ────────────────────────────────────────

function readStep(status) {
  return frag(
    el('p', { class: 'muted', style: 'font-size:13px' },
      'Registry functions run on a second connection that must not be able to write. ' +
      'That is not a convention — the service verifies it before opening the pool, and ' +
      'refuses to run a single function if it fails.'),

    el('h4', { style: 'font-size:13px;font-weight:600;margin:16px 0 6px' },
      'Create the read-only role'),
    codeBlock(status.readRoleSql, { tall: true }),

    el('div', { style: 'margin-top:14px' },
      notice(
        'You can finish setup without this and add it later — but until it is in place ' +
        'the agent cannot answer anything, because every function needs it.',
        'info')),

    el('div', { class: 'btnrow', style: 'margin-top:16px' },
      button('I have set it up — check now', {
        variant: 'primary',
        iconName: 'refresh',
        onclick: (event) => recheck(event.currentTarget),
      }),
      button('Skip for now', {
        onclick: () => {
          // The read step is non-blocking server-side, so the only reason we are
          // here is that it is the first thing still outstanding. Jump past it.
          const next = current.steps.find(
            (step) => step.blocking && step.state !== 'done');
          if (next) renderSetup({ ...current, stage: next.id });
          else onFinishedCallback?.('Setup finished. Sign in to continue.');
        },
      })),
  );
}

// ── Step 4: the first operator account ──────────────────────────────────────

function accountStep() {
  const email = el('input', { type: 'email', autocomplete: 'username', required: true });
  const name = textInput('', { placeholder: 'optional' });
  const password = el('input', { type: 'password', autocomplete: 'new-password', required: true });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: true });
  const problem = el('div');

  const strength = el('p', { class: 'field__hint' }, 'At least 12 characters.');
  password.addEventListener('input', () => {
    const length = password.value.length;
    strength.textContent = length === 0
      ? 'At least 12 characters.'
      : length < 12
        ? `${12 - length} more character(s) needed.`
        : 'Long enough.';
  });

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      problem.replaceChildren();

      if (password.value !== confirm.value) {
        problem.replaceChildren(notice('The two passwords do not match.', 'bad'));
        return;
      }

      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      submit.textContent = 'Creating…';

      try {
        const response = await fetch('/admin/api/setup/admin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            email: email.value,
            password: password.value,
            confirmPassword: confirm.value,
            name: name.value,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || 'Could not create the account');

        onFinishedCallback?.(`Account created for ${payload.user.email}. Sign in to continue.`);
      } catch (error) {
        problem.replaceChildren(notice(error.message, 'bad'));
        submit.disabled = false;
        submit.textContent = 'Create account and finish';
      }
    },
  },
    el('p', { class: 'muted', style: 'font-size:13px;margin-bottom:14px' },
      'This account owns the deployment. It can read every conversation, change what ' +
      'the agent is allowed to do, and create other operators.'),

    field('Email', email, 'Used to sign in. Nothing is sent to it.'),
    field('Name', name, 'Shown in this console.', { optional: true }),

    mount(el('div', { class: 'field' }),
      el('span', { class: 'field__label' }, 'Password'),
      password,
      strength),

    field('Confirm password', confirm, 'Type it again — there is no reset link.'),

    problem,

    el('div', { class: 'btnrow', style: 'margin-top:16px' },
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Create account and finish')));

  return form;
}

// ── Shared ──────────────────────────────────────────────────────────────────

function checkRow(label) {
  return el('div', { class: 'btnrow', style: 'margin-top:18px' },
    button(label, {
      variant: 'primary',
      iconName: 'refresh',
      onclick: (event) => recheck(event.currentTarget),
    }),
    el('span', { class: 'faint', style: 'font-size:12px' },
      'Nothing needs restarting — this reconnects in place.'));
}
