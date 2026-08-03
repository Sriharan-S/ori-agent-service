/* The console's pages, apart from the function editor, the setup wizard and the
 * guide, which are large enough to live on their own.
 */

import {
  el, mount, frag, icon, fmt, table, panel, kpi, badge, statusBadge, banner, notice,
  empty, button, field, textInput, textArea, select, codeBlock, openModal, closeModal,
  toast, busy, csv, parseJson, pageHead,
} from './ui.js';
import { api, appPath, state, render, navigate, poll, reloadApplications } from './app.js';

export const views = {};

// ── Activity ────────────────────────────────────────────────────────────────

views.overview = async () => {
  const { overview, active, recent } = await api('/overview');

  // The one view worth polling: it is what you watch while something happens.
  poll('overview');

  return frag(
    pageHead('Activity', 'Live runs and how the agent has behaved recently.',
      button('Refresh', { iconName: 'refresh', onclick: render })),

    el('div', { class: 'grid' },
      kpi('Runs · last hour', fmt.num(overview.runsLastHour), { iconName: 'activity' }),
      kpi('Runs · 24h', fmt.num(overview.runsLast24h), { iconName: 'activity' }),
      kpi('In flight', fmt.num(overview.activeRuns), {
        tone: overview.activeRuns > 0 ? 'ok' : '',
        iconName: 'play',
        note: overview.activeRuns > 0 ? 'streaming or waiting' : 'nothing running',
      }),
      kpi('Failed · 24h', fmt.num(overview.failuresLast24h), {
        tone: overview.failuresLast24h > 0 ? 'bad' : 'ok',
        iconName: 'alert',
      }),
      kpi('Median latency', fmt.ms(overview.medianLatencyMs), { iconName: 'clock' }),
      kpi('p95 latency', fmt.ms(overview.p95LatencyMs), { iconName: 'gauge' }),
      kpi('Asked to clarify', fmt.pct(overview.clarificationRate), {
        iconName: 'chat',
        note: 'rather than guessing',
      }),
      kpi('Denied · 24h', fmt.num(overview.deniedLast24h), {
        tone: overview.deniedLast24h > 0 ? 'warn' : '',
        iconName: 'shield',
        note: 'refused by RBAC or scope',
      })),

    panel('Active connections', {
      count: active.length,
      tools: [active.length ? el('span', { class: 'pulse' }) : null],
    },
      active.length === 0
        ? empty('Nothing running', 'Live runs appear here the moment a request arrives.', null, 'activity')
        : table(['Run', 'Application', 'User', 'Intent', 'Mode', 'Age'],
            active.map((run) => [
              el('span', { class: 'mono' }, run.runKey.slice(0, 8)),
              run.applicationSlug,
              `${run.endUserId} (${run.endUserRole})`,
              run.intent || '—',
              statusBadge(run.streamed ? 'streaming' : 'request'),
              `${Math.round(run.ageMs / 1000)}s`,
            ]))),

    panel('Recent runs', {
      count: recent.length,
      foot: 'Select a run id to see every step it took, including refused calls.',
    },
      recent.length === 0
        ? empty('No runs yet',
            'Issue an API key on the Applications page and send a message to /v1/chat.',
            button('Open the guide', { onclick: () => navigate('#/guide/calling') }),
            'inbox')
        : table(['Run', 'User', 'Intent', 'Result', 'Functions', 'Latency', 'When'],
            recent.map((run) => [
              el('button', {
                class: 'linkish mono',
                type: 'button',
                onclick: () => showRun(run.runKey),
              }, run.runKey.slice(0, 8)),
              `${run.endUserId} (${run.endUserRole})`,
              run.intent || '—',
              statusBadge(run.status === 'failed' ? 'failed' : run.responseType || run.status),
              run.functionsUsed.join(', ') || '—',
              fmt.ms(run.latencyMs),
              fmt.ago(run.startedAt),
            ]))),
  );
};

async function showRun(runKey) {
  const { run, calls } = await api(`/runs/${runKey}`);

  openModal(`Run ${runKey.slice(0, 8)}`, frag(
    el('div', { class: 'grid' },
      kpi('Status', run?.status ?? '—', { tone: run?.status === 'failed' ? 'bad' : 'ok' }),
      kpi('Latency', fmt.ms(run?.latency_ms), { iconName: 'clock' }),
      kpi('Intent', run?.intent ?? '—', { iconName: 'activity' })),
    run?.error ? notice(run.error, 'bad') : null,
    panel('Function calls', { count: calls.length },
      calls.length === 0
        ? empty('No functions were called',
            'The agent answered conversationally, or stopped to ask a question.')
        : table(['Function', 'Status', 'Params', 'Scopes applied', 'Rows', 'Latency'],
            calls.map((call) => [
              call.function_name,
              statusBadge(call.status),
              el('span', { class: 'mono' }, JSON.stringify(call.params)),
              el('span', { class: 'mono' }, JSON.stringify(call.scopes_applied)),
              call.row_count ?? '—',
              fmt.ms(call.latency_ms),
            ]))),
  ), { wide: true });
}

// ── Functions ───────────────────────────────────────────────────────────────

