/* The function editor.
 *
 * A page rather than a modal. Authoring a function means a name, a description
 * the planner chooses on, a parameter schema, scope filters and a SQL body —
 * that is a form you scroll for a minute, and a modal you can lose to the
 * Escape key is the wrong container for it.
 *
 * Every input says what it is and what reads it. A field labelled
 * "Ambiguity resolves into parameter" means nothing on its own; the difference
 * between a registry someone can maintain and one they cannot is whether the
 * form explains itself.
 */

import {
  el, frag, mount, notice, codeBlock, button, field, textInput, textArea,
  select, table, panel, statusBadge, empty, toast, busy, openModal, closeModal,
  lines, csv, parseJson, pageHead, fmt,
} from './ui.js';
import { api, appPath, navigate } from './app.js';

const SQL_EXAMPLE = `SELECT o.id                AS id,
       o.reference         AS label,
       o.status || ' · ' || to_char(o.placed_at, 'DD Mon') AS detail,
       CASE WHEN o.reference = {{param:reference}} THEN 100 ELSE 60 END AS match_score,
       o.status, o.total_amount, o.placed_at
  FROM orders o
 WHERE o.reference ILIKE '%' || {{param:reference}} || '%'
   AND {{scope:org_id}}`;

const PARAMS_EXAMPLE = `{
  "reference": {
    "type": "string",
    "required": true,
    "description": "Order reference, whole or partial"
  }
}`;

