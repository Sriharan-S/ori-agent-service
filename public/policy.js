/* The response policy page.
 *
 * Roles decide what the agent can *reach*. This decides what it may *say* about
 * what it reached — a different question, and one that has no answer in a
 * function grant: "may give career advice from a candidate's own scores" and
 * "must not offer a clinical opinion" describe the same function returning the
 * same rows.
 *
 * The page is deliberately one form rather than a list of records. A policy is
 * a document an operator reads whole, argues about, and exports; splitting it
 * into per-rule CRUD would make the thing you have to reason about invisible.
 */

import {
  el, frag, table, panel, badge, notice, empty, button, field,
  textInput, textArea, codeBlock, openModal, closeModal, toast, busy, pageHead,
} from './ui.js';
import { api, appPath, render } from './app.js';

/** Working copy. Replaced on load, mutated by the editors, saved as a whole. */
let draft = null;

/**
 * The two fields edited in place rather than through a modal.
 *
 * Held as references because the panels around them are rebuilt on every
 * change: reading them back by position at save time worked until the page grew
 * a third textarea, which is exactly the kind of bug that silently saves the
 * wrong string.
 */
let promptField = null;
let refusalField = null;

/** Pull the in-place fields into the draft before it is read. */
function syncFields() {
  if (promptField) draft.systemPrompt = promptField.value;
  if (refusalField) draft.refusalMessage = refusalField.value;
}

export async function policyView() {
  const { policy } = await api(appPath('/policy'));
  draft = clone(policy);

  const body = el('div');
  const redraw = () => {
    // Rebuilding drops the DOM nodes, so capture what is typed in them first.
    if (promptField || refusalField) syncFields();
    body.replaceChildren(editor(redraw));
  };
  redraw();

  return frag(
    pageHead('Response policy',
      'What the model is allowed to answer. Roles govern the data it can reach; ' +
      'this governs what it may say about it.',
      button('Export', { iconName: 'download', onclick: exportPolicy }),
      button('Import', { iconName: 'upload', onclick: importPolicy }),
      button('Save', { variant: 'primary', iconName: 'check', onclick: save })),
    body,
  );
}

function editor(redraw) {
  return frag(
    panel('Status', {},
      field('Enforcement',
        toggle(draft.isEnabled, (on) => { draft.isEnabled = on; redraw(); }),
        draft.isEnabled
          ? 'The instructions below are added to every prompt, and a message matching a ' +
            'deny pattern is refused before any model or function runs.'
          : 'Off. Nothing below has any effect — the agent behaves as if no policy existed.'),

      draft.updatedAt
        ? el('p', { class: 'muted' }, `Last saved ${new Date(draft.updatedAt).toLocaleString()}.`)
        : el('p', { class: 'muted' }, 'Never saved.')),

    panel('Extra instructions', {},
      field('Appended to every prompt',
        (promptField = textArea(draft.systemPrompt, 8)),
        'Voice, standing caveats, house style — anything that should hold on every ' +
        'answer. Written into the reasoning and the answering prompts both, so an ' +
        'answer is not researched one way and then softened another.',
        { optional: true }),
      notice(
        'This does not grant access to anything. Every fact in an answer still comes ' +
        'from a function the caller\'s role may call — an instruction here cannot ' +
        'reach a row a role cannot.',
        'info')),

    allowPanel(redraw),
    denyPanel(redraw),

    panel('Try it', { tools: [button('Preview compiled prompt', { onclick: previewPrompt })] },
      el('p', { class: 'muted' },
        'Check a message against the deny patterns without sending it anywhere.'),
      checkForm()),
  );
}

// ── Allow ───────────────────────────────────────────────────────────────────

function allowPanel(redraw) {
  const rules = draft.allowRules;

  return panel('Allowed subjects', {
    count: rules.length,
    tools: [button('Add', { iconName: 'plus', onclick: () => editAllow(null, redraw) })],
  },
    rules.length === 0
      ? empty('Nothing explicitly allowed',
          'Without an entry here the model falls back on its own caution, which means ' +
          'it will decline questions it could have answered from the rows in front of ' +
          'it. Naming a subject is how you say "yes, this, and here is how".',
          button('Allow a subject', { variant: 'primary', onclick: () => editAllow(null, redraw) }),
          'roles')
      : table(['Subject', 'How to handle it', ''],
          rules.map((rule, index) => [
            el('button', { class: 'linkish', type: 'button', onclick: () => editAllow(index, redraw) },
              rule.topic),
            rule.note || '—',
            button('Remove', { size: 'sm', onclick: () => { rules.splice(index, 1); redraw(); } }),
          ])));
}