views.functions = async () => {
  const { functions } = await api(appPath('/functions'));
  const hasDemo = functions.some((fn) => fn.name === 'demo');
  const live = functions.filter((fn) => fn.status === 'live').length;
  const liveBeyondDemo = functions.filter(
    (fn) => fn.status === 'live' && fn.name !== 'demo').length;
  const pending = functions.filter(
    (fn) => fn.status === 'draft' || fn.status === 'approved');

  return frag(
    pageHead('Functions',
      'The agent\'s entire vocabulary. It picks one of these and fills in the ' +
      'parameters — it never writes a query.',
      functions.length
        ? button('Export', { iconName: 'copy', onclick: () => exportFunctions() })
        : null,
      button('Import', { iconName: 'back', onclick: () => importFunctions() }),
      button('New function', {
        variant: 'primary',
        iconName: 'plus',
        onclick: () => navigate('#/functions/new'),
      })),

    hasDemo ? null : banner('warn',
      frag(el('strong', {}, 'The demo function is missing. '),
        'It reads the database catalogue, so it works on any Postgres with no seed ' +
        'data, and lets you test the agent end to end before writing anything.'),
      button('Install demo', { variant: 'primary', onclick: installDemo })),

    live === 0 && functions.length > 0 ? banner('warn',
      frag(el('strong', {}, 'Nothing is live. '),
        'Only live functions are visible to the planner, so the agent currently ' +
        'has nothing it can do. Approve a function, then take it live.'),
      pending.length ? releaseAllButton(pending) : null) : null,

    // The demo function being live is not the same as having a registry. An
    // import leaves everything as a draft, so this is the state right after
    // one: plenty of functions, none of them reachable, and the planner falling
    // back to the only thing it can see.
    live > 0 && liveBeyondDemo === 0 && pending.length > 0 ? banner('warn',
      frag(el('strong', {}, `${pending.length} function(s) are waiting to go live. `),
        'Only the demo function is live, so that is the only thing the planner can ' +
        'choose — which is why the agent answers about database tables instead of ' +
        'your data. Approve them and take them live.'),
      releaseAllButton(pending)) : null,

    panel('Registry', { count: functions.length },
      functions.length === 0
        ? empty('No functions yet',
            'The agent can only do what is defined here. Start with the demo, or write one.',
            button('Install the demo function', { variant: 'primary', onclick: installDemo }),
            'functions')
        : table(['Name', 'Kind', 'Returns', 'Roles', 'Status', 'Ver', ''],
            functions.map((fn) => [
              mount(el('span', { class: 'nowrap' }),
                el('button', {
                  class: 'linkish',
                  type: 'button',
                  onclick: () => navigate(`#/functions/${encodeURIComponent(fn.name)}`),
                }, fn.name),
                fn.name === 'demo' ? ' ' : null,
                fn.name === 'demo' ? badge('demo', 'info') : null),
              fn.kind,
              fn.returns,
              fn.allowedRoles.join(', ') || '—',
              statusBadge(fn.status),
              `v${fn.version}`,
              el('div', { class: 'cell-actions' }, ...statusActions(fn)),
            ]))),

    panel('How a function reaches the agent', {},
      el('div', { class: 'panel__body' },
        el('ol', { style: 'padding-left:20px;font-size:13px;line-height:1.7;color:var(--text-muted)' },
          el('li', {}, el('strong', {}, 'Draft'), ' — saved and validated by Postgres, but not reachable.'),
          el('li', {}, el('strong', {}, 'Approved'), ' — reviewed by a person.'),
          el('li', {}, el('strong', {}, 'Live'), ' — visible to the planner and callable.'),
          el('li', {}, el('strong', {}, 'Disabled'), ' — kept, with its history, but switched off.')),
        el('p', { class: 'field__hint', style: 'margin-top:10px' },
          'Editing a live function returns it to draft: an approval covers the version ' +
          'that was actually read.'))),
  );
};

function statusActions(fn) {
  const go = (status, label, variant) =>
    button(label, {
      variant,
      size: 'sm',
      onclick: async (event) => busy(event.target, async () => {
        await api(appPath(`/functions/${encodeURIComponent(fn.name)}/status`), {
          method: 'POST',
          body: { status },
        });
        toast(`${fn.name} is now ${status}`, 'ok');
        render();
      }),
    });

  if (fn.status === 'draft') return [go('approved', 'Approve', '')];
  if (fn.status === 'approved') return [go('live', 'Go live', 'primary')];
  if (fn.status === 'live') return [go('disabled', 'Disable', 'danger')];
  return [go('approved', 'Re-approve', '')];
}

