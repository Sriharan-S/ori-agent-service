/* The knowledge base page.
 *
 * Documents an operator uploads so the agent knows what the application *is* —
 * its vocabulary, its rules, the things that are true about it and are written
 * down nowhere a query could reach.
 *
 * Its own module rather than another block in views.js because uploading has a
 * shape nothing else in the console has: a multipart request, a per-document
 * ingestion result, and a retrieval mode that depends on what else is
 * configured. The page leads with that mode, because "why does search feel
 * weak" is answered by it and by nothing on this page otherwise.
 */

import {
  el, frag, fmt, table, panel, kpi, badge, notice, banner, empty, button, field,
  textInput, textArea, codeBlock, openModal, closeModal, toast, busy, csv, pageHead,
} from './ui.js';
import { api, appPath, state, render } from './app.js';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 25 * 1024 * 1024;

export async function knowledgeView() {
  const { documents, status } = await api(appPath('/knowledge'));

  return frag(
    pageHead('Knowledge',
      'What the agent knows about this application beyond what it can query. ' +
      'Used to pick the right function, to explain a result, and to answer ' +
      'questions no function covers.',
      button('Paste text', { iconName: 'plus', onclick: () => pasteDocument() }),
      button('Upload file', { variant: 'primary', iconName: 'upload', onclick: () => uploadDocument() })),

    retrievalMode(status),

    panel('Documents', {
      count: documents.length,
      tools: documents.length > 0
        ? [button('Re-index all', {
            size: 'sm',
            iconName: 'refresh',
            title: 'Re-chunk and re-embed every document. Use after changing the embedding model.',
            onclick: (event) => busy(event.target, async () => {
              const result = await api(appPath('/knowledge/reindex'), { method: 'POST' });
              toast(
                `Re-indexed ${result.reindexed} document(s)` +
                (result.failed ? `, ${result.failed} failed` : ''),
                result.failed ? 'warn' : 'ok');
              render();
            }),
          })]
        : [],
      foot: 'Retrieval is filtered by the caller\'s role before ranking, so a document ' +
            'a role may not see cannot influence what that role gets back.',
    },
      documents.length === 0
        ? empty('Nothing uploaded yet',
            'Add a product description, a glossary, a policy — anything that explains ' +
            'what this application\'s words mean. The agent reads it when choosing a ' +
            'function and when explaining an answer.',
            button('Paste some text', { variant: 'primary', onclick: () => pasteDocument() }),
            'guide')
        : table(['Title', 'Source', 'Visible to', 'Passages', 'Size', 'Status', 'Added'],
            documents.map((document) => [
              el('button', {
                class: 'linkish',
                type: 'button',
                onclick: () => inspectDocument(document.id),
              }, document.title),
              document.sourceType === 'file'
                ? el('span', { class: 'mono', title: document.filename ?? '' },
                    (document.filename ?? '').split('.').pop()?.toUpperCase() || 'FILE')
                : 'Pasted',
              document.allowedRoles.includes('*')
                ? badge('every role', '')
                : badge(document.allowedRoles.join(', '), 'warn'),
              document.chunkCount === 0
                ? '—'
                : document.embeddedCount > 0
                  ? `${document.chunkCount} · embedded`
                  : `${document.chunkCount} · text only`,
              fmt.bytes(document.byteSize),
              document.status === 'ready'
                ? badge('ready', 'ok')
                : document.status === 'failed'
                  ? el('span', { title: document.error ?? '' }, badge('failed', 'bad'))
                  : badge('indexing', 'warn'),
              fmt.ago(document.createdAt),
            ]))),
  );
}

/**
 * Which of the two retrieval halves are actually running.
 *
 * Stated plainly and at the top, because the difference is invisible from the
 * outside and entirely determines what search can do. Without an embedding
 * model, "how much does it cost" will not find a passage headed "Pricing" — and
 * an operator debugging that deserves to be told why rather than left tuning
 * their documents.
 */