export async function functionEditor(name) {
  const existing = name
    ? (await api(appPath(`/functions/${encodeURIComponent(name)}`))).function
    : null;

  if (name && !existing) {
    return empty('No such function',
      `Nothing in this application's registry is called "${name}".`,
      button('Back to functions', { onclick: () => navigate('#/functions') }),
      'functions');
  }

  const inputs = buildInputs(existing);
  mount(inputs.readSection, readSectionBody(inputs));
  mount(inputs.writeSection, writeSectionBody(inputs));

  const report = el('div');
  const sidePanels = el('div', { class: 'editor__side' });

  const collect = () => ({
    name: inputs.name.value.trim(),
    kind: inputs.kind.value,
    description: inputs.description.value.trim(),
    whenToUse: lines(inputs.whenToUse.value),
    whenNotToUse: lines(inputs.whenNotToUse.value),
    returns: inputs.returns.value,
    ambiguityResolvesTo: inputs.ambiguityResolvesTo.value.trim() || null,
    allowedRoles: csv(inputs.allowedRoles.value),
    parameters: parseJson(inputs.parameters.value, {}),
    requiredOneOf: parseJson(inputs.requiredOneOf.value, []),
    scopeFilters: parseJson(inputs.scopeFilters.value, []),
    sqlTemplate: inputs.sqlTemplate.value.trim() || null,
    httpRequest: parseJson(inputs.httpRequest.value, null),
    writeScope: inputs.writeScope.value.trim() || null,
    requiresConfirmation: inputs.requiresConfirmation.checked,
  });

  const showReport = ({ validation, similar }) => {
    const nodes = [];

    if (validation.ok && validation.issues.length === 0) {
      nodes.push(notice('Valid. Postgres parsed and planned this query.', 'ok'));
    }
    for (const issue of validation.issues ?? []) {
      nodes.push(notice(issue.message, issue.severity === 'error' ? 'bad' : 'warn'));
    }
    for (const match of similar ?? []) {
      nodes.push(notice(
        `"${match.name}" is described similarly (${Math.round(match.similarity * 100)}% overlap). ` +
        'Two functions the planner cannot tell apart will be confused whatever the ' +
        'retriever does — sharpen one description or merge them.', 'warn'));
    }
    if (validation.columns?.length) {
      nodes.push(notice(`Returns: ${validation.columns.join(', ')}`, 'ok'));
    }

    report.replaceChildren(
      el('div', { class: 'card panel' },
        el('div', { class: 'panel__head' }, el('div', { class: 'panel__title' },
          el('h3', {}, 'Validation'))),
        el('div', { class: 'panel__body' },
          ...(nodes.length ? nodes : [notice('Not validated yet.', 'info')]),
          validation.plan
            ? el('div', { style: 'margin-top:10px' },
                el('p', { class: 'field__hint', style: 'margin-bottom:6px' },
                  'The plan Postgres produced. A sequential scan on a large table here is ' +
                  'a slow function in production.'),
                codeBlock(validation.plan, { tall: true }))
            : null)));
  };

  // Kind decides which half of the form applies. Showing both at once is how a
  // read function ends up with a stray HTTP body that fails a constraint.
  const syncKind = () => {
    const isRead = inputs.kind.value === 'read';
    inputs.readSection.hidden = !isRead;
    inputs.writeSection.hidden = isRead;
  };
  inputs.kind.addEventListener('change', syncKind);
  syncKind();

  const syncAmbiguity = () => {
    inputs.ambiguityField.hidden = inputs.returns.value !== 'single-or-ambiguous';
  };
  inputs.returns.addEventListener('change', syncAmbiguity);
  syncAmbiguity();

  renderSide(sidePanels, existing);
  if (existing?.validationError) {
    report.replaceChildren(el('div', { class: 'card panel' },
      el('div', { class: 'panel__body' }, notice(existing.validationError, 'bad'))));
  }

  return frag(
    pageHead(
      existing ? `Edit ${existing.name}` : 'New function',
      existing
        ? `Version ${existing.version} · ${existing.status}. Saving a live function returns it to draft.`
        : 'A function is the only thing the agent can do. It picks one and fills in the parameters — it never writes SQL.',
      button('Back', { iconName: 'back', onclick: () => navigate('#/functions') })),

    el('div', { class: 'editor' },
      el('div', {},
        identitySection(inputs),
        plannerSection(inputs),
        parametersSection(inputs),
        inputs.readSection,
        inputs.writeSection,
        accessSection(inputs)),
      mount(sidePanels, report)),

    el('div', { class: 'actionbar' },
      button('Validate', {
        iconName: 'check',
        onclick: (event) => busy(event.target, async () => {
          showReport(await api(appPath('/functions/check'), { method: 'POST', body: collect() }));
        }, 'Validating…'),
      }),
      existing && existing.kind === 'read'
        ? button('Try it', { iconName: 'play', onclick: () => tryFunction(existing) })
        : null,
      el('div', { class: 'grow' }),
      existing
        ? button('Delete', {
            variant: 'danger',
            onclick: async () => {
              if (!confirm(`Delete "${existing.name}"? Its version history goes too.`)) return;
              await api(appPath(`/functions/${encodeURIComponent(existing.name)}`), { method: 'DELETE' });
              toast('Function deleted', 'ok');
              navigate('#/functions');
            },
          })
        : null,
      button(existing ? 'Save changes' : 'Create function', {
        variant: 'primary',
        onclick: (event) => busy(event.target, async () => {
          const body = collect();
          if (!body.name) { toast('A function needs a name.', 'bad'); return; }

          const result = await api(
            existing
              ? appPath(`/functions/${encodeURIComponent(existing.name)}`)
              : appPath('/functions'),
            { method: existing ? 'PUT' : 'POST', body });

          showReport(result);
          toast(
            result.validation.ok
              ? 'Saved as a draft. Approve it, then take it live.'
              : 'Saved as a draft, but it does not validate — it cannot go live until it does.',
            result.validation.ok ? 'ok' : 'bad');

          if (result.validation.ok && !existing) {
            navigate(`#/functions/${encodeURIComponent(body.name)}`);
          }
        }, 'Saving…'),
      })),
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────────

function buildInputs(existing) {
  const requiresConfirmation = el('input', { type: 'checkbox' });
  requiresConfirmation.checked = Boolean(existing?.requiresConfirmation);

  return {
    name: textInput(existing?.name ?? '', { placeholder: 'get_order' }),
    kind: select([
      { value: 'read', label: 'read — runs SQL against the read-only connection' },
      { value: 'write', label: 'write — calls back into your API' },
    ], existing?.kind ?? 'read'),
    description: textArea(existing?.description ?? '', 3),
    whenToUse: textArea((existing?.whenToUse ?? []).join('\n'), 3),
    whenNotToUse: textArea((existing?.whenNotToUse ?? []).join('\n'), 3),
    returns: select([
      { value: 'single', label: 'single — exactly one record' },
      { value: 'list', label: 'list — zero or more records' },
      { value: 'single-or-ambiguous', label: 'single-or-ambiguous — one record, or ask which' },
      { value: 'confirmation', label: 'confirmation — the outcome of a write' },
    ], existing?.returns ?? 'list'),
    ambiguityResolvesTo: textInput(existing?.ambiguityResolvesTo ?? '', { placeholder: 'order_id' }),
    ambiguityField: el('div'),
    allowedRoles: textInput((existing?.allowedRoles ?? []).join(', '), { placeholder: 'support, admin' }),
    parameters: textArea(JSON.stringify(existing?.parameters ?? {}, null, 2), 10, 'code'),
    requiredOneOf: textArea(JSON.stringify(existing?.requiredOneOf ?? [], null, 2), 3, 'code'),
    scopeFilters: textArea(JSON.stringify(existing?.scopeFilters ?? [], null, 2), 4, 'code'),
    sqlTemplate: textArea(existing?.sqlTemplate ?? '', 16, 'code'),
    httpRequest: textArea(
      existing?.httpRequest ? JSON.stringify(existing.httpRequest, null, 2) : '', 10, 'code'),
    writeScope: textInput(existing?.writeScope ?? '', { placeholder: 'orders' }),
    requiresConfirmation,
    readSection: el('section', { class: 'card fieldset' }),
    writeSection: el('section', { class: 'card fieldset' }),
  };
}

function fieldset(title, intro, ...body) {
  return el('section', { class: 'card fieldset' },
    el('h4', {}, title),
    intro ? el('p', { class: 'fieldset__intro' }, intro) : null,
    ...body);
}

function identitySection(inputs) {
  return fieldset('Identity',
    'How this function is referred to, and which half of the engine runs it.',
    field('Name', inputs.name,
      'lower_snake_case, unique within this application. The planner sees this name and ' +
      'returns it when it decides to call the function, so it should read like the thing ' +
      'it does: <code>get_order</code>, not <code>fn1</code>.'),
    field('Kind', inputs.kind,
      '<strong>read</strong> runs parameterised SQL on the read-only connection. ' +
      '<strong>write</strong> makes a declarative HTTP call back into your own API — ' +
      'this service never writes to the database itself.'));
}

function plannerSection(inputs) {
  return fieldset('What the planner reads',
    'The model never sees your schema or your SQL. It chooses a function almost entirely ' +
    'from these three fields, so they are the most important text in the registry.',

    field('Description', inputs.description,
      'One or two sentences: what it returns and which identifiers it accepts. Write it for ' +
      'someone who has never seen the database. ' +
      '<em>"Returns one order by its reference (e.g. ORD-1002) or by numeric id, with status, ' +
      'total and placement date."</em>'),

    field('When to use', inputs.whenToUse,
      'One case per line. Phrases a user would actually say — "what is the status of order X", ' +
      '"when did order X ship". These are matched against the message, so concrete beats abstract.',
      { optional: true }),

    field('When NOT to use', inputs.whenNotToUse,
      'One case per line, and the single highest-value field when two functions are ' +
      'confusable. Point at the neighbour by name: <em>"Not for listing a customer\'s orders — ' +
      'use list_customer_orders."</em>',
      { optional: true }),

    field('Returns', inputs.returns,
      '<strong>single</strong> — one record, no ambiguity possible. ' +
      '<strong>list</strong> — any number of rows. ' +
      '<strong>single-or-ambiguous</strong> — one record when the match is confident, ' +
      'otherwise the agent stops and asks which one was meant rather than guessing. ' +
      '<strong>confirmation</strong> — the result of a write.'),

    mount(inputs.ambiguityField,
      field('Ambiguity resolves into parameter', inputs.ambiguityResolvesTo,
        'Required for <code>single-or-ambiguous</code>. When the user picks one of the ' +
        'candidates, its id is written into this parameter and the function is called again. ' +
        'It must be one of the parameter names below.')));
}

function parametersSection(inputs) {
  return fieldset('Parameters',
    'A JSON schema for what the model may pass. Every value is validated against it and then ' +
    'bound as a query parameter — nothing here reaches the SQL text.',

    field('Parameter schema (JSON)', inputs.parameters,
      'An object keyed by parameter name. Each entry takes <code>type</code> ' +
      '(string, number, integer, boolean, date), <code>required</code>, ' +
      '<code>description</code>, and optionally <code>enum</code>, <code>min</code>, ' +
      '<code>max</code>, <code>pattern</code>, <code>default</code>. The description is ' +
      'shown to the model, so say what a value looks like.'),

    el('details', { style: 'margin:-6px 0 15px' },
      el('summary', { class: 'field__hint', style: 'cursor:pointer' }, 'Show an example'),
      el('div', { style: 'margin-top:8px' }, codeBlock(PARAMS_EXAMPLE))),

    field('Required one-of groups (JSON)', inputs.requiredOneOf,
      'An array of arrays. <code>[["reference","order_id"]]</code> means at least one of ' +
      'those two must be supplied. Use it when a lookup accepts either of two identifiers ' +
      'but needs one of them.',
      { optional: true }));
}

function readSectionBody(inputs) {
  return frag(
    el('h4', {}, 'The query'),
    el('p', { class: 'fieldset__intro' },
      'Parameterised SQL in a template language with exactly two tokens. There is no syntax ' +
      'for interpolating a value, which is the property that matters — not that interpolation ' +
      'is filtered, but that it cannot be written.'),

    field('SQL template', inputs.sqlTemplate,
      '<code>{{param:name}}</code> compiles to a bound <code>$n</code> placeholder. ' +
      '<code>{{scope:key}}</code> compiles to <code>column = $n</code> bound to the caller\'s ' +
      'scope value. A raw <code>$1</code> is rejected, <code>${…}</code> is rejected, and ' +
      '<code>SELECT *</code> is rejected. <code>LIMIT</code> is added by the engine, so a ' +
      'function cannot ship without one.'),

    el('details', { style: 'margin:-6px 0 15px' },
      el('summary', { class: 'field__hint', style: 'cursor:pointer' },
        'Show an example, and what the output columns mean'),
      el('div', { style: 'margin-top:8px' },
        codeBlock(SQL_EXAMPLE),
        el('div', { class: 'tablewrap', style: 'margin-top:10px' },
          table(['Column', 'Meaning'], [
            [el('code', {}, 'id'), 'The record identifier. Required for single-or-ambiguous.'],
            [el('code', {}, 'label'), 'What the user would recognise it by, shown in a clarifying question.'],
            [el('code', {}, 'detail'), 'A second line that tells two candidates apart.'],
            [el('code', {}, 'match_score'), '0–100. How well this row matches. Drives the ambiguity decision.'],
          ])))),

    field('Scope filters (JSON)', inputs.scopeFilters,
      'An array of <code>{"key":"org_id","column":"o.org_id"}</code>. Each one <em>must</em> ' +
      'also appear as <code>{{scope:key}}</code> in the SQL — a function that declares a ' +
      'filter and never applies it is refused at save time, because a function that looks ' +
      'protected and is not is worse than one that obviously is not.',
      { optional: true }));
}

function writeSectionBody(inputs) {
  return frag(
    el('h4', {}, 'The action'),
    el('p', { class: 'fieldset__intro' },
      'Write functions never touch the database. They make an HTTP call back into your own ' +
      'API, so your existing validation, business rules and audit trail still apply.'),

    field('HTTP action (JSON)', inputs.httpRequest,
      'For example <code>{"service":"orders-api","method":"POST","path":"/v1/orders/{{param:id}}/cancel",' +
      '"body":{"reason":"{{param:reason}}"},"forwardUserToken":true}</code>. ' +
      '<code>service</code> names a service registered on the Applications page — never a ' +
      'URL, so a saved function cannot make this server call an internal address. Path values ' +
      'are URL-encoded, redirects are not followed, and any Authorization or Cookie header ' +
      'in the body is dropped.<br><br>' +

      'A path or body may also use <code>{{scope:key}}</code>, which binds the caller\'s own ' +
      'scope value — that is how a self-service action reaches "my" record without accepting ' +
      'an id it would have to trust. A role exempt from that key is refused, because ' +
      '"every value" is not an identifier.<br><br>' +

      '<strong>precondition</strong> — <code>{"precondition":{"sqlTemplate":"SELECT 1 FROM ' +
      'orders o WHERE o.id = {{param:id}} AND {{scope:org_id}}","denyMessage":"Not your order."}}</code>. ' +
      'A read that must return a row before the call goes out. An HTTP action carries no WHERE ' +
      'clause, so without this the only thing keeping it inside the caller\'s tenant is the ' +
      'target API\'s own checks. Compiled by the same engine as a read function, so an ' +
      'unbindable scope refuses the action.<br><br>' +

      '<strong>poll</strong> — <code>{"poll":{"urlFrom":"statusUrl","statusField":"status",' +
      '"successWhen":["COMPLETED"],"failureWhen":["ERROR"],"intervalMs":2000,"maxAttempts":30}}</code>. ' +
      'For an API that accepts work and finishes it in the background: the agent follows the ' +
      'job and answers with the finished thing rather than a job id. The follow-up URL comes ' +
      'out of a response body, so it is re-checked against the registered service — a host ' +
      'that names somewhere else is not followed.<br><br>' +

      '<strong>result</strong> — <code>{"result":{"link":{"from":"downloadUrl","label":"Download report"},' +
      '"expose":[{"from":"password","label":"Password"}]}}</code>. ' +
      'Values that must reach the user exactly as they are. These bypass the model entirely — ' +
      'it is told a link is coming but never shown it, because a model asked to repeat a long ' +
      'URL will eventually change a character. Links are rebuilt against the service\'s public ' +
      'base URL. <code>expose</code> hands a value over verbatim, so declare one field at a time.'),

    field('Write scope', inputs.writeScope,
      'The permission label checked against the caller\'s role. A role must list this in its ' +
      'write scopes to call this function at all.',
      { optional: true }),

    el('div', { class: 'field' },
      el('label', { class: 'checkline' },
        inputs.requiresConfirmation,
        el('span', {},
          el('strong', {}, 'Ask the user to confirm first'),
          el('br'),
          el('span', { class: 'muted' },
            'Stored and shown, but the two-turn confirm flow is not implemented yet — a ' +
            'destructive action still executes on the first call. Do not rely on it.')))));
}

function accessSection(inputs) {
  return fieldset('Access',
    'Which roles may call this at all. Checked before the function runs, and every attempt is ' +
    'audited whether it succeeds, fails or is refused.',
    field('Allowed roles', inputs.allowedRoles,
      'Comma separated, or <code>*</code> for every role defined in this application. A role ' +
      'must also list this function in its own allowed functions — both sides have to agree.'));
}

// ── Side panels ─────────────────────────────────────────────────────────────

function renderSide(container, existing) {
  container.replaceChildren();

  if (existing) {
    container.append(
      panel('Status', {},
        el('div', { class: 'panel__body' },
          el('dl', { class: 'kv' },
            el('dt', {}, 'Status'), el('dd', {}, statusBadge(existing.status)),
            el('dt', {}, 'Version'), el('dd', {}, `v${existing.version}`),
            el('dt', {}, 'Kind'), el('dd', {}, existing.kind),
            el('dt', {}, 'Last validated'), el('dd', {}, fmt.ago(existing.lastValidatedAt))))));
  }

  container.append(
    panel('How saving works', {},
      el('div', { class: 'panel__body' },
        el('ol', { style: 'padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--text-muted)' },
          el('li', {}, 'The template is compiled to bound placeholders.'),
          el('li', {}, 'Postgres runs it with ', el('code', {}, 'LIMIT 0'),
            ' to resolve every identifier and report the output columns.'),
          el('li', {}, el('code', {}, 'EXPLAIN'), ' produces the plan you see here.'),
          el('li', {}, 'Both run inside a ', el('code', {}, 'READ ONLY'),
            ' transaction, so anything that is not a read is rejected by the server rather ' +
            'than by a keyword list.'),
          el('li', {}, 'It saves as a draft. Nothing reaches the agent until you approve it ' +
            'and take it live.')))));
}

// ── Trial run ───────────────────────────────────────────────────────────────

/**
 * Run the function as a chosen role without promoting it.
 *
 * Validation proves a function plans. This proves it returns the right rows and
 * disambiguates sensibly. Scoping applies exactly as in production, so leaving a
 * scope blank is a real test of the refusal rather than a broken form.
 */
async function tryFunction(fn) {
  const { roles } = await api(appPath('/roles'));

  if (roles.length === 0) {
    openModal(`Try ${fn.name}`,
      empty('No roles defined',
        'A trial runs as a role, so that scoping and permissions apply exactly as they ' +
        'would in production. Define one first.',
        button('Go to roles', {
          variant: 'primary',
          onclick: () => { closeModal(); navigate('#/roles'); },
        }), 'roles'));
    return;
  }

  const roleSelect = select(roles.map((role) => role.name), roles[0].name);
  const paramsInput = textArea('{}', 4, 'code');
  const scopeInputs = {};
  const output = el('div');

  const scopeKeys = (fn.scopeFilters ?? []).map((filter) => filter.key);

  openModal(`Try ${fn.name}`, frag(
    field('Run as role', roleSelect,
      'Permissions and scope exemptions are applied exactly as they would be for a real caller.'),

    ...scopeKeys.map((key) => {
      const input = textInput('', { placeholder: 'leave blank to test the refusal' });
      scopeInputs[key] = input;
      return field(`Scope · ${key}`, input,
        'Blank means the caller supplied no value. Unless the chosen role is exempt from this ' +
        'key, the function should refuse rather than run unscoped — that is worth checking.');
    }),

    field('Parameters (JSON)', paramsInput,
      'Validated against the parameter schema, exactly as the model\'s output would be.'),

    el('div', { class: 'btnrow', style: 'margin-top:14px' },
      button('Run', {
        variant: 'primary',
        iconName: 'play',
        onclick: (event) => busy(event.target, async () => {
          const scopes = {};
          for (const [key, input] of Object.entries(scopeInputs)) {
            const raw = input.value.trim();
            if (raw === '') continue;
            scopes[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
          }

          try {
            output.replaceChildren(renderTrial(await api(
              appPath(`/functions/${encodeURIComponent(fn.name)}/try`),
              { method: 'POST', body: { role: roleSelect.value, scopes, params: parseJson(paramsInput.value, {}) } })));
          } catch (error) {
            output.replaceChildren(notice(error.message, 'bad'));
          }
        }, 'Running…'),
      })),

    el('div', { style: 'margin-top:14px' }, output),
  ), { wide: true });
}

function renderTrial(outcome) {
  const { result } = outcome;
  const tone =
    result.status === 'denied' || result.status === 'error' ? 'bad'
    : result.status === 'ambiguous' || result.status === 'empty' ? 'warn'
    : 'ok';

  const wrap = el('div', {},
    notice(
      `${result.status} · ${outcome.rowCount} row(s) · ${outcome.durationMs} ms · ` +
      `scopes applied: ${JSON.stringify(outcome.scopesApplied)}`, tone));

  if (result.status === 'ambiguous') {
    mount(wrap,
      notice(`Would ask the user which of these they meant (searched by ${result.searchedBy}):`, 'warn'),
      table(['id', 'label', 'detail', 'score'],
        result.candidates.map((candidate) => [
          candidate.id, candidate.label, candidate.detail ?? '—', candidate.score])));
  } else if (result.status === 'denied') {
    mount(wrap, notice(result.reason, 'bad'));
  } else if (result.status === 'error') {
    mount(wrap, notice(result.message, 'bad'));
  } else if (result.status !== 'empty') {
    const rows = result.status === 'list' ? result.data : [result.data];
    mount(wrap, codeBlock(JSON.stringify(rows, null, 2).slice(0, 6000), { tall: true }));
  }

  return wrap;
}
