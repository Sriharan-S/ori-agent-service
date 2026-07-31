/* The playground.
 *
 * A real conversation against the live chat API, from inside the console. It is
 * deliberately not a shortcut around authentication: it calls the same public
 * /v1/chat/stream endpoint any client would, with an issued API key the operator
 * pastes in, as a chosen role. If it works here it works for the caller, because
 * it is the caller's exact path — key, role, scopes and all.
 *
 * It streams with fetch() rather than EventSource, because EventSource cannot
 * set the X-Api-Key header. The body is read as a stream and the SSE frames are
 * parsed by hand, which also means the trace channel is available: every step
 * the agent takes is shown next to the answer it produced.
 */

import {
  el, frag, mount, icon, badge, statusBadge, button, field, textInput, select,
  notice, toast, pageHead, empty,
} from './ui.js';
import { setMarkdown } from './markdown.js';
import { api, appPath, state } from './app.js';

/** Kept per application, in sessionStorage: convenient across view switches, gone when the tab closes. */
const keyStore = {
  get: (appId) => { try { return sessionStorage.getItem(`ori-pg-key-${appId}`) || ''; } catch { return ''; } },
  set: (appId, value) => { try { value ? sessionStorage.setItem(`ori-pg-key-${appId}`, value) : sessionStorage.removeItem(`ori-pg-key-${appId}`); } catch { /* private mode */ } },
};