function retrievalMode(status) {
  if (status.documents === 0) return null;

  if (!status.embeddingModel) {
    return banner('warn',
      'Keyword search only. No embedding model is configured, so a question has to ' +
      'share words with a passage to find it — "what does it cost" will not match ' +
      'a section headed "Pricing". Add a model with purpose "embedding" on the ' +
      'Models page, then re-index.',
      button('Go to Models', { size: 'sm', onclick: () => { window.location.hash = '#/models'; } }));
  }

  const unembedded = status.chunks - status.embeddedChunks;

  return frag(
    // Composed from nodes rather than a string: notice() sets textContent, so
    // markup in it would be shown literally — and the model id is
    // operator-supplied text that has no business being parsed as HTML anyway.
    el('div', { class: 'notice notice--info' },
      'Hybrid search: keywords plus meaning, using ',
      el('strong', {}, status.embeddingModel.modelId),
      `. ${status.chunks} passage(s) indexed`,
      status.pgvector
        ? ', compared inside Postgres with pgvector.'
        : '. No pgvector on this database, so vectors are compared in the service — ' +
          'fine at this size, worth installing the extension past a few thousand passages.',
      // Named because getting these wrong costs accuracy with nothing to see.
      // An operator who knows their model wants a prefix can confirm it is
      // being applied without reading any source.
      status.embeddingModel.queryPrefix || status.embeddingModel.passagePrefix
        ? el('div', { style: 'margin-top:6px' },
            'Instruction prefixes: query ',
            el('code', {}, status.embeddingModel.queryPrefix || 'none'),
            ', passage ',
            el('code', {}, status.embeddingModel.passagePrefix || 'none'),
            '.')
        : el('div', { style: 'margin-top:6px' },
            'No instruction prefixes — correct for a symmetric model. If yours is ' +
            'asymmetric (bge, e5, nomic, gemma), set them on the model and re-index.')),

    unembedded > 0
      ? banner('warn',
          `${unembedded} passage(s) have no embedding — they were indexed before the ` +
          'embedding model was configured, and are only findable by keyword until ' +
          'you re-index.')
      : null,
  );
}

// ── Adding ──────────────────────────────────────────────────────────────────

function pasteDocument() {
  const title = textInput('', { placeholder: 'Assessment levels explained' });
  const content = textArea('', 14);
  const roles = textInput('', { placeholder: 'leave blank for every role' });

  openModal('Paste knowledge', frag(
    field('Title', title,
      'Shown to the model with every passage from this document, so make it say what ' +
      'the document is about.'),
    field('Text', content,
      'Markdown headings are used to split this into passages. Plain prose works too.'),
    field('Visible to roles', roles,
      'Comma separated role names. Blank means every role. A caller whose role is not ' +
      'listed will never retrieve this, and cannot be told anything from it.',
      { optional: true }),

    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
      button('Save', {
        variant: 'primary',
        onclick: (event) => busy(event.target, async () => {
          if (!content.value.trim()) { toast('There is no text to save.', 'bad'); return; }

          await api(appPath('/knowledge/text'), {
            method: 'POST',
            body: {
              title: title.value.trim(),
              content: content.value,
              allowedRoles: csv(roles.value),
            },
          });

          closeModal();
          toast('Saved and indexed.', 'ok');
          render();
        }),
      })),
  ), { wide: true });
}