async function installDemo() {
  try {
    const result = await api(appPath('/functions/demo'), { method: 'POST' });
    toast(result.installed ? 'Demo function installed and live.' : 'The demo already exists.', 'ok');
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/** Download every function as a JSON bundle. */
async function exportFunctions() {
  try {
    const bundle = await api(appPath('/functions/export'));
    const slug = bundle.application?.slug || 'functions';
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: `ori-${slug}-functions-${stamp}.json` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${bundle.functions.length} function(s).`, 'ok');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/**
 * Upload a bundle and show what happened to each function.
 *
 * Everything lands as a draft — a bundle is code from elsewhere and earns
 * `live` the same way anything does, so the review step is deliberate rather
 * than skipped. The result table separates "imported and validates" from
 * "imported but needs a fix", because on a different database some SQL that was
 * fine at export will not resolve here, and that is exactly what the author
 * needs to see.
 */
function importFunctions() {
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

    result.replaceChildren(el('p', { class: 'muted' }, 'Validating against this database…'));

    try {
      const { outcomes } = await api(appPath('/functions/import'), { method: 'POST', body: parsed });
      const ok = outcomes.filter((o) => o.action !== 'failed' && o.validates).length;
      const needsFix = outcomes.filter((o) => o.action !== 'failed' && !o.validates).length;
      const failed = outcomes.filter((o) => o.action === 'failed').length;

      result.replaceChildren(
        notice(
          `${ok} ready, ${needsFix} imported but need a fix, ${failed} rejected. ` +
          'All imported functions are drafts — review, then take live.',
          failed ? 'bad' : needsFix ? 'warn' : 'ok'),
        table(['Function', 'Action', 'Validates', 'Detail'],
          outcomes.map((o) => [
            o.name,
            statusBadge(o.action),
            o.action === 'failed' ? '—' : o.validates ? badge('yes', 'ok') : badge('no', 'warn'),
            o.message ? el('span', { class: 'mono' }, o.message.slice(0, 120)) : '—',
          ])),
        el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
          button('Done', { variant: 'primary', onclick: () => { closeModal(); render(); } })));
    } catch (error) {
      result.replaceChildren(notice(error.message, 'bad'));
    }
  };

  picker.addEventListener('change', onFile);

  openModal('Import functions', frag(
    el('p', { class: 'muted', style: 'font-size:13px;margin-bottom:12px' },
      'Upload a bundle exported from here or from another deployment. Each function ' +
      'is validated against this database and stored as a draft. Existing functions ' +
      'with the same name are updated.'),
    el('div', { class: 'btnrow' },
      button('Choose a JSON file…', { iconName: 'inbox', onclick: () => picker.click() })),
    picker,
    el('div', { style: 'margin-top:14px' }, result),
  ), { wide: true });

  picker.style.display = 'none';
}

// ── Roles ───────────────────────────────────────────────────────────────────

views.roles = async () => {
  const { roles } = await api(appPath('/roles'));

  return frag(
    pageHead('Roles',
      'Who may call what. A caller whose role is not defined here is refused — ' +
      'there is no default role.',
      button('New role', { variant: 'primary', iconName: 'plus', onclick: () => editRole(null) })),

    panel('Roles', { count: roles.length },
      roles.length === 0
        ? empty('No roles defined',
            'Every chat request states a role. One that is not listed here is rejected, ' +
            'so nothing will work until at least one exists.',
            button('Create a role', { variant: 'primary', onclick: () => editRole(null) }),
            'roles')
        : table(['Name', 'Allowed functions', 'Write scopes', 'Exempt from scopes'],
            roles.map((role) => [
              el('button', { class: 'linkish', type: 'button', onclick: () => editRole(role) },
                role.name),
              role.allowedFunctions.join(', ') || '—',
              role.writeScopes.join(', ') || '—',
              role.unscopedKeys.length ? badge(role.unscopedKeys.join(', '), 'warn') : '—',
            ]))),

    notice(
      'A role exempt from a scope key sees every value of it — that is how an ' +
      'administrator role looks across tenants. A role that is not exempt must supply ' +
      'a value, or every function declaring that scope is refused rather than run unscoped.',
      'info'),
  );
};

function editRole(existing) {
  const name = textInput(existing?.name ?? '', { placeholder: 'support' });
  const allowed = textInput((existing?.allowedFunctions ?? []).join(', '), { placeholder: 'get_order, list_orders' });
  const writes = textInput((existing?.writeScopes ?? []).join(', '));
  const unscoped = textInput((existing?.unscopedKeys ?? []).join(', '));

  if (existing) name.disabled = true;

  openModal(existing ? `Edit ${existing.name}` : 'New role', frag(
    field('Role name', name,
      'Exactly the string your application sends as the end user\'s role. Case-sensitive.'),
    field('Allowed functions', allowed,
      'Comma separated, or <code>*</code> for every live function. Names not in the ' +
      'registry are simply never matched.'),
    field('Write scopes', writes,
      'Scope keys this role may pass to write actions.', { optional: true }),
    field('Exempt from scope keys', unscoped,
      'Comma separated. A key listed here is <strong>not</strong> filtered for this role — ' +
      'they see every value of it. Grant deliberately.', { optional: true }),

    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
      existing
        ? button('Delete', {
            variant: 'danger',
            onclick: async () => {
              if (!confirm(`Delete role "${existing.name}"? Callers using it will be refused.`)) return;
              await api(appPath(`/roles/${encodeURIComponent(existing.name)}`), { method: 'DELETE' });
              closeModal();
              render();
            },
          })
        : null,
      button('Save role', {
        variant: 'primary',
        onclick: async (event) => busy(event.target, async () => {
          const roleName = name.value.trim();
          if (!roleName) { toast('A role needs a name.', 'bad'); return; }

          await api(appPath(`/roles/${encodeURIComponent(roleName)}`), {
            method: 'PUT',
            body: {
              allowedFunctions: csv(allowed.value),
              writeScopes: csv(writes.value),
              unscopedKeys: csv(unscoped.value),
            },
          });
          toast('Role saved', 'ok');
          closeModal();
          render();
        }),
      })),
  ));
}

// ── Models ──────────────────────────────────────────────────────────────────

views.models = async () => {
  const { models } = await api('/models');
  const enabled = models.filter((model) => model.isEnabled).length;

  return frag(
    pageHead('Models',
      'Any OpenAI-compatible endpoint: vLLM, Ollama, or a hosted API. Which model ' +
      'plans and which writes the answer is configuration, not code.',
      models.length
        ? button('Check health', {
            iconName: 'refresh',
            onclick: async (event) => busy(event.target, async () => {
              const { results } = await api('/models/health', {
                method: 'POST',
                body: { applicationId: state.applicationId },
              });
              toast(results.map((r) => `${r.model}: ${r.ok ? 'ok' : r.error}`).join(' · '),
                results.every((r) => r.ok) ? 'ok' : 'bad');
              render();
            }),
          })
        : null,
      button('Add model', { variant: 'primary', iconName: 'plus', onclick: () => editModel(null) })),

    enabled === 0 ? banner('warn',
      frag(el('strong', {}, 'No model is enabled. '),
        'The console works and functions still run, but the agent cannot plan or ' +
        'answer — chat will report the model as unreachable.'),
      button('Add a model', { variant: 'primary', onclick: () => editModel(null) })) : null,

    panel('Configured models', {
      count: models.length,
      foot: 'Within a purpose the lowest priority number is primary and the next enabled ' +
            'model is its fallback. Credentials are encrypted at rest and never shown again.',
    },
      models.length === 0
        ? empty('No models configured',
            'Add one endpoint and test it before saving — an unreachable model is ' +
            'otherwise only noticed by the next real chat request.',
            button('Add a model', { variant: 'primary', onclick: () => editModel(null) }),
            'models')
        : table(['Name', 'Model', 'Purpose', 'Priority', 'Stream', 'Status', 'Last OK', 'Last error'],
            models.map((model) => [
              el('button', { class: 'linkish', type: 'button', onclick: () => editModel(model) },
                model.name),
              el('span', { class: 'mono' }, model.modelId),
              model.purpose,
              model.priority,
              model.supportsStreaming ? 'yes' : 'no',
              statusBadge(model.isEnabled ? 'enabled' : 'off'),
              fmt.ago(model.lastOkAt),
              model.lastError ? el('span', { class: 'mono' }, model.lastError.slice(0, 70)) : '—',
            ]))),
  );
};

function editModel(existing) {
  const name = textInput(existing?.name ?? '', { placeholder: 'vLLM · production' });
  const baseUrl = textInput(existing?.baseUrl ?? '', { placeholder: 'http://host:8000/v1' });
  const modelId = textInput(existing?.modelId ?? '', { placeholder: 'Qwen/Qwen2.5-32B-Instruct-AWQ' });
  const apiKey = el('input', { type: 'password', placeholder: existing ? 'unchanged' : 'leave blank if none' });
  const purpose = select(
    ['any', 'planner', 'synthesizer', 'router', 'embedding'],
    existing?.purpose ?? 'any');
  const priority = el('input', { type: 'number', value: existing?.priority ?? 100 });
  const streaming = select(['yes', 'no'], existing?.supportsStreaming === false ? 'no' : 'yes');
  const enabled = select(['yes', 'no'], existing?.isEnabled === false ? 'no' : 'yes');

  const headers = textArea('', 3);
  headers.placeholder = '{"cf-aig-authorization": "Bearer …"}';

  // Prefixes are only meaningful for an embedding model, and showing them
  // against a chat model invites someone to fill them in.
  const queryPrefix = textInput(existing?.embeddingQueryPrefix ?? '');
  const passagePrefix = textInput(existing?.embeddingPassagePrefix ?? '');
  const prefixHint = el('p', { class: 'field__hint' });
  const embeddingFields = el('div', { hidden: true },
    el('div', { class: 'formgrid' },
      field('Query prefix', queryPrefix,
        'Prepended to the user\'s question before embedding.', { optional: true }),
      field('Passage prefix', passagePrefix,
        'Prepended to each stored passage.', { optional: true })),
    prefixHint);

  /**
   * Show the defaults rather than silently applying them.
   *
   * Most retrieval embedders are asymmetric — they expect the question and the
   * passage marked differently, and getting it wrong costs accuracy with no
   * error to notice. Leaving both boxes blank uses the right strings for the
   * model family; this line says which, so "blank" does not read as "off".
   *
   * The strings come from the server rather than a copy kept here, because a
   * second copy would drift and the failure would be invisible.
   */
  let defaults = { query: '', passage: '' };

  const paintPrefixHint = () => {
    const isEmbedding = purpose.value === 'embedding';
    embeddingFields.hidden = !isEmbedding;
    if (!isEmbedding) return;

    const show = (v) => (v ? `"${v}"` : 'none');
    prefixHint.textContent = queryPrefix.value || passagePrefix.value
      ? 'Using what you typed. Clear both boxes to go back to the defaults for this model.'
      : `Blank uses this model's defaults — query ${show(defaults.query)}, ` +
        `passage ${show(defaults.passage)}. Type a single space to mean "no prefix at all".`;
  };

  const loadDefaults = async () => {
    if (purpose.value !== 'embedding' || !modelId.value.trim()) {
      paintPrefixHint();
      return;
    }
    try {
      defaults = await api(
        `/models/prefix-defaults?modelId=${encodeURIComponent(modelId.value.trim())}`);
    } catch {
      // A hint that cannot be fetched is not worth an error. The server applies
      // the same defaults either way.
      defaults = { query: '', passage: '' };
    }
    paintPrefixHint();
  };

  // `change` rather than `input`, so this is one request when the field is left
  // rather than one per keystroke.
  purpose.addEventListener('change', () => void loadDefaults());
  modelId.addEventListener('change', () => void loadDefaults());
  queryPrefix.addEventListener('input', paintPrefixHint);
  passagePrefix.addEventListener('input', paintPrefixHint);
  void loadDefaults();

  const result = el('div');
  let tested = false;

  // A space is how the form says "deliberately no prefix", because an empty box
  // already means "use the default". It reaches the server as an empty string,
  // which is the distinction the model row stores.
  const prefixValue = (input) =>
    input.value === '' ? null : input.value.trim() === '' ? '' : input.value;

  /**
   * The headers box, validated.
   *
   * `parseJson` hands back the raw text when it will not parse rather than the
   * fallback, so "did this parse" cannot be answered by comparing to undefined.
   * Getting that wrong would have meant a malformed header object was silently
   * dropped and the model saved looking configured — surfacing later as an
   * unexplained 401 from the gateway.
   */
  const readHeaders = () => {
    const raw = headers.value.trim();
    if (!raw) return { ok: true, value: undefined };

    const parsed = parseJson(raw, undefined);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: 'Extra request headers must be a JSON object.' };
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        return { ok: false, message: `Header "${key}" must have a string value.` };
      }
    }
    return { ok: true, value: parsed };
  };

  const collect = () => ({
    applicationId: null,
    name: name.value.trim(),
    baseUrl: baseUrl.value.trim(),
    modelId: modelId.value.trim(),
    purpose: purpose.value,
    priority: Number(priority.value),
    supportsStreaming: streaming.value === 'yes',
    isEnabled: enabled.value === 'yes',
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
    ...(purpose.value === 'embedding'
      ? {
          embeddingQueryPrefix: prefixValue(queryPrefix),
          embeddingPassagePrefix: prefixValue(passagePrefix),
        }
      : {}),
    // Blank leaves stored headers alone; "{}" clears them.
    ...(readHeaders().value !== undefined
      ? { extraHeaders: readHeaders().value }
      : {}),
  });

  openModal(existing ? `Edit ${existing.name}` : 'Add model', frag(
    field('Display name', name, 'Only used in this console and in log lines.'),
    field('Base URL', baseUrl,
      'The OpenAI-compatible root. Usually ends in <code>/v1</code>. ' +
      '<code>/chat/completions</code> is appended for you.'),
    field('Model id', modelId,
      'Exactly the string the endpoint expects in the <code>model</code> field.'),
    field('API key', apiKey,
      existing
        ? 'Leave blank to keep the stored credential. Encrypted at rest and never shown again.'
        : 'Encrypted at rest with ENCRYPTION_KEY and never returned by any API.',
      { optional: true }),

    el('div', { class: 'formgrid' },
      field('Purpose', purpose,
        'A purpose-specific model outranks <code>any</code>, so a small fast model can ' +
        'route while something larger answers. <code>embedding</code> is the exception: ' +
        'it answers <code>/embeddings</code> rather than <code>/chat/completions</code>, ' +
        'so it is never used as a chat model and <code>any</code> is never used as an ' +
        'embedding one. Add one to turn on meaning-based knowledge search, then ' +
        're-index. <strong>Test connection does not work for it</strong> — it sends a ' +
        'chat request.'),
      field('Priority', priority, 'Lower runs first. The next enabled model is its fallback.')),

    el('div', { class: 'formgrid' },
      field('Supports streaming', streaming, 'Set no if the endpoint has no SSE support.'),
      field('Enabled', enabled, 'Disabled models are skipped entirely.')),

    embeddingFields,

    field('Extra request headers', headers,
      'JSON object, sent with every request to this endpoint. For a gateway that ' +
      'needs its own header alongside the provider\'s — Cloudflare\'s authenticated ' +
      'AI Gateway wants <code>cf-aig-authorization</code>. Encrypted at rest and ' +
      'never shown again, like the API key. ' +
      (existing?.extraHeaderNames?.length
        ? `Currently set: <code>${existing.extraHeaderNames.join('</code>, <code>')}</code>. ` +
          'Leave blank to keep them, or send <code>{}</code> to clear them.'
        : 'Leave blank if you do not need any.'),
      { optional: true }),

    result,

    el('div', { class: 'btnrow', style: 'margin-top:16px' },
      button('Test connection', {
        onclick: async (event) => busy(event.target, async () => {
          if (!baseUrl.value.trim() || !modelId.value.trim()) {
            result.replaceChildren(notice('Enter a base URL and a model id first.', 'bad'));
            return;
          }
          if (purpose.value === 'embedding') {
            result.replaceChildren(notice(
              'Test connection sends a chat request, which an embeddings endpoint ' +
              'will reject. Save the model and use Re-index on the Knowledge page ' +
              'to check it instead.', 'warn'));
            return;
          }

          const parsedHeaders = readHeaders();
          if (!parsedHeaders.ok) {
            result.replaceChildren(notice(parsedHeaders.message, 'bad'));
            return;
          }

          const outcome = await api('/models/test', {
            method: 'POST',
            body: {
              baseUrl: baseUrl.value.trim(),
              modelId: modelId.value.trim(),
              apiKey: apiKey.value || null,
              existingId: existing?.id ?? null,
              ...(parsedHeaders.value !== undefined
                ? { extraHeaders: parsedHeaders.value }
                : {}),
            },
          });
          tested = outcome.ok;
          result.replaceChildren(notice(
            outcome.ok
              ? `Reachable — replied in ${outcome.latencyMs} ms: "${outcome.reply}"`
              : outcome.error,
            outcome.ok ? 'ok' : 'bad'));
        }),
      }),
      el('div', { class: 'grow' }),
      existing
        ? button('Delete', {
            variant: 'danger',
            onclick: async () => {
              if (!confirm(`Delete model "${existing.name}"?`)) return;
              await api(`/models/${existing.id}`, { method: 'DELETE' });
              closeModal();
              render();
            },
          })
        : null,
      button('Save model', {
        variant: 'primary',
        onclick: async (event) => {
          // Headers that will not parse must not be quietly dropped. Saving
          // regardless produces a model that looks configured and sends none of
          // them, which surfaces later as an unexplained 401 from the gateway.
          const parsedHeaders = readHeaders();
          if (!parsedHeaders.ok) {
            toast(parsedHeaders.message, 'bad');
            return;
          }

          // An embedding model is never tested, because the test sends a chat
          // request. Nagging about it would train people to click through the
          // warning that does matter.
          if (!tested && purpose.value !== 'embedding' && !confirm(
            'This model has not been tested. Save it anyway?\n\n' +
            'An unreachable model is only noticed on the next real chat request.')) return;

          await busy(event.target, async () => {
            await api(existing ? `/models/${existing.id}` : '/models', {
              method: existing ? 'PUT' : 'POST',
              body: collect(),
            });
            toast('Model saved', 'ok');
            closeModal();
            render();
          });
        },
      })),
  ));
}