export async function playgroundView() {
  const [{ roles }, { keys }, { application }] = await Promise.all([
    api(appPath('/roles')),
    api(appPath('/keys')),
    api(`/applications/${state.applicationId}`).catch(() => ({ application: null })),
  ]);

  const app = application ?? state.applications.find((a) => a.id === state.applicationId);
  const isJwt = app?.endUserAuth === 'jwt';

  if (roles.length === 0) {
    return frag(
      pageHead('Playground', 'Have a real conversation with the agent as a chosen role.'),
      empty('No roles yet',
        'A conversation runs as a role — define at least one first, so scoping and ' +
        'permissions apply exactly as they would for a real user.',
        button('Go to roles', { variant: 'primary', onclick: () => (window.location.hash = '#/roles') }),
        'roles'));
  }

  // ── Configuration column ──────────────────────────────────────────────────

  const apiKey = el('input', {
    type: 'password',
    placeholder: 'ori_xxxx.xxxxxxxx',
    value: keyStore.get(state.applicationId),
    autocomplete: 'off',
  });
  const endUserId = textInput('playground-user', { placeholder: 'any stable id' });
  const roleSelect = select(roles.map((r) => r.name), roles[0].name);
  const traceToggle = el('input', { type: 'checkbox' });
  traceToggle.checked = true;

  const jwtToken = el('input', { type: 'password', placeholder: 'paste a signed end-user JWT' });

  /**
   * Scope is a property of the role, so it is derived from the role rather than
   * typed.
   *
   * The service asks which keys the chosen role must supply — the scope filters
   * of every live function it may call, minus the keys it is exempt from — and
   * offers real values from the database for each. Switching role rebuilds this,
   * so an administrator (exempt from everything) is correctly asked for nothing,
   * and a CORPORATE caller is asked only for the one key that applies.
   */
  const scopeInputs = {};
  const scopeBox = el('div');

  const loadScopeFor = async (roleName) => {
    for (const key of Object.keys(scopeInputs)) delete scopeInputs[key];
    scopeBox.replaceChildren(el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Working out what this role needs…'));

    let requirement;
    try {
      requirement = await api(appPath(`/roles/${encodeURIComponent(roleName)}/scope-requirements`));
    } catch (error) {
      scopeBox.replaceChildren(notice(error.message, 'bad'));
      return;
    }

    const nodes = [];

    if (requirement.keys.length === 0) {
      nodes.push(notice(
        requirement.exempt.length
          ? `${roleName} is exempt from ${requirement.exempt.join(', ')}, so it sees every ` +
            'tenant and supplies no scope. Nothing to fill in.'
          : `Nothing ${roleName} can call is scoped, so there is nothing to supply.`,
        'info'));
    }

    for (const key of requirement.keys) {
      const samples = requirement.samples?.[key] ?? [];
      const input = samples.length
        ? select(
            [{ value: '', label: '— leave blank to test the refusal —' },
              ...samples.map((s) => ({ value: s.value, label: s.label }))],
            samples[0].value)
        : textInput('', { placeholder: 'value a real caller would send' });

      scopeInputs[key] = input;
      nodes.push(field(`Scope · ${key}`, input,
        samples.length
          ? 'Real values from your database, most common first. Blank tests the refusal ' +
            'path — this role is not exempt from this key, so it should be denied rather ' +
            'than run unscoped.'
          : 'No sample values were readable for this key. Type one a real caller would send.'));
    }

    if (requirement.callable?.length === 0) {
      nodes.push(notice(
        `${roleName} can call nothing that is live, so every question will be refused. ` +
        'Check the role\'s allowed functions and that the functions are live.', 'warn'));
    }

    scopeBox.replaceChildren(...nodes);
  };

  roleSelect.addEventListener('change', () => void loadScopeFor(roleSelect.value));
  await loadScopeFor(roleSelect.value);

  const config = el('div', { class: 'card pg__config' },
    el('div', { class: 'panel__head' }, el('div', { class: 'panel__title' }, el('h3', {}, 'Session'))),
    el('div', { class: 'panel__body' },
      field('API key', apiKey,
        keys.length
          ? `This application has ${keys.length} key(s): ${keys.map((k) => k.prefix).join(', ')}. ` +
            'Paste the full secret shown when it was issued — the secret is never stored, only the prefix.'
          : 'No keys issued yet. Issue one on the Applications page with the <code>chat</code> ' +
            'and <code>trace</code> scopes, then paste it here.'),

      isJwt
        ? field('End-user JWT', jwtToken,
            'This application verifies a signed token (jwt mode). Paste one a real ' +
            'sign-in would produce; the role and scopes below are ignored in this mode.')
        : frag(
            field('End-user id', endUserId, 'Who the conversation is on behalf of. Any stable string.'),
            field('Role', roleSelect,
              'Decides both what the agent can call and which scope values apply. ' +
              'Changing it rebuilds the scope fields below.'),
            scopeBox),

      el('label', { class: 'checkline', style: 'margin-top:6px' },
        traceToggle,
        el('span', {}, el('strong', {}, 'Show the agent\'s steps'),
          el('br'),
          el('span', { class: 'muted' }, 'Router, plan, function calls and the reflection, as they stream. Needs the trace scope on the key.'))),
    ));

  // ── Conversation column ───────────────────────────────────────────────────

  const transcript = el('div', { class: 'pg__transcript' },
    empty('No messages yet',
      isJwt
        ? 'Paste a token and ask something.'
        : 'Pick a role, set the scope values a real caller would send, and ask something. ' +
          'Try "how many candidates have completed the assessment" as CORPORATE.',
      null, 'chat'));

  const input = el('textarea', { rows: 2, placeholder: 'Ask the agent…', class: 'pg__input' });
  const sendBtn = button('Send', { variant: 'primary', iconName: 'play' });

  const session = { conversationId: null, streaming: false, firstMessage: true };

  const send = async () => {
    const message = input.value.trim();
    if (!message || session.streaming) return;

    const key = apiKey.value.trim();
    if (!key) { toast('Paste an issued API key first.', 'bad'); apiKey.focus(); return; }
    keyStore.set(state.applicationId, key);

    if (session.firstMessage) { transcript.replaceChildren(); session.firstMessage = false; }
    input.value = '';

    addBubble(transcript, 'user', message);
    const bubbleRef = addBubble(transcript, 'agent', '');
    const showTrace = traceToggle.checked;

    session.streaming = true;
    sendBtn.disabled = true;
    input.disabled = true;

    try {
      await streamChat({
        message,
        key,
        trace: showTrace,
        conversationId: session.conversationId,
        identity: isJwt
          ? { mode: 'jwt', token: jwtToken.value.trim() }
          : {
              mode: 'asserted',
              id: endUserId.value.trim() || 'playground-user',
              role: roleSelect.value,
              scopes: collectScopes(scopeInputs),
            },
        onEvent: (event) => handleEvent(event, { bubbleRef, showTrace, session }),
      });
    } catch (error) {
      bubbleRef.stageLine.hidden = true;
      mount(bubbleRef.bubble, notice(error.message, 'bad'));
    } finally {
      session.streaming = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      transcript.scrollTop = transcript.scrollHeight;
    }
  };

  sendBtn.onclick = send;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });

  const reset = button('New conversation', {
    iconName: 'refresh',
    onclick: () => {
      session.conversationId = null;
      session.firstMessage = true;
      transcript.replaceChildren(empty('New conversation', 'Ask something to begin.', null, 'chat'));
    },
  });

  const chat = el('div', { class: 'card pg__chat' },
    el('div', { class: 'panel__head' },
      el('div', { class: 'panel__title' }, el('h3', {}, 'Conversation')),
      el('div', { class: 'panel__tools' }, reset)),
    transcript,
    el('div', { class: 'pg__composer' }, input, sendBtn));

  return frag(
    pageHead('Playground',
      'A real conversation against the live chat API, as a role you choose. It uses the ' +
      'same endpoint and the same key any client would, so what works here works for them.'),
    el('div', { class: 'pg' }, config, chat),
  );
}

