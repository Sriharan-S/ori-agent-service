/* Operator console.
 *
 * Plain DOM, no framework, no build step. The console is the thing you reach
 * for when something is wrong, so it should have as few moving parts as
 * possible and no dependency it has to fetch to render.
 */

const state = {
  user: null,
  applications: [],
  applicationId: null,
  view: 'overview',
  timer: null,
};

// ── Plumbing ────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (response.status === 401) {
    showLogin();
    throw new Error('Signed out');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

function toast(message, kind = '') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 4000);
}

function openModal(title, body) {
  document.getElementById('modal-title').textContent = title;
  const host = document.getElementById('modal-body');
  host.replaceChildren(body);
  document.getElementById('modal').hidden = false;
}

function closeModal() {
  document.getElementById('modal').hidden = true;
}

const fmt = {
  ms: (value) => (value === null || value === undefined ? '—' : `${value} ms`),
  pct: (value) => `${Math.round((value || 0) * 100)}%`,
  time: (value) => (value ? new Date(value).toLocaleString() : '—'),
  ago: (value) => {
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  },
};

// ── Session ─────────────────────────────────────────────────────────────────

function showLogin() {
  clearInterval(state.timer);
  document.getElementById('login').hidden = false;
  document.getElementById('app').hidden = true;
}

async function boot() {
  try {
    const { user } = await api('/me');
    state.user = user;
  } catch {
    showLogin();
    return;
  }

  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('whoami').textContent = `${state.user.email} · ${state.user.role}`;

  const { applications } = await api('/applications');
  state.applications = applications;
  state.applicationId = applications[0]?.id ?? null;

  const select = document.getElementById('app-select');
  select.replaceChildren(
    ...applications.map((app) => el('option', { value: app.id }, app.name)),
  );
  select.value = state.applicationId ?? '';
  select.onchange = () => {
    state.applicationId = Number(select.value);
    render();
  };

  render();
}

document.getElementById('login-form').onsubmit = async (event) => {
  event.preventDefault();
  const error = document.getElementById('login-error');
  error.hidden = true;

  try {
    await api('/login', {
      method: 'POST',
      body: {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      },
    });
    await boot();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
};

document.getElementById('logout').onclick = async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};

document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal').onclick = (event) => {
  if (event.target.id === 'modal') closeModal();
};

for (const button of document.querySelectorAll('#tabs button')) {
  button.onclick = () => {
    for (const other of document.querySelectorAll('#tabs button')) {
      other.classList.toggle('active', other === button);
    }
    state.view = button.dataset.view;
    render();
  };
}

// ── Views ───────────────────────────────────────────────────────────────────

const views = {};

async function render() {
  clearInterval(state.timer);
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));

  try {
    const node = await views[state.view]();
    main.replaceChildren(node);
  } catch (error) {
    main.replaceChildren(el('div', { class: 'empty' }, error.message));
  }
}

views.overview = async () => {
  const { overview, active, recent } = await api('/overview');

  // Activity is the one view worth polling: it is what you watch while
  // something is happening.
  state.timer = setInterval(() => {
    if (state.view === 'overview') render();
  }, 5000);

  const stats = el('div', { class: 'grid' },
    stat('Runs · last hour', overview.runsLastHour),
    stat('Runs · 24h', overview.runsLast24h),
    stat('In flight', overview.activeRuns, overview.activeRuns > 0 ? 'ok' : ''),
    stat('Failed · 24h', overview.failuresLast24h, overview.failuresLast24h > 0 ? 'bad' : ''),
    stat('Median latency', fmt.ms(overview.medianLatencyMs)),
    stat('p95 latency', fmt.ms(overview.p95LatencyMs)),
    stat('Asked to clarify', fmt.pct(overview.clarificationRate)),
    stat('Denied · 24h', overview.deniedLast24h, overview.deniedLast24h > 0 ? 'bad' : ''),
  );

  return el('div', {},
    stats,
    section('Active connections',
      active.length === 0
        ? el('div', { class: 'empty' }, 'Nothing running right now.')
        : table(
            ['Run', 'Application', 'User', 'Intent', 'Mode', 'Age'],
            active.map((run) => [
              el('span', { class: 'mono' }, run.runKey.slice(0, 8)),
              run.applicationSlug,
              `${run.endUserId} (${run.endUserRole})`,
              run.intent || '—',
              run.streamed ? 'streaming' : 'request',
              `${Math.round(run.ageMs / 1000)}s`,
            ]),
          ),
    ),
    section('Recent runs',
      table(
        ['Run', 'User', 'Intent', 'Result', 'Functions', 'Latency', 'When'],
        recent.map((run) => [
          el('span', {
            class: 'mono clickable',
            onclick: () => showRun(run.runKey),
          }, run.runKey.slice(0, 8)),
          `${run.endUserId} (${run.endUserRole})`,
          run.intent || '—',
          el('span', { class: `pill ${run.status === 'failed' ? 'failed' : run.responseType || ''}` },
            run.status === 'failed' ? 'failed' : run.responseType || run.status),
          run.functionsUsed.join(', ') || '—',
          fmt.ms(run.latencyMs),
          fmt.ago(run.startedAt),
        ]),
      ),
    ),
    el('p', { class: 'hint' }, 'Click a run id to see every step it took.'),
  );
};