function editAllow(index, redraw) {
  const existing = index === null ? { topic: '', note: '' } : draft.allowRules[index];
  const topic = textInput(existing.topic, { placeholder: 'career guidance' });
  const note = textArea(existing.note, 4);

  openModal(index === null ? 'Allow a subject' : 'Edit allowed subject', frag(
    field('Subject', topic, 'A short label. This is what the model is told it may cover.'),
    field('How to handle it', note,
      'Conditions and framing. "Only from the candidate\'s own assessment scores. ' +
      'Say what the scores support and no more." Vague notes produce vague answers.'),
    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
      button('Cancel', { onclick: closeModal }),
      button('Save', { variant: 'primary', onclick: () => {
        const value = { topic: topic.value.trim(), note: note.value.trim() };
        if (!value.topic) return toast('Give the subject a name.', 'bad');
        if (index === null) draft.allowRules.push(value);
        else draft.allowRules[index] = value;
        closeModal();
        redraw();
      } }))));
}

// ── Deny ────────────────────────────────────────────────────────────────────

function denyPanel(redraw) {
  const rules = draft.denyRules;

  return panel('Refused subjects', {
    count: rules.length,
    tools: [button('Add', { iconName: 'plus', onclick: () => editDeny(null, redraw) })],
  },
    rules.length === 0
      ? empty('Nothing refused',
          'A refused subject is written into the prompt, and — if you give it patterns — ' +
          'blocked outright before the model is reached.',
          button('Refuse a subject', { variant: 'primary', onclick: () => editDeny(null, redraw) }),
          'roles')
      : table(['Subject', 'Patterns', 'Enforcement', 'Message', ''],
          rules.map((rule, index) => [
            el('button', { class: 'linkish', type: 'button', onclick: () => editDeny(index, redraw) },
              rule.topic),
            rule.patterns?.length
              ? el('span', { class: 'mono' }, rule.patterns.join(', ').slice(0, 60))
              : '—',
            rule.patterns?.length
              ? badge('blocked before the model', 'ok')
              : badge('prompt only', 'warn'),
            rule.message ? rule.message.slice(0, 50) : el('span', { class: 'muted' }, 'default'),
            button('Remove', { size: 'sm', onclick: () => { rules.splice(index, 1); redraw(); } }),
          ])),

    notice(
      'A rule with no patterns shapes the prompt and nothing more — the right shape for ' +
      'a subject no keyword captures honestly. A rule with patterns is enforced ' +
      'mechanically: the message never reaches a model, a function, or a registered ' +
      'service. Prefer few, specific patterns. A broad one refuses people for a reason ' +
      'they cannot see.',
      'info'));
}

function editDeny(index, redraw) {
  const existing = index === null
    ? { topic: '', patterns: [], message: '' }
    : draft.denyRules[index];

  const topic = textInput(existing.topic, { placeholder: 'clinical diagnosis' });
  const patterns = textArea((existing.patterns ?? []).join('\n'), 5);
  const message = textArea(existing.message ?? '', 3);

  openModal(index === null ? 'Refuse a subject' : 'Edit refused subject', frag(
    field('Subject', topic, 'A short label. Written into the prompt as something to decline.'),
    field('Patterns, one per line', patterns,
      'A plain phrase matches on word boundaries, so "art" will not match "start". ' +
      'Wrap in slashes for a regular expression: /depress(ed|ion)/. Leave empty to ' +
      'shape the prompt without blocking anything.',
      { optional: true }),
    field('Refusal message', message,
      'Shown instead of an answer. Leave empty to use the default below.',
      { optional: true }),
    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
      button('Cancel', { onclick: closeModal }),
      button('Save', { variant: 'primary', onclick: () => {
        const value = {
          topic: topic.value.trim(),
          patterns: patterns.value.split('\n').map((line) => line.trim()).filter(Boolean),
          message: message.value.trim() || undefined,
        };
        if (!value.topic) return toast('Give the subject a name.', 'bad');
        if (index === null) draft.denyRules.push(value);
        else draft.denyRules[index] = value;
        closeModal();
        redraw();
      } }))));
}