// ── Streaming ─────────────────────────────────────────────────────────────────

async function streamChat({ message, key, trace, conversationId, identity, onEvent }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
  };
  if (identity.mode === 'jwt') {
    if (!identity.token) throw new Error('Paste an end-user JWT for this application.');
    headers['x-end-user-token'] = identity.token;
  } else {
    headers['x-end-user'] = JSON.stringify({
      id: identity.id,
      role: identity.role,
      scopes: identity.scopes,
    });
  }

  const response = await fetch('/v1/chat/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, trace, conversationId: conversationId ?? undefined }),
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.message
        ? `${payload.message}${response.status === 401 ? ' (check the API key and its scopes)' : ''}`
        : `The chat request failed (${response.status}).`);
  }

  // SSE frames are separated by a blank line; a frame is `event: <name>` then
  // `data: <json>`. Parse by hand so custom headers stay available.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) onEvent(event);
    }
  }
}

function parseFrame(frame) {
  let name = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return { name, data: { raw: dataLines.join('\n') } };
  }
}

/** What each phase is called while it is happening. */
const STAGE_LABELS = {
  understanding: 'Reading the question…',
  selecting: 'Choosing what to look up…',
  retrieving: 'Fetching the data…',
  composing: 'Writing the answer…',
};

function handleEvent(event, ctx) {
  const { name, data } = event;

  if (name === 'run.started') {
    ctx.session.conversationId = data.conversationId ?? ctx.session.conversationId;
    return;
  }

  // Phases arrive on the user channel, so even a key without the trace scope can
  // show honest progress instead of a spinner.
  if (name === 'stage') {
    const label = STAGE_LABELS[data.stage];
    if (label) {
      ctx.bubbleRef.stageLine.hidden = false;
      ctx.bubbleRef.stageLine.replaceChildren(
        el('span', { class: 'pg__spinner' }), el('span', {}, label));
    }
    return;
  }

  if (name === 'message.delta') {
    ctx.bubbleRef.stageLine.hidden = true;
    ctx.bubbleRef.append(data.text ?? '');
    ctx.bubbleRef.bubble.closest('.pg__transcript').scrollTop = 1e9;
    return;
  }

  // A clarifying question arrives whole, not streamed, with the candidates that
  // prompted it. Showing them makes the "asks instead of guessing" behaviour
  // visible rather than just a sentence.
  if (name === 'clarification') {
    ctx.bubbleRef.stageLine.hidden = true;
    ctx.bubbleRef.set(data.message ?? '');
    if (Array.isArray(data.candidates) && data.candidates.length) {
      mount(ctx.bubbleRef.bubble, el('div', { class: 'pg__candidates' },
        ...data.candidates.map((c) =>
          el('span', { class: 'pg__candidate' },
            el('strong', {}, c.label),
            c.detail ? el('span', { class: 'muted' }, ` — ${c.detail}`) : null))));
    }
    mount(ctx.bubbleRef.bubble, el('div', { class: 'pg__tag' }, badge('asked instead of guessing', 'warn')));
    return;
  }

  if (name === 'run.completed') {
    ctx.bubbleRef.stageLine.hidden = true;
    if (data.responseType && data.responseType !== 'answer') {
      mount(ctx.bubbleRef.bubble, el('div', { class: 'pg__tag' }, statusBadge(data.responseType)));
    }
    return;
  }

  if (name === 'error') {
    ctx.bubbleRef.stageLine.hidden = true;
    mount(ctx.bubbleRef.bubble, notice(data.message || 'The run failed.', 'bad'));
    return;
  }

  if (!ctx.showTrace) return;

  // ── Trace: how the functions were chosen ──────────────────────────────────
  //
  // Rendered as structure rather than a log line, because the question it has to
  // answer is "did the model pick this, or was it the only option".
  if (name === 'plan.created') {
    ctx.bubbleRef.traceList.hidden = false;
    const chosen = (data.calls ?? []).map((c) => c.name);
    const considered = data.considered ?? [];

    mount(ctx.bubbleRef.traceList,
      el('div', { class: 'pg__phase' },
        el('strong', {}, data.isFallback ? 'No model chose — fallback' : 'The model chose'),
        el('div', { class: 'pg__chips' },
          ...considered.map((fnName) =>
            el('span', {
              class: `pg__chip ${chosen.includes(fnName) ? 'is-chosen' : ''}`,
              title: chosen.includes(fnName) ? 'chosen' : 'offered but not chosen',
            }, fnName))),
        data.reasoning
          ? el('div', { class: 'pg__reason' }, `“${data.reasoning}”`)
          : null,
        ...(data.calls ?? []).map((call) =>
          el('div', { class: 'pg__call' },
            el('strong', {}, call.name),
            Object.keys(call.params ?? {}).length
              ? el('span', {}, ` with ${JSON.stringify(call.params)}`)
              : el('span', { class: 'muted' }, ' with no parameters'))),
      ));
    return;
  }

  const simple = {
    'router.decision': () => `Understood as: ${data.intent}`,
    'function.started': () => `Running ${data.name}…`,
    'function.completed': () =>
      `${data.name} → ${data.status}` +
      (data.rowCount !== undefined ? `, ${data.rowCount} row(s)` : '') +
      (data.durationMs !== undefined ? `, ${data.durationMs}ms` : ''),
    reflection: () => `Decided to ${data.action}`,
  }[name];

  if (simple) {
    ctx.bubbleRef.traceList.hidden = false;
    mount(ctx.bubbleRef.traceList, el('div', { class: 'pg__step' },
      el('span', { class: 'pg__step-dot' }),
      el('span', {}, simple())));
  }
}