async function showRun(runKey) {
  const { run, calls } = await api(`/runs/${runKey}`);

  openModal(`Run ${runKey.slice(0, 8)}`, el('div', {},
    el('div', { class: 'grid' },
      stat('Status', run?.status ?? '—'),
      stat('Latency', fmt.ms(run?.latency_ms)),
      stat('Intent', run?.intent ?? '—'),
    ),
    run?.error ? el('div', { class: 'issue error' }, run.error) : null,
    section('Function calls',
      calls.length === 0
        ? el('div', { class: 'empty' }, 'No functions were called.')
        : table(
            ['Function', 'Status', 'Params', 'Scopes applied', 'Rows', 'Latency'],
            calls.map((call) => [
              call.function_name,
              el('span', { class: `pill ${call.status}` }, call.status),
              el('span', { class: 'mono' }, JSON.stringify(call.params)),
              el('span', { class: 'mono' }, JSON.stringify(call.scopes_applied)),
              call.row_count ?? '—',
              fmt.ms(call.latency_ms),
            ]),
          ),
    ),
  ));
}

views.functions = async () => {
  const { functions } = await api(`/applications/${state.applicationId}/functions`);

  return el('div', {},
    el('div', { class: 'section' },
      el('header', {},
        el('h2', {}, 'Functions'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: () => editFunction(null) }, 'New function'),
      ),
      functions.length === 0
        ? el('div', { class: 'empty' }, 'No functions yet. The agent can only do what is defined here.')
        : table(
            ['Name', 'Kind', 'Returns', 'Roles', 'Status', 'Version', ''],
            functions.map((fn) => [
              el('span', { class: 'clickable', onclick: () => editFunction(fn) }, fn.name),
              fn.kind,
              fn.returns,
              fn.allowedRoles.join(', ') || '—',
              el('span', { class: `pill ${fn.status}` }, fn.status),
              `v${fn.version}`,
              statusActions(fn),
            ]),
          ),
    ),
    el('p', { class: 'hint' },
      'Only live functions are visible to the planner or reachable by the agent. ' +
      'Editing a live function returns it to draft — an approval covers the version that was reviewed.'),
  );
};

function statusActions(fn) {
  const wrap = el('div', { class: 'row' });

  if (fn.status === 'draft') {
    wrap.append(el('button', {
      class: 'ghost',
      onclick: () => setStatus(fn.name, 'approved'),
    }, 'Approve'));
  }
  if (fn.status === 'approved') {
    wrap.append(el('button', {
      class: 'primary',
      onclick: () => setStatus(fn.name, 'live'),
    }, 'Go live'));
  }
  if (fn.status === 'live') {
    wrap.append(el('button', {
      class: 'danger',
      onclick: () => setStatus(fn.name, 'disabled'),
    }, 'Disable'));
  }
  if (fn.status === 'disabled') {
    wrap.append(el('button', {
      class: 'ghost',
      onclick: () => setStatus(fn.name, 'approved'),
    }, 'Re-approve'));
  }

  return wrap;
}