// ── Applications ────────────────────────────────────────────────────────────

views.applications = async () => {
  if (state.applicationId === null) {
    return frag(
      pageHead('Applications', 'One row per product calling this service.'),
      empty('No applications yet',
        'An application defines how end users are identified and owns its own ' +
        'functions, roles and keys. Creating one installs a live demo function.',
        button('Create an application', {
          variant: 'primary',
          iconName: 'plus',
          onclick: () => editApplication(null),
        }),
        'apps'));
  }

  const [{ keys }, { services }] = await Promise.all([
    api(appPath('/keys')),
    api(appPath('/services')),
  ]);

  const current = state.applications.find((application) => application.id === state.applicationId);

  return frag(
    pageHead('Applications',
      'One row per product calling this service. Nothing crosses between them.',
      button('New application', {
        variant: 'primary',
        iconName: 'plus',
        onclick: () => editApplication(null),
      })),

    panel('All applications', { count: state.applications.length },
      table(['Name', 'Slug', 'End-user auth', 'Active'],
        state.applications.map((application) => [
          el('button', { class: 'linkish', type: 'button', onclick: () => editApplication(application) },
            application.name),
          el('span', { class: 'mono' }, application.slug),
          badge(application.endUserAuth, application.endUserAuth === 'jwt' ? 'ok' : 'warn'),
          application.isActive ? 'yes' : 'no',
        ]))),

    panel(`API keys · ${current?.name ?? ''}`, {
      count: keys.length,
      tools: [button('Issue key', { variant: 'primary', iconName: 'key', onclick: createKey })],
      foot: 'A chat key is server-to-server. If this application asserts end-user identity, a key that reaches a browser lets anyone act as any of its users.',
    },
      keys.length === 0
        ? empty('No keys issued',
            'A key authenticates the calling application. Its scopes decide whether it ' +
            'can chat, manage functions, or receive trace events.',
            button('Issue a key', { variant: 'primary', onclick: createKey }),
            'key')
        : table(['Name', 'Prefix', 'Scopes', 'Last used', 'Status', ''],
            keys.map((key) => [
              key.name,
              el('span', { class: 'mono' }, key.prefix),
              key.scopes.join(', '),
              fmt.ago(key.lastUsedAt),
              statusBadge(key.revokedAt ? 'revoked' : 'active'),
              key.revokedAt ? '' : el('div', { class: 'cell-actions' },
                button('Revoke', {
                  variant: 'danger',
                  size: 'sm',
                  onclick: async () => {
                    if (!confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return;
                    await api(`/keys/${key.id}`, { method: 'DELETE' });
                    render();
                  },
                })),
            ]))),

    panel('Registered services', {
      count: services.length,
      tools: [button('Register service', { variant: 'primary', iconName: 'link', onclick: () => editService(null) })],
      foot: 'A write action names a service registered here, never a URL of its own — otherwise anyone who could author a function could make this service call an internal address. Links an action hands back to a person are rebuilt against the public URL, when one is set.',
    },
      services.length === 0
        ? empty('No services registered',
            'Write functions call back into your API. Until a service is registered, ' +
            'there is nowhere for a write action to go.',
            button('Register a service', { variant: 'primary', onclick: () => editService(null) }),
            'link')
        : table(['Name', 'Base URL (the agent calls)', 'Public URL (people open)', ''],
            services.map((service) => [
              el('button', { class: 'linkish', type: 'button', onclick: () => editService(service) },
                service.name),
              el('span', { class: 'mono' }, service.baseUrl),
              service.publicBaseUrl
                ? el('span', { class: 'mono' }, service.publicBaseUrl)
                : el('span', { class: 'muted' }, 'same as base'),
              el('div', { class: 'cell-actions' },
                button('Remove', {
                  variant: 'danger',
                  size: 'sm',
                  onclick: async () => {
                    if (!confirm(`Remove "${service.name}"? Any action naming it stops working immediately.`)) return;
                    await api(appPath(`/services/${encodeURIComponent(service.name)}`), { method: 'DELETE' });
                    render();
                  },
                })),
            ]))),
  );
};

/**
 * Register or edit an action target.
 *
 * Two URLs, because they answer different questions. `baseUrl` is where this
 * service sends requests — often an internal address. `publicBaseUrl` is where
 * a link in an answer should point, which has to work in someone's browser.
 * Leaving the second blank means they are the same, which is the common case.
 */
/**
 * Approve and take live everything that is waiting.
 *
 * An import leaves 25 functions as drafts, and clicking through two promotions
 * each is not review — it is 50 clicks nobody reads by the tenth. This walks the
 * same two endpoints one function at a time, so each still re-validates against
 * the database on the way live and a function that no longer plans still stops.
 *
 * Failures are collected rather than aborting the run: one broken function
 * should not leave the other twenty-four stranded as drafts.
 */
function releaseAllButton(pending) {
  return button(`Approve and take all ${pending.length} live`, {
    variant: 'primary',
    iconName: 'check',
    onclick: async (event) => {
      const trigger = event.currentTarget;
      trigger.disabled = true;

      const failed = [];
      let released = 0;

      for (const fn of pending) {
        const path = appPath(`/functions/${encodeURIComponent(fn.name)}/status`);
        try {
          if (fn.status === 'draft') {
            await api(path, { method: 'POST', body: { status: 'approved' } });
          }
          await api(path, { method: 'POST', body: { status: 'live' } });
          released += 1;
        } catch (error) {
          failed.push(`${fn.name}: ${error.message}`);
        }
        trigger.textContent = `Releasing… ${released + failed.length} of ${pending.length}`;
      }

      if (failed.length === 0) {
        toast(`${released} function(s) are live.`, 'ok');
      } else {
        toast(`${released} live, ${failed.length} refused. See the list.`, 'warn');
        openModal('These could not go live', frag(
          el('p', { class: 'muted' },
            'Each was re-validated against the database on the way. Fix and retry ' +
            'individually — the rest are already live.'),
          codeBlock(failed.join('\n\n'), { wrap: true }),
        ));
      }

      render();
    },
  });
}

function editService(existing) {
  const name = textInput(existing?.name ?? '', { placeholder: 'reports' });
  const baseUrl = textInput(existing?.baseUrl ?? '', { placeholder: 'http://localhost:3001/' });
  const publicBaseUrl = textInput(existing?.publicBaseUrl ?? '', { placeholder: 'https://app.example.com/' });
  if (existing) name.disabled = true;

  const save = button('Save', {
    variant: 'primary',
    onclick: async () => {
      const key = name.value.trim();
      if (!key) { toast('Name the service.', 'bad'); return; }
      try {
        await api(appPath(`/services/${encodeURIComponent(key)}`), {
          method: 'PUT',
          body: { baseUrl: baseUrl.value.trim(), publicBaseUrl: publicBaseUrl.value.trim() || null },
        });
        closeModal();
        render();
      } catch (error) {
        toast(error.message, 'bad');
      }
    },
  });

  openModal(existing ? `Service · ${existing.name}` : 'Register a service', frag(
    field('Name', name,
      'What an action names in its <code>service</code> field. Lower case, no spaces.'),
    field('Base URL', baseUrl,
      'Where this service sends the request. Reachable from wherever the agent runs — ' +
      'an internal hostname or container name is fine here.'),
    field('Public base URL', publicBaseUrl,
      'Where a link handed back to a person should point. Leave blank when the base URL ' +
      'is already something a browser can open.', { optional: true }),
    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
      button('Cancel', { onclick: closeModal }), save),
  ));
}

