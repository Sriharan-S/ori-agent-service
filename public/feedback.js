/* The feedback queue.
 *
 * A thumbs-down is the cheapest signal there is about a registry that needs
 * work — far cheaper than reading transcripts — but only if it lands next to
 * the evidence. So this page is built around one question: *why* was that
 * answer wrong. Opening a row shows the question, the answer, and every
 * function call the executor actually made, with its parameters and its result.
 *
 * The calls come from the audit log, not from whoever pressed the button.
 */

import {
  el, frag, fmt, table, panel, kpi, badge, statusBadge, notice, empty, button,
  codeBlock, openModal, closeModal, toast, busy, pageHead,
} from './ui.js';
import { api, appPath, render } from './app.js';

let filter = { rating: null, open: false };

export async function feedbackView() {
  const query = new URLSearchParams();
  if (filter.rating) query.set('rating', filter.rating);
  if (filter.open) query.set('open', 'true');

  const { feedback, summary } = await api(
    appPath(`/feedback${query.toString() ? `?${query}` : ''}`));

  const total = summary.up + summary.down;

  return frag(
    pageHead('Feedback',
      'What people thought of the answers. A dislike is the fastest way to find ' +
      'a function whose description is wrong.',
      button('Refresh', { iconName: 'refresh', onclick: render })),

    el('div', { class: 'grid' },
      kpi('Rated', fmt.num(total), { iconName: 'chat' }),
      kpi('Liked', fmt.num(summary.up), {
        tone: 'ok', iconName: 'check',
        note: total ? `${Math.round((summary.up / total) * 100)}% of rated` : 'nothing rated yet',
      }),
      kpi('Disliked', fmt.num(summary.down), {
        tone: summary.down > 0 ? 'bad' : '', iconName: 'alert',
      }),
      kpi('Needs review', fmt.num(summary.openDown), {
        tone: summary.openDown > 0 ? 'warn' : 'ok',
        iconName: 'inbox',
        note: summary.openDown > 0 ? 'not looked at yet' : 'queue is clear',
      })),

    panel('Ratings', {
      count: feedback.length,
      tools: [
        toggle('All', filter.rating === null && !filter.open, () => {
          filter = { rating: null, open: false };
          render();
        }),
        toggle('Disliked', filter.rating === 'down' && !filter.open, () => {
          filter = { rating: 'down', open: false };
          render();
        }),
        toggle('Needs review', filter.open, () => {
          filter = { rating: null, open: true };
          render();
        }),
      ],
      foot: 'Ratings arrive from any client calling POST /v1/chat/feedback — the ' +
            'playground, or your own application.',
    },
      feedback.length === 0
        ? empty('Nothing here',
            filter.open
              ? 'No unreviewed dislikes. That is the queue clear.'
              : 'Ratings appear once someone uses the thumbs on an answer. Try one ' +
                'in the Playground.',
            null, 'inbox')
        : table(['', 'Question', 'Functions', 'Who', 'When', ''],
            feedback.map((entry) => [
              entry.rating === 'up'
                ? badge('liked', 'ok')
                : badge(entry.reviewedAt ? 'disliked' : 'needs review',
                    entry.reviewedAt ? '' : 'bad'),
              el('button', {
                class: 'linkish',
                type: 'button',
                onclick: () => inspect(entry.id),
              }, truncate(entry.question) || '(question not recorded)'),
              entry.functionsUsed.length
                ? el('span', { class: 'mono' }, entry.functionsUsed.join(', '))
                : '—',
              `${entry.endUserId ?? '—'} (${entry.endUserRole ?? '—'})`,
              fmt.ago(entry.createdAt),
              entry.comment ? badge('has a note', 'info') : '',
            ]))),

    notice(
      'The function calls shown for each rating come from the audit log — what ' +
      'the executor actually ran, with the parameters it actually used. They are ' +
      'not reported by the client, so a rating cannot misdescribe the run.',
      'info'),
  );
}

function toggle(label, active, onclick) {
  return button(label, { size: 'sm', variant: active ? 'primary' : '', onclick });
}

function truncate(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

async function inspect(id) {
  const { feedback } = await api(appPath(`/feedback/${id}`));

  openModal(
    feedback.rating === 'up' ? 'Liked answer' : 'Disliked answer',
    frag(
      feedback.comment
        ? notice(`They said: “${feedback.comment}”`, feedback.rating === 'up' ? 'ok' : 'warn')
        : null,

      el('div', { class: 'grid' },
        kpi('Verdict', feedback.rating === 'up' ? 'Liked' : 'Disliked', {
          tone: feedback.rating === 'up' ? 'ok' : 'bad',
          iconName: feedback.rating === 'up' ? 'up' : 'down',
        }),
        kpi('Intent', feedback.run?.intent ?? '—', { iconName: 'activity' }),
        kpi('Result', feedback.run?.responseType ?? feedback.run?.status ?? '—', {
          iconName: 'check',
        }),
        kpi('Latency', fmt.ms(feedback.run?.latencyMs), { iconName: 'clock' })),

      feedback.run?.error
        ? notice(`The run failed: ${feedback.run.error}`, 'bad')
        : null,

      panel('The exchange', {},
        el('div', { class: 'pg__transcript', style: 'max-height:260px' },
          el('div', { class: 'pg__bubble pg__bubble--user' },
            el('div', { class: 'pg__text' }, feedback.question || '(not recorded)')),
          el('div', { class: 'pg__bubble pg__bubble--agent' },
            el('div', { class: 'pg__text' }, feedback.answer || '(not recorded)')))),

      panel('What actually ran', {
        count: feedback.calls.length,
        foot: 'From the audit log, in order.',
      },
        feedback.calls.length === 0
          ? empty('No functions were called',
              'The agent answered without reaching for data — either it declined, ' +
              'or it answered from the knowledge base.', null, 'functions')
          : table(['Function', 'Result', 'Parameters', 'Scopes', 'Rows', 'Time'],
              feedback.calls.map((call) => [
                el('span', { class: 'mono' }, call.functionName),
                statusBadge(call.status),
                el('span', { class: 'mono' }, JSON.stringify(call.params)),
                Object.keys(call.scopesApplied).length
                  ? el('span', { class: 'mono' }, JSON.stringify(call.scopesApplied))
                  : '—',
                call.rowCount ?? '—',
                fmt.ms(call.latencyMs),
              ]))),

      feedback.calls.some((call) => call.deniedReason || call.errorMessage)
        ? panel('Refusals and errors', {},
            codeBlock(
              feedback.calls
                .filter((call) => call.deniedReason || call.errorMessage)
                .map((call) => `${call.functionName}: ${call.deniedReason ?? call.errorMessage}`)
                .join('\n'),
              { wrap: true }))
        : null,

      el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
        button('Delete', {
          variant: 'danger',
          onclick: async () => {
            if (!confirm('Delete this rating?')) return;
            await api(appPath(`/feedback/${id}`), { method: 'DELETE' });
            closeModal();
            render();
          },
        }),
        feedback.rating === 'down'
          ? button(feedback.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed', {
              variant: feedback.reviewedAt ? '' : 'primary',
              onclick: (event) => busy(event.target, async () => {
                await api(appPath(`/feedback/${id}/reviewed`), {
                  method: 'POST',
                  body: { reviewed: !feedback.reviewedAt },
                });
                closeModal();
                toast('Updated.', 'ok');
                render();
              }),
            })
          : null),
    ),
    { wide: true },
  );
}