async function setStatus(name, status) {
  try {
    await api(`/applications/${state.applicationId}/functions/${name}/status`, {
      method: 'POST',
      body: { status },
    });
    toast(`${name} is now ${status}`, 'ok');
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function editFunction(existing) {
  const form = el('div', {});
  const field = (label, node, hint) => {
    form.append(el('label', {}, label, node), hint ? el('p', { class: 'hint' }, hint) : null);
    return node;
  };

  const name = field('Name', el('input', { value: existing?.name ?? '' }),
    'lower_snake_case. This is what the planner sees.');
  const kind = field('Kind', select(['read', 'write'], existing?.kind ?? 'read'));
  const description = field('Description',
    el('textarea', { rows: 3 }, existing?.description ?? ''),
    'Say what it returns and which identifiers it accepts. The planner chooses almost entirely on this.');
  const whenToUse = field('When to use (one per line)',
    el('textarea', { rows: 3 }, (existing?.whenToUse ?? []).join('\n')));
  const whenNotToUse = field('When NOT to use (one per line)',
    el('textarea', { rows: 2 }, (existing?.whenNotToUse ?? []).join('\n')),
    'Point at the neighbouring function whenever two are plausibly confusable.');
  const returns = field('Returns',
    select(['single', 'list', 'single-or-ambiguous', 'confirmation'], existing?.returns ?? 'list'));
  const ambiguityResolvesTo = field('Ambiguity resolves into parameter',
    el('input', { value: existing?.ambiguityResolvesTo ?? '' }),
    'Required for single-or-ambiguous. The parameter a chosen candidate id is written into.');
  const allowedRoles = field('Allowed roles (comma separated, or *)',
    el('input', { value: (existing?.allowedRoles ?? []).join(', ') }));
  const parameters = field('Parameters (JSON)',
    el('textarea', { rows: 8 }, JSON.stringify(existing?.parameters ?? {}, null, 2)));
  const requiredOneOf = field('Required one-of groups (JSON)',
    el('textarea', { rows: 2 }, JSON.stringify(existing?.requiredOneOf ?? [], null, 2)));
  const scopeFilters = field('Scope filters (JSON)',
    el('textarea', { rows: 3 }, JSON.stringify(existing?.scopeFilters ?? [], null, 2)),
    'e.g. [{"key":"org_id","column":"r.org_id"}]. Each must appear as {{scope:key}} in the SQL.');
  const sqlTemplate = field('SQL template',
    el('textarea', { rows: 14 }, existing?.sqlTemplate ?? ''),
    'Use {{param:name}} and {{scope:key}}. Never $1 — the engine assigns placeholders. No SELECT *. LIMIT is added for you.');
  const httpRequest = field('HTTP action (JSON, write functions)',
    el('textarea', { rows: 6 }, JSON.stringify(existing?.httpRequest ?? null, null, 2)));
  const writeScope = field('Write scope', el('input', { value: existing?.writeScope ?? '' }));

  const issues = el('div', { class: 'issues' });
  const actions = el('div', { class: 'row' });

  const collect = () => ({
    name: name.value.trim(),
    kind: kind.value,
    description: description.value.trim(),
    whenToUse: lines(whenToUse.value),
    whenNotToUse: lines(whenNotToUse.value),
    returns: returns.value,
    ambiguityResolvesTo: ambiguityResolvesTo.value.trim() || null,
    allowedRoles: whenNotEmpty(allowedRoles.value),
    parameters: parseJson(parameters.value, {}),
    requiredOneOf: parseJson(requiredOneOf.value, []),
    scopeFilters: parseJson(scopeFilters.value, []),
    sqlTemplate: sqlTemplate.value.trim() || null,
    httpRequest: parseJson(httpRequest.value, null),
    writeScope: writeScope.value.trim() || null,
  });

  const showReport = ({ validation, similar }) => {
    const nodes = [];

    if (validation.ok && validation.issues.length === 0) {
      nodes.push(el('div', { class: 'issue ok' }, 'Valid. Postgres planned this query successfully.'));
    }

    for (const issue of validation.issues) {
      nodes.push(el('div', { class: `issue ${issue.severity}` }, issue.message));
    }

    for (const match of similar ?? []) {
      nodes.push(el('div', { class: 'issue warning' },
        `"${match.name}" is described similarly (${Math.round(match.similarity * 100)}% overlap). ` +
        'Two functions the planner cannot tell apart will be confused whatever the retriever does.'));
    }

    if (validation.columns) {
      nodes.push(el('div', { class: 'issue ok' }, `Returns: ${validation.columns.join(', ')}`));
    }
    if (validation.plan) {
      nodes.push(el('pre', { class: 'plan' }, validation.plan));
    }

    issues.replaceChildren(...nodes);
  };

  actions.append(
    el('button', {
      class: 'ghost',
      onclick: async () => {
        try {
          showReport(await api(
            `/applications/${state.applicationId}/functions/check`,
            { method: 'POST', body: collect() },
          ));
        } catch (error) { toast(error.message, 'bad'); }
      },
    }, 'Validate'),
    el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const body = collect();
          const path = existing
            ? `/applications/${state.applicationId}/functions/${existing.name}`
            : `/applications/${state.applicationId}/functions`;

          const result = await api(path, {
            method: existing ? 'PUT' : 'POST',
            body,
          });

          showReport(result);
          toast(
            result.validation.ok
              ? `Saved as draft. Approve it, then take it live.`
              : `Saved as draft, but it does not validate — it cannot go live until it does.`,
            result.validation.ok ? 'ok' : 'bad',
          );
          if (result.validation.ok) { closeModal(); render(); }
        } catch (error) { toast(error.message, 'bad'); }
      },
    }, existing ? 'Save changes' : 'Create'),
    existing
      ? el('button', {
          class: 'danger',
          onclick: async () => {
            if (!confirm(`Delete "${existing.name}"? Its version history goes too.`)) return;
            await api(`/applications/${state.applicationId}/functions/${existing.name}`, { method: 'DELETE' });
            closeModal(); render();
          },
        }, 'Delete')
      : null,
  );

  form.append(issues, actions);
  openModal(existing ? `Edit ${existing.name}` : 'New function', form);

  if (existing?.validationError) {
    issues.replaceChildren(el('div', { class: 'issue error' }, existing.validationError));
  }
}