function editApplication(existing) {
  const name = textInput(existing?.name ?? '', { placeholder: 'Acme Support Portal' });
  const slug = textInput(existing?.slug ?? '', { placeholder: 'acme-support' });
  const auth = select(['asserted', 'jwt'], existing?.endUserAuth ?? 'asserted');
  const issuer = textInput(existing?.jwtIssuer ?? '', { placeholder: 'https://auth.example.com/' });
  const jwks = textInput(existing?.jwtJwksUrl ?? '', { placeholder: 'https://auth.example.com/.well-known/jwks.json' });
  const audience = textInput(existing?.jwtAudience ?? '');
  const roleClaim = textInput(existing?.jwtRoleClaim ?? '', { placeholder: 'role' });
  const scopeClaims = textArea(JSON.stringify(existing?.jwtScopeClaims ?? {}, null, 2), 3, 'code');

  const jwtFields = el('div', {},
    field('JWT issuer', issuer, 'Must match the <code>iss</code> claim exactly.'),
    field('JWKS URL', jwks, 'Where the signing keys are published. Fetched and cached.'),
    field('Audience', audience, 'Checked against <code>aud</code> when set.', { optional: true }),
    field('Role claim', roleClaim, 'Which claim carries the end user\'s role.'),
    field('Scope claims', scopeClaims,
      'Maps a scope key to a token claim, e.g. <code>{"org_id":"organisation_id"}</code>.'));

  const sync = () => { jwtFields.hidden = auth.value !== 'jwt'; };
  auth.addEventListener('change', sync);
  sync();

  openModal(existing ? `Edit ${existing.name}` : 'New application', frag(
    field('Name', name, 'Shown in this console and in run traces.'),
    field('Slug', slug, 'Stable identifier used in logs. Lower case, hyphens.'),
    field('End-user authentication', auth,
      '<strong>asserted</strong>: your server states who the user is in an ' +
      '<code>X-End-User</code> header, trusted because the API key authenticated the ' +
      'channel — keep those keys server-side. <strong>jwt</strong>: the agent verifies ' +
      'the end user\'s token against your JWKS, so identity is proven.'),
    jwtFields,

    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
      button(existing ? 'Save changes' : 'Create application', {
        variant: 'primary',
        onclick: async (event) => busy(event.target, async () => {
          const result = await api(existing ? `/applications/${existing.id}` : '/applications', {
            method: existing ? 'PUT' : 'POST',
            body: {
              name: name.value.trim(),
              slug: slug.value.trim(),
              endUserAuth: auth.value,
              jwtIssuer: issuer.value.trim() || null,
              jwtJwksUrl: jwks.value.trim() || null,
              jwtAudience: audience.value.trim() || null,
              jwtRoleClaim: roleClaim.value.trim() || null,
              jwtScopeClaims: parseJson(scopeClaims.value, {}),
              isActive: true,
            },
          });

          toast(result.demoInstalled
            ? 'Application created, with a live demo function to test against.'
            : 'Application saved', 'ok');
          closeModal();
          await reloadApplications(result.application?.id ?? null);
        }),
      })),
  ));
}