// ── Try it ──────────────────────────────────────────────────────────────────

function checkForm() {
  const input = textInput('', { placeholder: 'Am I depressed?' });
  const out = el('div', { style: 'margin-top:10px' });

  const run = async () => {
    const message = input.value.trim();
    if (!message) return;
    try {
      const { verdict } = await api(appPath('/policy/check'), {
        method: 'POST', body: { message },
      });
      out.replaceChildren(verdict.allowed
        ? notice('Allowed. This message would be answered normally.', 'ok')
        : notice(
            `Refused by "${verdict.topic}". The user would see: ${verdict.message || draft.refusalMessage}`,
            'warn'));
    } catch (error) {
      out.replaceChildren(notice(error.message, 'bad'));
    }
  };

  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  return frag(
    el('div', { class: 'btnrow' }, input, button('Check', { onclick: run })),
    out,
    field('Default refusal message', (refusalField = textArea(draft.refusalMessage, 3)),
      'Used when a matching rule carries no message of its own.'),
  );
}

async function previewPrompt() {
  try {
    const { prompt } = await api(appPath('/policy/preview'));
    openModal('Compiled prompt', frag(
      el('p', { class: 'muted' },
        'Exactly what is appended to the model prompts. Saved state, not the ' +
        'unsaved edits on the page.'),
      codeBlock(prompt || '(nothing — the policy is off or empty)', { wrap: true, tall: true }),
    ), { wide: true });
  } catch (error) {
    toast(error.message, 'bad');
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function save(event) {
  syncFields();

  try {
    await busy(event?.target, () => api(appPath('/policy'), {
      method: 'PUT',
      body: {
        isEnabled: draft.isEnabled,
        systemPrompt: draft.systemPrompt,
        allowRules: draft.allowRules,
        denyRules: draft.denyRules,
        refusalMessage: draft.refusalMessage,
      },
    }), 'Saving…');
    toast('Policy saved. It takes effect within the registry cache TTL.', 'ok');
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function exportPolicy() {
  try {
    const bundle = await api(appPath('/policy/export'));
    const slug = bundle.application?.slug || 'policy';
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: `ori-${slug}-policy-${stamp}.json` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast('Policy exported.', 'ok');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/**
 * Upload a policy bundle.
 *
 * It lands disabled. A policy written for another environment encodes that
 * environment's judgement about who is asking and what they may be told, and
 * switching it on unread is how a deployment starts refusing people for reasons
 * nobody here decided.
 */
function importPolicy() {
  const picker = el('input', { type: 'file', accept: 'application/json,.json' });
  const result = el('div');

  const onFile = async () => {
    const file = picker.files?.[0];
    if (!file) return;

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      result.replaceChildren(notice('That file is not valid JSON.', 'bad'));
      return;
    }

    try {
      const { policy } = await api(appPath('/policy/import'), { method: 'POST', body: parsed });
      result.replaceChildren(
        notice(
          `Imported ${policy.allowRules.length} allowed and ${policy.denyRules.length} ` +
          'refused subjects. Enforcement is off — read it, then turn it on.',
          'ok'),
        el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
          button('Done', { variant: 'primary', onclick: () => { closeModal(); render(); } })));
    } catch (error) {
      result.replaceChildren(notice(error.message, 'bad'));
    }
  };

  picker.addEventListener('change', onFile);

  openModal('Import a policy', frag(
    el('p', { class: 'muted' },
      'Replaces the current policy. It arrives switched off, whatever the file says.'),
    picker,
    result,
  ));
}

// ── Bits ────────────────────────────────────────────────────────────────────

function toggle(on, onchange) {
  return el('div', { class: 'btnrow' },
    button(on ? 'Enforcing' : 'Off', {
      variant: on ? 'primary' : '',
      onclick: () => onchange(!on),
      iconName: on ? 'check' : 'close',
    }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