views.roles = async () => {
  const { roles } = await api(`/applications/${state.applicationId}/roles`);

  return el('div', {},
    el('div', { class: 'section' },
      el('header', {},
        el('h2', {}, 'Roles'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: () => editRole(null) }, 'New role'),
      ),
      roles.length === 0
        ? el('div', { class: 'empty' }, 'No roles defined. A caller whose role is not defined here is refused.')
        : table(
            ['Name', 'Allowed functions', 'Write scopes', 'Exempt from scopes'],
            roles.map((role) => [
              el('span', { class: 'clickable', onclick: () => editRole(role) }, role.name),
              role.allowedFunctions.join(', ') || '—',
              role.writeScopes.join(', ') || '—',
              role.unscopedKeys.join(', ') || '—',
            ]),
          ),
    ),
    el('p', { class: 'hint' },
      'A role exempt from a scope key sees every value of it. A role that is not must supply one, ' +
      'or functions declaring that scope are refused — never run unscoped.'),
  );
};

function editRole(existing) {
  const form = el('div', {});
  const name = el('input', { value: existing?.name ?? '' });
  const allowed = el('input', { value: (existing?.allowedFunctions ?? []).join(', ') });
  const writes = el('input', { value: (existing?.writeScopes ?? []).join(', ') });
  const unscoped = el('input', { value: (existing?.unscopedKeys ?? []).join(', ') });

  form.append(
    el('label', {}, 'Role name', name),
    el('label', {}, 'Allowed functions (comma separated, or *)', allowed),
    el('label', {}, 'Write scopes', writes),
    el('label', {}, 'Exempt from scope keys', unscoped),
    el('p', { class: 'hint' }, 'Exemption is how an administrator role sees across every tenant. Grant it deliberately.'),
    el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          await api(`/applications/${state.applicationId}/roles/${name.value.trim()}`, {
            method: 'PUT',
            body: {
              allowedFunctions: whenNotEmpty(allowed.value),
              writeScopes: whenNotEmpty(writes.value),
              unscopedKeys: whenNotEmpty(unscoped.value),
            },
          });
          toast('Role saved', 'ok');
          closeModal(); render();
        } catch (error) { toast(error.message, 'bad'); }
      },
    }, 'Save role'),
  );

  openModal(existing ? `Edit ${existing.name}` : 'New role', form);
}