async function createKey() {
  const name = textInput('', { placeholder: 'web app · production' });
  const scopes = { chat: true, manage: false, trace: false };

  const checkbox = (key, label, description) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = scopes[key];
    input.onchange = () => { scopes[key] = input.checked; };
    return el('label', { class: 'checkline', style: 'margin-bottom:10px' },
      input,
      el('span', {}, el('strong', {}, label), el('br'), el('span', { class: 'muted' }, description)));
  };

  openModal('Issue an API key', frag(
    field('Name', name, 'How you will recognise this key when deciding whether to revoke it.'),
    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Scopes'),
      checkbox('chat', 'chat', 'Send messages to /v1/chat and /v1/chat/stream.'),
      checkbox('manage', 'manage', 'Read and write the function registry over the API.'),
      checkbox('trace', 'trace',
        'Receive internal trace events, which name functions and echo extracted parameters. ' +
        'An end-user surface should use a key without this.')),

    el('div', { class: 'btnrow btnrow--end' },
      button('Issue key', {
        variant: 'primary',
        onclick: async (event) => busy(event.target, async () => {
          const chosen = Object.entries(scopes).filter(([, on]) => on).map(([key]) => key);
          if (chosen.length === 0) { toast('Choose at least one scope.', 'bad'); return; }

          const { secret } = await api(appPath('/keys'), {
            method: 'POST',
            body: { name: name.value.trim() || 'unnamed key', scopes: chosen },
          });

          openModal('Key issued', frag(
            notice('Copy this now. It is hashed on the server and never shown again.', 'warn'),
            codeBlock(secret, { wrap: true }),
            el('div', { class: 'btnrow btnrow--end', style: 'margin-top:14px' },
              button('Done', { variant: 'primary', onclick: () => { closeModal(); render(); } }))));
        }),
      })),
  ));
}