function uploadDocument() {
  const file = el('input', { type: 'file', accept: ACCEPT });
  const title = textInput('', { placeholder: 'defaults to the file name' });
  const roles = textInput('', { placeholder: 'leave blank for every role' });
  const chosen = el('p', { class: 'field__hint' }, 'PDF, Word (.docx), text, Markdown or CSV. Up to 25 MB.');

  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    chosen.textContent = picked
      ? `${picked.name} · ${Math.ceil(picked.size / 1024)} KB`
      : 'PDF, Word (.docx), text, Markdown or CSV. Up to 25 MB.';
  });

  openModal('Upload a document', frag(
    field('File', file, ''),
    chosen,
    field('Title', title, 'Optional. Defaults to the file name.', { optional: true }),
    field('Visible to roles', roles,
      'Comma separated role names. Blank means every role.', { optional: true }),

    notice(
      'A scanned PDF has no text to extract. If yours is a scan, run it through OCR ' +
      'first or paste the text in instead — the upload will tell you either way.',
      'info'),

    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
      button('Upload', {
        variant: 'primary',
        onclick: (event) => busy(event.target, async () => {
          const picked = file.files?.[0];
          if (!picked) { toast('Choose a file first.', 'bad'); return; }
          if (picked.size > MAX_BYTES) { toast('That file is over 25 MB.', 'bad'); return; }

          // Multipart, so this bypasses the JSON api() helper. Extraction and
          // embedding happen inside this request — a large PDF genuinely takes
          // a moment, and the button stays busy for the whole of it.
          const form = new FormData();
          form.append('file', picked);
          form.append('title', title.value.trim());
          form.append('allowedRoles', JSON.stringify(csv(roles.value)));

          const response = await fetch(
            `/admin/api${appPath('/knowledge/upload')}`,
            { method: 'POST', body: form, credentials: 'same-origin' });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            toast(payload.message || `Upload failed (${response.status})`, 'bad');
            return;
          }

          closeModal();
          toast(`Indexed ${payload.document.chunkCount} passage(s).`, 'ok');
          render();
        }),
      })),
  ), { wide: true });
}

// ── Inspecting ──────────────────────────────────────────────────────────────

async function inspectDocument(id) {
  const { document } = await api(appPath(`/knowledge/${id}`));
  const roles = textInput(
    document.allowedRoles.includes('*') ? '' : document.allowedRoles.join(', '),
    { placeholder: 'leave blank for every role' });

  openModal(document.title, frag(
    document.status === 'failed'
      ? banner('bad', document.error || 'This document could not be indexed.')
      : null,

    el('div', { class: 'grid' },
      kpi('Source', document.sourceType === 'file' ? 'File' : 'Pasted', {
        note: document.sourceType === 'file' ? (document.filename ?? '') : 'typed in',
        iconName: 'guide',
      }),
      kpi('Passages', fmt.num(document.chunkCount), { iconName: 'functions' }),
      kpi('Embedded', document.embeddedCount > 0 ? fmt.num(document.embeddedCount) : 'none', {
        tone: document.embeddedCount > 0 ? 'ok' : 'warn',
        note: document.embeddedCount > 0 ? 'meaning search on' : 'keyword only',
        iconName: 'models',
      }),
      kpi('Characters', fmt.num(document.characters), { iconName: 'audit' })),

    field('Visible to roles', roles,
      'Comma separated. Blank means every role. Changes apply to search immediately.',
      { optional: true }),

    el('details', {},
      el('summary', { class: 'field__label' }, 'Extracted text'),
      codeBlock(document.content, { wrap: true, tall: true })),

    el('div', { class: 'btnrow btnrow--end', style: 'margin-top:16px' },
      button('Delete', {
        variant: 'danger',
        onclick: async () => {
          if (!confirm(`Delete "${document.title}"? Its passages are removed from search.`)) return;
          await api(appPath(`/knowledge/${id}`), { method: 'DELETE' });
          closeModal();
          toast('Deleted.', 'ok');
          render();
        },
      }),
      button('Re-index', {
        onclick: (event) => busy(event.target, async () => {
          const result = await api(appPath(`/knowledge/${id}/reindex`), { method: 'POST' });
          toast(`Re-indexed into ${result.document.chunkCount} passage(s).`, 'ok');
          closeModal();
          render();
        }),
      }),
      button('Save roles', {
        variant: 'primary',
        onclick: (event) => busy(event.target, async () => {
          await api(appPath(`/knowledge/${id}/roles`), {
            method: 'PUT',
            body: { allowedRoles: csv(roles.value) },
          });
          closeModal();
          toast('Visibility updated.', 'ok');
          render();
        }),
      })),
  ), { wide: true });
}