views.models = async () => {
  const { models } = await api('/models');

  return el('div', {},
    el('div', { class: 'section' },
      el('header', {},
        el('h2', {}, 'Models'),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'ghost',
          onclick: async () => {
            const { results } = await api('/models/health', {
              method: 'POST',
              body: { applicationId: state.applicationId },
            });
            toast(results.map((r) => `${r.model}: ${r.ok ? 'ok' : r.error}`).join(' · '),
              results.every((r) => r.ok) ? 'ok' : 'bad');
          },
        }, 'Check health'),
        el('button', { class: 'primary', onclick: () => editModel(null) }, 'Add model'),
      ),
      models.length === 0
        ? el('div', { class: 'empty' }, 'No models configured. The agent cannot plan or answer without one.')
        : table(
            ['Name', 'Model', 'Purpose', 'Priority', 'Streaming', 'Enabled', 'Last OK', 'Last error'],
            models.map((model) => [
              el('span', { class: 'clickable', onclick: () => editModel(model) }, model.name),
              el('span', { class: 'mono' }, model.modelId),
              model.purpose,
              model.priority,
              model.supportsStreaming ? 'yes' : 'no',
              el('span', { class: `pill ${model.isEnabled ? 'live' : 'disabled'}` },
                model.isEnabled ? 'enabled' : 'off'),
              fmt.time(model.lastOkAt),
              model.lastError ? el('span', { class: 'mono' }, model.lastError.slice(0, 60)) : '—',
            ]),
          ),
    ),
    el('p', { class: 'hint' },
      'Within a purpose, the lowest priority number is primary and the next enabled model is its fallback. ' +
      'Credentials are encrypted at rest and never shown again.'),
  );
};

function editModel(existing) {
  const form = el('div', {});
  const name = el('input', { value: existing?.name ?? '' });
  const baseUrl = el('input', { value: existing?.baseUrl ?? '', placeholder: 'http://host:8000/v1' });
  const modelId = el('input', { value: existing?.modelId ?? '' });
  const apiKey = el('input', { type: 'password', placeholder: existing ? 'unchanged' : '' });
  const purpose = select(['any', 'planner', 'synthesizer', 'router'], existing?.purpose ?? 'any');
  const priority = el('input', { type: 'number', value: existing?.priority ?? 100 });
  const streaming = select(['yes', 'no'], existing?.supportsStreaming === false ? 'no' : 'yes');
  const enabled = select(['yes', 'no'], existing?.isEnabled === false ? 'no' : 'yes');

  form.append(
    el('label', {}, 'Display name', name),
    el('label', {}, 'Base URL (OpenAI-compatible)', baseUrl),
    el('label', {}, 'Model id', modelId),
    el('label', {}, 'API key', apiKey),
    el('label', {}, 'Purpose', purpose),
    el('label', {}, 'Priority (lower runs first)', priority),
    el('label', {}, 'Supports streaming', streaming),
    el('label', {}, 'Enabled', enabled),
    el('button', {
      class: 'primary',
      onclick: async () => {
        const body = {
          applicationId: null,
          name: name.value.trim(),
          baseUrl: baseUrl.value.trim(),
          modelId: modelId.value.trim(),
          purpose: purpose.value,
          priority: Number(priority.value),
          supportsStreaming: streaming.value === 'yes',
          isEnabled: enabled.value === 'yes',
          ...(apiKey.value ? { apiKey: apiKey.value } : {}),
        };

        try {
          await api(existing ? `/models/${existing.id}` : '/models', {
            method: existing ? 'PUT' : 'POST',
            body,
          });
          toast('Model saved', 'ok');
          closeModal(); render();
        } catch (error) { toast(error.message, 'bad'); }
      },
    }, 'Save model'),
    existing
      ? el('button', {
          class: 'danger',
          onclick: async () => {
            await api(`/models/${existing.id}`, { method: 'DELETE' });
            closeModal(); render();
          },
        }, 'Delete')
      : null,
  );

  openModal(existing ? `Edit ${existing.name}` : 'Add model', form);
}