// ── Conversations & audit ───────────────────────────────────────────────────

views.conversations = async () => {
  const { conversations } = await api(appPath('/conversations'));

  return frag(
    pageHead('Conversations', 'Every exchange this application\'s users have had with the agent.',
      button('Refresh', { iconName: 'refresh', onclick: render })),

    panel('Recent conversations', { count: conversations.length },
      conversations.length === 0
        ? empty('No conversations yet',
            'They appear here as soon as an end user sends a message.', null, 'chat')
        : table(['Started by', 'Role', 'Title', 'Messages', 'Updated'],
            conversations.map((conversation) => [
              conversation.endUserId,
              conversation.endUserRole,
              el('button', {
                class: 'linkish',
                type: 'button',
                onclick: () => showTranscript(conversation.conversationKey),
              }, conversation.title || '(untitled)'),
              conversation.messageCount,
              fmt.ago(conversation.updatedAt),
            ]))),
  );
};

async function showTranscript(key) {
  const { messages } = await api(`/conversations/${key}`);
  const superseded = messages.filter((message) => message.supersededAt).length;

  openModal('Transcript', frag(
    // A turn the user edited away is still part of what happened, and it is
    // often the explanation for an answer that otherwise reads as a non
    // sequitur. Shown, dimmed, in place.
    superseded
      ? notice(
          `${superseded} turn(s) were replaced when someone edited an earlier message. ` +
          'The agent no longer reads them; they are shown here dimmed, in the order they happened.',
          'info')
      : null,

    ...messages.map((message) =>
      el('div', {
        class: 'card',
        style: 'padding:12px 14px;margin-bottom:10px' +
          (message.supersededAt ? ';opacity:.55;border-style:dashed' : ''),
      },
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' },
          badge(message.role, message.role === 'user' ? 'info' : ''),
          el('span', { class: 'faint', style: 'font-size:11.5px' }, fmt.time(message.createdAt)),
          message.supersededAt ? badge('replaced', 'warn') : null),
        el('div', {
          style: 'font-size:13.5px;line-height:1.6;white-space:pre-wrap' +
            (message.supersededAt ? ';text-decoration:line-through' : ''),
        }, message.content))),
  ), { wide: true });
}

