import {
  el, frag, fmt, table, panel, badge, statusBadge, empty, codeBlock,
} from './ui.js';

export function runEvidencePanel(title, run, calls = [], options = {}) {
  return panel(title, {
    count: calls.length,
    foot: options.foot ?? 'Only functions actually used in this run are shown.',
  },
    run
      ? renderRunEvidence(run, calls)
      : empty('No run evidence',
          'The answer was recorded before run evidence was available, or it has no run id.',
          null,
          'activity'));
}

export function conversationEvidencePanel(runs = []) {
  return panel('Thinking process', {
    count: runs.length,
    foot: 'Only functions actually used by each run are shown.',
  },
    runs.length === 0
      ? empty('No run evidence',
          'This conversation has messages, but no recorded agent runs.',
          null,
          'activity')
      : el('div', { class: 'evidence-list' },
          ...runs.map((run, index) => renderRunEvidence(run, run.calls ?? [], {
            label: `Run ${index + 1}`,
          }))));
}

export function renderRunEvidence(run, calls = [], { label = null } = {}) {
  const used = usedFunctions(run, calls);
  const result = run.responseType ?? run.status ?? 'unknown';

  return el('div', { class: 'evidence' },
    el('div', { class: 'evidence__head' },
      el('div', {},
        label ? el('div', { class: 'evidence__eyebrow' }, label) : null,
        el('strong', {}, run.runKey ? `Run ${String(run.runKey).slice(0, 8)}` : 'Run evidence'),
        el('span', { class: 'muted' }, ` ${fmt.time(run.startedAt)}`)),
      el('div', { class: 'evidence__badges' },
        statusBadge(result),
        run.latencyMs !== null && run.latencyMs !== undefined
          ? badge(fmt.ms(run.latencyMs), 'plain')
          : null)),

    run.error ? el('div', { class: 'notice notice--bad' }, run.error) : null,

    el('div', { class: 'evidence__steps' },
      evidenceStep('Understood', run.intent ? `Intent: ${run.intent}` : 'Intent was not recorded.'),
      evidenceStep(
        used.length ? 'Used functions' : 'No function used',
        used.length
          ? frag(...used.map((name) => badge(name, 'info')))
          : 'The agent answered without calling a registry function.'),
      ...calls.map(renderCall),
      evidenceStep('Finished', `Result: ${result}${run.latencyMs ? ` in ${fmt.ms(run.latencyMs)}` : ''}`)),
  );
}

function renderCall(call) {
  const hasScopes = Object.keys(call.scopesApplied ?? {}).length > 0;
  const hasParams = Object.keys(call.params ?? {}).length > 0;
  const issue = call.deniedReason ?? call.errorMessage ?? null;

  return el('details', { class: 'evidence__call' },
    el('summary', {},
      el('span', { class: 'mono evidence__fn' }, call.functionName),
      statusBadge(call.status),
      el('span', { class: 'muted' }, `${call.rowCount ?? 0} row(s), ${fmt.ms(call.latencyMs)}`)),
    issue ? el('div', { class: 'notice notice--warn' }, issue) : null,
    table(['Field', 'Value'], [
      ['Parameters', hasParams ? codeBlock(JSON.stringify(call.params, null, 2), { wrap: true }) : 'none'],
      ['Scopes applied', hasScopes ? codeBlock(JSON.stringify(call.scopesApplied, null, 2), { wrap: true }) : 'none'],
      ['Completed', fmt.time(call.createdAt)],
    ]));
}

function evidenceStep(title, body) {
  return el('div', { class: 'evidence__step' },
    el('div', { class: 'evidence__dot' }),
    el('div', {},
      el('strong', {}, title),
      el('div', { class: 'evidence__body' }, body)));
}

function usedFunctions(run, calls) {
  const fromCalls = unique(calls.map((call) => call.functionName).filter(Boolean));
  if (fromCalls.length) return fromCalls;
  return unique((run.functionsUsed ?? []).filter(Boolean));
}

function unique(values) {
  return [...new Set(values)];
}