views.applications = async () => {
  const [{ keys }, { services }] = await Promise.all([
    api(`/applications/${state.applicationId}/keys`),
    api(`/applications/${state.applicationId}/services`),
  ]);

  return el('div', {},
    el('div', { class: 'section' },
      el('header', {},
        el('h2', {}, 'API keys'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: createKey }, 'Issue key'),
      ),
      table(
        ['Name', 'Prefix', 'Scopes', 'Last used', 'Status', ''],
        keys.map((key) => [
          key.name,
          el('span', { class: 'mono' }, key.prefix),
          key.scopes.join(', '),
          fmt.time(key.lastUsedAt),
          el('span', { class: `pill ${key.revokedAt ? 'disabled' : 'live'}` },
            key.revokedAt ? 'revoked' : 'active'),
          key.revokedAt ? null : el('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return;
              await api(`/keys/${key.id}`, { method: 'DELETE' });
              render();
            },
          }, 'Revoke'),
        ]),
      ),
    ),
    el('p', { class: 'hint' },
      'A chat key is server-to-server. If this application asserts end-user identity, a key that reaches ' +
      'a browser lets anyone act as any of its users.'),
    el('div', { class: 'section' },
      el('header', {}, el('h2', {}, 'Services')),
      services.length === 0
        ? el('div', { class: 'empty' }, 'No services registered. Write actions can only target a registered service.')
        : table(['Name', 'Base URL'], services.map((s) => [s.name, el('span', { class: 'mono' }, s.baseUrl)])),
    ),
  );
};

async function createKey() {
  const name = prompt('Name this key (e.g. "web app · production")');
  if (!name) return;

  const scopes = prompt('Scopes, comma separated: chat, manage, trace', 'chat');
  if (!scopes) return;

  const { secret } = await api(`/applications/${state.applicationId}/keys`, {
    method: 'POST',
    body: { name, scopes: whenNotEmpty(scopes) },
  });

  openModal('Key issued', el('div', {},
    el('p', {}, 'Copy this now — it is never shown again.'),
    el('pre', { class: 'plan' }, secret),
  ));
}

views.conversations = async () => {
  const { conversations } = await api(`/applications/${state.applicationId}/conversations`);

  return el('div', { class: 'section' },
    el('header', {}, el('h2', {}, 'Conversations')),
    conversations.length === 0
      ? el('div', { class: 'empty' }, 'No conversations yet.')
      : table(
          ['Started by', 'Role', 'Title', 'Messages', 'Updated'],
          conversations.map((conversation) => [
            conversation.endUserId,
            conversation.endUserRole,
            el('span', {
              class: 'clickable',
              onclick: () => showTranscript(conversation.conversationKey),
            }, conversation.title || '(untitled)'),
            conversation.messageCount,
            fmt.ago(conversation.updatedAt),
          ]),
        ),
  );
};

async function showTranscript(key) {
  const { messages } = await api(`/conversations/${key}`);

  openModal('Transcript', el('div', {},
    ...messages.map((message) => el('div', { class: 'card', style: 'margin-bottom:8px' },
      el('h3', {}, `${message.role} · ${fmt.time(message.createdAt)}`),
      el('div', {}, message.content),
    )),
  ));
}

views.audit = async () => {
  const { entries } = await api('/audit?limit=200');

  return el('div', { class: 'section' },
    el('header', {}, el('h2', {}, 'Audit log')),
    table(
      ['When', 'Function', 'Status', 'User', 'Params', 'Scopes', 'Rows', 'Latency'],
      entries.map((entry) => [
        fmt.time(entry.created_at),
        entry.function_name,
        el('span', { class: `pill ${entry.status}` }, entry.status),
        `${entry.end_user_id} (${entry.end_user_role})`,
        el('span', { class: 'mono' }, JSON.stringify(entry.params)),
        el('span', { class: 'mono' }, JSON.stringify(entry.scopes_applied)),
        entry.row_count ?? '—',
        fmt.ms(entry.latency_ms),
      ]),
    ),
  );
};

// ── Small helpers ───────────────────────────────────────────────────────────

function stat(label, value, kind = '') {
  return el('div', { class: 'card' },
    el('h3', {}, label),
    el('div', { class: `stat ${kind}` }, value),
  );
}

function section(title, ...body) {
  return el('div', { class: 'section' }, el('header', {}, el('h2', {}, title)), ...body);
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {}, ...headers.map((header) => el('th', {}, header)))),
      el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((cell) => el('td', {}, cell))))),
    ),
  );
}

function select(options, value) {
  const node = el('select', {}, ...options.map((option) => el('option', { value: option }, option)));
  node.value = value;
  return node;
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function whenNotEmpty(text) {
  return text.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseJson(text, fallback) {
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    // Returning the fallback would silently discard what was typed; the server
    // rejects it and says so, which is the honest outcome.
    return text;
  }
}

boot();