// ── Bubbles ─────────────────────────────────────────────────────────────────

/**
 * A message bubble.
 *
 * The agent's text is accumulated as a plain string and re-rendered as markdown
 * on each delta. Re-rendering rather than appending is deliberate: markdown is
 * not parseable one token at a time — `**bold` is not bold until the closing
 * `**` arrives — so the only correct thing to render is the whole text so far.
 * These answers are a few hundred characters, so rebuilding a small fragment per
 * delta costs nothing measurable.
 */
function addBubble(transcript, who, text) {
  const body = el('div', { class: 'pg__text' });
  const traceList = el('div', { class: 'pg__trace', hidden: true });
  const stageLine = el('div', { class: 'pg__stage', hidden: true });

  const bubble = el('div', { class: `pg__bubble pg__bubble--${who}` },
    el('div', { class: 'pg__who' },
      el('span', { class: 'avatar', style: who === 'agent' ? '' : 'background:var(--bg-subtle);color:var(--text-muted)' },
        who === 'agent' ? 'O' : 'U'),
      el('span', {}, who === 'agent' ? 'Agent' : 'You')),
    who === 'agent' ? stageLine : null,
    who === 'agent' ? traceList : null,
    body);

  if (who === 'user') body.textContent = text;
  else setMarkdown(body, text);

  transcript.append(bubble);
  transcript.scrollTop = transcript.scrollHeight;

  // `text` is the running source; `body` is its rendered form.
  return {
    get text() { return this._raw ?? ''; },
    _raw: text,
    append(chunk) { this._raw = (this._raw ?? '') + chunk; setMarkdown(body, this._raw); },
    set(value) { this._raw = value; setMarkdown(body, value); },
    traceList,
    stageLine,
    bubble,
  };
}

function collectScopes(inputs) {
  const scopes = {};
  for (const [key, input] of Object.entries(inputs)) {
    const raw = input.value.trim();
    if (raw === '') continue;
    scopes[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  return scopes;
}