views.audit = async () => {
  const { entries } = await api('/audit?limit=200');
  const refused = entries.filter((entry) => entry.status === 'denied').length;

  return frag(
    pageHead('Audit log',
      'Every function call, including the ones that were refused. This is the record ' +
      'of what the agent actually did on someone\'s behalf.',
      button('Refresh', { iconName: 'refresh', onclick: render })),

    el('div', { class: 'grid' },
      kpi('Entries shown', fmt.num(entries.length), { iconName: 'audit' }),
      kpi('Refused', fmt.num(refused), { tone: refused ? 'warn' : 'ok', iconName: 'shield' })),

    panel('Calls', {
      count: entries.length,
      foot: 'Search terms are recorded on purpose — knowing what was asked for is most of ' +
            'the value — but parameters named like credentials are masked and long strings truncated.',
    },
      entries.length === 0
        ? empty('Nothing audited yet',
            'Every call is recorded here — successful, failed and rejected alike.', null, 'audit')
        : table(['When', 'Function', 'Status', 'User', 'Params', 'Scopes', 'Rows', 'Latency'],
            entries.map((entry) => [
              fmt.time(entry.created_at),
              entry.function_name,
              statusBadge(entry.status),
              `${entry.end_user_id} (${entry.end_user_role})`,
              el('span', { class: 'mono' }, JSON.stringify(entry.params)),
              el('span', { class: 'mono' }, JSON.stringify(entry.scopes_applied)),
              entry.row_count ?? '—',
              fmt.ms(entry.latency_ms),
            ]))),
  );
};

// ── Database ────────────────────────────────────────────────────────────────

views.database = async () => {
  const [report, { tables }] = await Promise.all([
    api('/database'),
    api('/database/tables').catch(() => ({ tables: [] })),
  ]);

  const assertion = report.writeAssertion;
  const missing = tables.filter((entry) => !entry.exists);

  const guard = !assertion.enforced
    ? banner('bad', frag(
        el('strong', {}, 'The write guard is disabled. '),
        'DB_ALLOW_WRITABLE_READ_POOL is set, so a mistake in a registry function could ' +
        'modify or delete data. Local development only.'))
    : assertion.passed
      ? banner('ok', frag(
          el('strong', {}, 'The read connection cannot write. '),
          assertion.basis === 'standby'
            ? 'The server is a standby in recovery, so it cannot accept a write at all.'
            : 'This role holds no INSERT, UPDATE, DELETE or TRUNCATE privilege on any table.',
          ' This is what makes administrator-authored SQL safe to run.'))
      : banner('bad', frag(
          el('strong', {}, 'The read connection has not been opened. '),
          report.readStatus.error ?? 'The write assertion did not pass.',
          assertion.writableTables.length
            ? ` Writable tables include: ${assertion.writableTables.join(', ')}.`
            : ''));

  return frag(
    pageHead('Database',
      'Both connections, what they can reach, and the guarantee that keeps registry ' +
      'SQL from writing.',
      button('Re-check', {
        iconName: 'refresh',
        onclick: async (event) => busy(event.target, async () => {
          await fetch('/admin/api/setup/check', { method: 'POST', credentials: 'same-origin' });
          toast('Reconnected', 'ok');
          render();
        }),
      })),

    guard,

    assertion.creatableSchemas?.length
      ? notice(
          `The read role can CREATE objects in: ${assertion.creatableSchemas.join(', ')}. ` +
          'It cannot alter existing data, but a read-only role should not hold this either.',
          'warn')
      : null,

    el('div', { class: 'grid' },
      ...report.connections.map((connection) =>
        kpi(connection.role === 'primary' ? 'Primary' : 'Read-only',
          connection.reachable ? `${connection.latencyMs} ms` : 'unreachable', {
            tone: connection.reachable ? 'ok' : 'bad',
            iconName: 'database',
            note: connection.serverVersion ?? connection.error?.slice(0, 40) ?? '',
          })),
      kpi('Agent tables', `${report.agentTables} / ${report.expectedAgentTables}`, {
        tone: missing.length ? 'warn' : 'ok',
        iconName: 'apps',
        note: `schema "${report.schema}"`,
      }),
      kpi('Statement timeout', `${report.statementTimeoutMs} ms`, { iconName: 'clock' })),

    ...report.connections.map(connectionPanel),

    panel('What the agent can read', { count: report.visibleTables.length },
      report.visibleTables.length === 0
        ? empty('The read connection can see no tables',
            'Registry functions will return nothing until the read role is granted SELECT.',
            null, 'database')
        : table(['Schema', 'Tables the read role can SELECT'],
            report.visibleTables.map((entry) => [entry.schema, fmt.num(entry.tables)]))),

    panel('The agent\'s own tables', {
      count: tables.length,
      foot: `Every table this service owns is named agent_* and lives in the "${report.schema}" schema. Nothing outside that prefix belongs to it.`,
    },
      el('div', { class: 'panel__body' },
        el('div', { class: 'tablegrid' },
          ...tables.map((entry) => el('div', {},
            el('span', { class: entry.exists ? 'tick' : 'cross' }, entry.exists ? '✓' : '✗'),
            entry.name))))),
  );
};

function connectionPanel(connection) {
  return panel(connection.role === 'primary' ? 'Primary connection' : 'Read-only connection', {
    tools: [badge(
      connection.reachable ? `connected · ${connection.latencyMs} ms` : 'unreachable',
      connection.reachable ? 'ok' : 'bad')],
    foot: connection.purpose,
  },
    connection.error ? el('div', { class: 'panel__body' }, notice(connection.error, 'bad')) : null,
    table(['Field', 'Value'], [
      ['Connection', el('span', { class: 'mono' }, connection.redactedUrl)],
      ['Host', `${connection.host}:${connection.port}`],
      ['Database', connection.database],
      ['User', connection.user],
      ['SSL', connection.ssl ? 'yes' : 'no'],
      ['Server', connection.serverVersion ?? '—'],
      ['Pool', `${connection.pool.total} open · ${connection.pool.idle} idle · ` +
               `${connection.pool.waiting} waiting · max ${connection.pool.max}`],
    ]));
}
