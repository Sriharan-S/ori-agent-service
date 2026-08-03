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

  /**
   * `turns` mirrors the server's transcript in order, so an edit knows what
   * comes after the turn being changed and can take it off the screen at the
   * same moment the service discards it. Without that the two would disagree:
   * the browser would still show answers to a question that no longer exists.
   */
  const session = { conversationId: null, streaming: false, firstMessage: true, turns: [] };

  /** Drop a turn and everything after it, from the screen. */
  const truncateFrom = (turn) => {
    const index = session.turns.indexOf(turn);
    if (index < 0) return;
    for (const dropped of session.turns.slice(index)) dropped.bubble.remove();
    session.turns.length = index;
  };

  /**
   * Send a message.
   *
   * `replaceFrom` is the turn being edited. The service rewinds to it before
   * reading the history, so the re-run sees the conversation as it was up to
   * that point and nothing after.
   */
  const send = async (text, { replaceFrom = null } = {}) => {
    const message = (text ?? input.value).trim();
    if (!message || session.streaming) return;

    const key = apiKey.value.trim();
    if (!key) { toast('Paste an issued API key first.', 'bad'); apiKey.focus(); return; }
    keyStore.set(state.applicationId, key);

    if (session.firstMessage) { transcript.replaceChildren(); session.firstMessage = false; }
    if (text === undefined) input.value = '';
    if (replaceFrom) truncateFrom(replaceFrom);

    const userTurn = addBubble(transcript, 'user', message, { onEdit: startEdit });
    const bubbleRef = addBubble(transcript, 'agent', '', {
      onRetry: retry,
      onRate: rate,
    });
    session.turns.push(userTurn, bubbleRef);
    const showTrace = traceToggle.checked;

    // One object for the whole run, not one per event. The agent loop reports
    // its step number in its own event and the renderer has to remember it when
    // the next one arrives — which a fresh literal per event cannot do.
    const runContext = { bubbleRef, userTurn, showTrace, session, step: 1 };

    session.streaming = true;
    sendBtn.disabled = true;
    input.disabled = true;
    refreshActions();

    try {
      await streamChat({
        message,
        key,
        trace: showTrace,
        conversationId: session.conversationId,
        replaceFromMessageId: replaceFrom?.messageId ?? null,
        identity: isJwt
          ? { mode: 'jwt', token: jwtToken.value.trim() }
          : {
              mode: 'asserted',
              id: endUserId.value.trim() || 'playground-user',
              role: roleSelect.value,
              scopes: collectScopes(scopeInputs),
            },
        onEvent: (event) => handleEvent(event, runContext),
      });
    } catch (error) {
      bubbleRef.failStages();
      mount(bubbleRef.bubble, notice(error.message, 'bad'));
    } finally {
      session.streaming = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      refreshActions();
      transcript.scrollTop = transcript.scrollHeight;
    }
  };

  /**
   * Turn a sent message back into an editable one.
   *
   * The original text stays on screen until Save, so cancelling is genuinely
   * free — nothing has been discarded server-side at this point either.
   */
  function startEdit(turn) {
    if (session.streaming || turn.editing) return;
    turn.editing = true;

    const draft = el('textarea', { rows: 2, class: 'pg__input pg__edit-input' });
    draft.value = turn.text;

    const finish = () => {
      turn.editing = false;
      editor.remove();
      turn.body.hidden = false;
      refreshActions();
    };

    const save = button('Send', {
      variant: 'primary',
      size: 'sm',
      onclick: () => {
        const next = draft.value.trim();
        if (!next) return;
        finish();
        // `turn` is removed by truncateFrom inside send, along with every turn
        // after it.
        void send(next, { replaceFrom: turn });
      },
    });

    const editor = el('div', { class: 'pg__edit' },
      draft,
      el('div', { class: 'pg__edit-actions' },
        save,
        button('Cancel', { size: 'sm', onclick: finish })));

    draft.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save.click(); }
    });

    turn.body.hidden = true;
    turn.bubble.append(editor);
    refreshActions();
    draft.focus();
    draft.setSelectionRange(draft.value.length, draft.value.length);
  }

  /**
   * Only the last agent answer offers "Try again", and only a recorded user
   * turn offers "Edit" — an id the service never sent back is one it cannot
   * rewind to, so offering the button would be a lie.
   */
  function refreshActions() {
    const lastAgent = [...session.turns].reverse().find((turn) => turn.who === 'agent');

    for (const turn of session.turns) {
      const editable =
        turn.who === 'user' && turn.messageId != null && !session.streaming && !turn.editing;
      const retryable = turn === lastAgent && !session.streaming && lastUserBefore(turn)?.messageId != null;

      // Any finished answer can be rated, not just the last one — the one worth
      // complaining about is often three turns back.
      const rateable =
        turn.who === 'agent' && !session.streaming && turn.messageId != null;

      turn.actions.hidden = !(editable || retryable || rateable);
      if (turn.editButton) turn.editButton.hidden = !editable;
      if (turn.retryButton) turn.retryButton.hidden = !retryable;
      if (turn.rateBar) turn.rateBar.hidden = !rateable;
    }
  }

  const lastUserBefore = (turn) => {
    const index = session.turns.indexOf(turn);
    if (index < 0) return null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (session.turns[cursor].who === 'user') return session.turns[cursor];
    }
    return null;
  };

  const retry = (turn) => {
    const source = lastUserBefore(turn);
    if (source) void send(source.text, { replaceFrom: source });
  };

  /**
   * Send a rating.
   *
   * Goes to the chat API with the same key the conversation used, because that
   * is the endpoint a real host application will call — testing it here is the
   * point of the playground. Only the identifiers travel; the service reads the
   * question, the answer and the calls out of its own tables.
   */
  const rate = async (turn, rating, comment) => {
    const key = apiKey.value.trim();
    if (!key) { toast('Paste an issued API key first.', 'bad'); return; }

    try {
      const response = await fetch('/v1/chat/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          rating,
          comment,
          runId: turn.runId,
          assistantMessageId: turn.messageId,
          conversationId: session.conversationId,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `Failed (${response.status})`);
      }

      toast(rating === 'up' ? 'Thanks — noted.' : 'Noted. It is in the review queue.', 'ok');
    } catch (error) {
      turn.rating = null;
      toast(error.message, 'bad');
    }
  };

  sendBtn.onclick = () => void send();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  });

  const reset = button('New conversation', {
    iconName: 'refresh',
    onclick: () => {
      session.conversationId = null;
      session.firstMessage = true;
      session.turns.length = 0;
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

async function streamChat({
  message, key, trace, conversationId, replaceFromMessageId, identity, onEvent,
}) {
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
    body: JSON.stringify({
      message,
      trace,
      conversationId: conversationId ?? undefined,
      replaceFromMessageId: replaceFromMessageId ?? undefined,
    }),
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

/**
 * The phases of a run, in the order they happen.
 *
 * Shown all at once from the moment the question is sent, rather than one label
 * replacing another: a fast run used to flash through four states in 200ms and
 * leave nothing behind, so "what did it actually do" was unanswerable the
 * moment it finished. Listing them up front also makes a stall legible — the
 * phase it is stuck in is the one still spinning.
 */
const STAGES = [
  ['understanding', 'Reading the question'],
  ['selecting', 'Choosing what to look up'],
  ['retrieving', 'Fetching the data'],
  ['composing', 'Writing the answer'],
];

function handleEvent(event, ctx) {
  const { name, data } = event;

  if (name === 'run.started') {
    ctx.session.conversationId = data.conversationId ?? ctx.session.conversationId;
    // Held so a later rating can name the run, which is what joins it to the
    // audit rows describing what actually ran.
    if (ctx.bubbleRef) ctx.bubbleRef.runId = data.runId ?? null;
    return;
  }

  // The id each turn was stored under. Held on the bubble so "edit this one"
  // has something the service can rewind to.
  if (name === 'turn.recorded') {
    const target = data.role === 'user' ? ctx.userTurn : ctx.bubbleRef;
    if (target) target.messageId = data.messageId ?? null;
    return;
  }

  // Phases arrive on the user channel, so even a key without the trace scope
  // can show honest progress instead of a spinner.
  if (name === 'stage') {
    ctx.bubbleRef.enterStage(data.stage);
    return;
  }

  if (name === 'message.delta') {
    // Writing has begun, so everything before it is done — the composing stage
    // has no completion event of its own.
    ctx.bubbleRef.enterStage('composing');
    ctx.bubbleRef.append(data.text ?? '');
    ctx.bubbleRef.bubble.closest('.pg__transcript').scrollTop = 1e9;
    return;
  }

  // Something an action produced that has to arrive intact. It is also in the
  // answer text, but rendered here as a control so the link is one click rather
  // than a URL to select — and so it is obvious it came from the action rather
  // than from the model's prose.
  if (name === 'artifact') {
    mount(ctx.bubbleRef.bubble, el('div', { class: 'pg__artifact' },
      icon(data.url ? 'link' : 'key', 14),
      data.url
        ? el('a', { href: data.url, target: '_blank', rel: 'noopener noreferrer' }, data.label)
        : frag(el('span', {}, `${data.label}: `),
            el('code', {}, data.value ?? ''))));
    return;
  }

  // A clarifying question arrives whole, not streamed, with the candidates that
  // prompted it. Showing them makes the "asks instead of guessing" behaviour
  // visible rather than just a sentence.
  if (name === 'clarification') {
    ctx.bubbleRef.finishStages();
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
    // `functionsUsed` arrives on the user channel, so the collapsed summary
    // still names them for a caller whose key carries no trace scope.
    (data.functionsUsed ?? []).forEach((fn) => ctx.bubbleRef.noteFunction(fn));
    ctx.bubbleRef.finishStages(data.latencyMs);
    if (data.responseType && data.responseType !== 'answer') {
      mount(ctx.bubbleRef.bubble, el('div', { class: 'pg__tag' }, statusBadge(data.responseType)));
    }
    return;
  }

  if (name === 'error') {
    ctx.bubbleRef.failStages();
    mount(ctx.bubbleRef.bubble, notice(data.message || 'The run failed.', 'bad'));
    return;
  }

  if (!ctx.showTrace) return;

  // The router's read of the question, in its own words. First thing that
  // happens and the first thing worth seeing, so it goes above the plan.
  if (name === 'router.decision' && data.reason) {
    ctx.bubbleRef.think(`Understood as a ${data.intent} request — ${data.reason}`);
    return;
  }

  // The step number, tracked so the catalogue panel below is drawn once rather
  // than repeated for every turn of the loop.
  if (name === 'agent.step') {
    ctx.step = data.step;
    return;
  }

  // ── Trace: how the functions were chosen ──────────────────────────────────
  //
  // Rendered as structure rather than a log line, because the question it has to
  // answer is "did the model pick this, or was it the only option".
  //
  // The agent works in steps now, so this arrives more than once per run. The
  // catalogue is the same every time and only the decision changes, so step two
  // onwards gets a one-line form — the alternative is the same wall of function
  // chips three times over, which buries the thing that actually differs.
  if (name === 'plan.created') {
    if (data.reasoning) ctx.bubbleRef.think(data.reasoning);

    ctx.bubbleRef.traceList.hidden = false;
    const chosen = (data.calls ?? []).map((c) => c.name);
    const considered = data.considered ?? [];

    if ((ctx.step ?? 1) > 1) {
      mount(ctx.bubbleRef.traceList,
        el('div', { class: 'pg__phase' },
          el('strong', {}, `Step ${ctx.step}`),
          ...(data.calls ?? []).map((call) =>
            el('div', { class: 'pg__call' },
              el('strong', {}, call.name),
              Object.keys(call.params ?? {}).length
                ? el('span', {}, ` with ${JSON.stringify(call.params)}`)
                : el('span', { class: 'muted' }, ' with no parameters'))),
          chosen.length === 0
            ? el('div', { class: 'pg__reason' },
                'Called nothing — it had what it needed, or nothing fitted.')
            : null));
      return;
    }

    mount(ctx.bubbleRef.traceList,
      el('div', { class: 'pg__phase' },
        el('strong', {},
          data.isFallback
            ? 'No model chose — fallback'
            : `The model chose from ${considered.length} function(s)`),
        el('div', { class: 'pg__chips' },
          ...considered.map((fnName) =>
            el('span', {
              class: `pg__chip ${chosen.includes(fnName) ? 'is-chosen' : ''}`,
              title: chosen.includes(fnName) ? 'chosen' : 'offered but not chosen',
            }, fnName))),
        // One function offered is not a choice. Saying so stops a fallback
        // reading like a decision — which is exactly how a catalogue with only
        // the demo function in it looked like the model picking it.
        considered.length === 1
          ? el('div', { class: 'pg__reason' },
              'Only one function was available, so this was not really a choice.')
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

  if (name === 'function.completed') ctx.bubbleRef.noteFunction(data.name);

  const simple = {
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
function addBubble(transcript, who, text, { onEdit, onRetry, onRate } = {}) {
  const body = el('div', { class: 'pg__text' });
  const traceList = el('div', { class: 'pg__trace', hidden: true });

  // Every phase, listed from the start. `rows` keeps the nodes so a stage
  // change is a class swap rather than a re-render, which would restart the
  // spinner animation on every event.
  const rows = new Map();
  const stageTrack = el('div', { class: 'pg__stages', hidden: who !== 'agent' });

  for (const [key, label] of STAGES) {
    const time = el('span', { class: 'pg__stage-ms' });
    const row = el('div', { class: 'pg__stage-row is-pending' },
      el('span', { class: 'pg__stage-mark' }),
      el('span', { class: 'pg__stage-label' }, label),
      time);
    rows.set(key, { row, time, label });
    stageTrack.append(row);
  }

  const thinking = el('div', { class: 'pg__thinking', hidden: true });

  /*
   * The whole trace, behind one disclosure.
   *
   * Collapsed by default and titled with whatever the agent is doing right now,
   * so a running turn reads as one live line instead of a wall that reflows on
   * every event. Opening it reveals the stages, the agent's own reasoning and
   * the function calls — the detail an operator wants when something looks
   * wrong, and nobody wants when it does not.
   *
   * `<details>` rather than a click handler and a class: it is keyboard
   * accessible, it is what a screen reader already understands, and the open
   * state survives re-renders for free.
   */
  const processTitle = el('span', { class: 'pg__process-title' }, 'Thinking…');
  const processMeta = el('span', { class: 'pg__process-meta' });
  const processSpinner = el('span', { class: 'pg__process-spin' });

  const process = el('details', { class: 'pg__process' },
    el('summary', { class: 'pg__process-head' },
      processSpinner,
      processTitle,
      processMeta,
      el('span', { class: 'pg__process-caret' }, icon('chevron', 13))),
    el('div', { class: 'pg__process-body' }, stageTrack, thinking, traceList));

  // Hidden until the caller decides the turn can actually be acted on — a user
  // turn needs the id the service assigned it, and only the last answer is
  // worth retrying.
  const actions = el('div', { class: 'pg__actions', hidden: true });

  const turn = {
    who,
    /** Set from `turn.recorded`; null means the service cannot rewind to it. */
    messageId: null,
    /** Set from `run.started`, so a rating can name the run it is about. */
    runId: null,
    rating: null,
    rateBar: null,
    editing: false,
    get text() { return this._raw ?? ''; },
    _raw: text,
    append(chunk) { this._raw = (this._raw ?? '') + chunk; setMarkdown(body, this._raw); },
    set(value) { this._raw = value; setMarkdown(body, value); },
    body,
    actions,
    traceList,
    stageTrack,
    thinking,
    editButton: null,
    retryButton: null,
    bubble: null,

    /** Marks a phase as running, and everything before it as finished. */
    _startedAt: null,
    _active: null,
    enterStage(key) {
      if (!rows.has(key) || this._active === key) return;

      const now = performance.now();
      if (this._startedAt === null) this._startedAt = now;

      // Close whatever was running. Stages arrive in order, so anything above
      // the new one is finished whether or not its own event was seen — a run
      // that answers from cache can skip one entirely.
      let reached = false;
      for (const [name, node] of rows) {
        if (name === key) {
          reached = true;
          node.row.className = 'pg__stage-row is-active';
          node.startedAt = now;
          continue;
        }
        if (!reached) {
          if (node.row.classList.contains('is-active')) {
            node.time.textContent = `${Math.round(now - (node.startedAt ?? now))}ms`;
          }
          node.row.className = 'pg__stage-row is-done';
        }
      }

      this._active = key;
      // The disclosure is collapsed, so its title is the only progress most
      // people will see. It has to name the phase that is actually running.
      processTitle.textContent = rows.get(key).label;
    },

    /** Function names seen this turn, for the collapsed summary. */
    _functions: [],
    noteFunction(name) {
      if (name && !this._functions.includes(name)) this._functions.push(name);
    },

    /** Everything finished. Left on screen — the timings are the point. */
    finishStages(latencyMs) {
      const now = performance.now();
      for (const node of rows.values()) {
        if (node.row.classList.contains('is-active')) {
          node.time.textContent = `${Math.round(now - (node.startedAt ?? now))}ms`;
        }
        node.row.className = 'pg__stage-row is-done';
      }
      this._active = 'done';
      if (latencyMs !== undefined) {
        stageTrack.append(el('div', { class: 'pg__stage-total' }, `${latencyMs}ms total`));
      }

      // Once it is over, "Writing the answer" is not useful. What was done is.
      const elapsed = latencyMs ?? Math.round(now - (this._startedAt ?? now));
      process.classList.add('is-done');
      processSpinner.hidden = true;
      processTitle.textContent = `Thought for ${(elapsed / 1000).toFixed(1)}s`;
      processMeta.textContent = this._functions.length
        ? `· ${this._functions.join(', ')}`
        : '';
    },

    /** Stops the spinner on the phase that failed, so it stays visible. */
    failStages() {
      for (const node of rows.values()) {
        if (node.row.classList.contains('is-active')) {
          node.row.className = 'pg__stage-row is-failed';
        }
      }
      this._active = 'done';
      process.classList.add('is-done', 'is-failed');
      processSpinner.hidden = true;
      processTitle.textContent = 'Stopped';
      // Opened on failure: the trace is the reason anyone is looking.
      process.open = true;
    },

    /** A line of the agent's own reasoning, as it arrives. */
    think(line) {
      thinking.hidden = false;
      mount(thinking, el('div', { class: 'pg__thought' }, line));
    },
  };

  if (onEdit) {
    turn.editButton = button('Edit', {
      size: 'sm',
      iconName: 'edit',
      title: 'Change this message and run the conversation again from here',
      onclick: () => onEdit(turn),
    });
    mount(actions, turn.editButton);
  }

  if (onRetry) {
    turn.retryButton = button('Try again', {
      size: 'sm',
      iconName: 'refresh',
      title: 'Ask the same question again, discarding this answer',
      onclick: () => onRetry(turn),
    });
    mount(actions, turn.retryButton);
  }

  if (onRate) {
    /*
     * Thumbs on the answer.
     *
     * A dislike asks for a reason, because "this was wrong" and "this was wrong
     * because it used the registration id" are worth very different amounts to
     * whoever reads the queue. It is optional — refusing to record a rating
     * without an explanation would mean recording far fewer of them.
     */
    const up = el('button', {
      class: 'iconbtn', type: 'button', title: 'This answer was good',
    }, icon('up', 14));
    const down = el('button', {
      class: 'iconbtn', type: 'button', title: 'Something was wrong with this answer',
    }, icon('down', 14));

    const paint = () => {
      up.className = `iconbtn ${turn.rating === 'up' ? 'is-on' : ''}`;
      down.className = `iconbtn ${turn.rating === 'down' ? 'is-on--bad' : ''}`;
    };

    up.onclick = async () => {
      turn.rating = 'up';
      paint();
      await onRate(turn, 'up', null);
    };

    down.onclick = async () => {
      const comment = prompt('What was wrong with it? (optional)') ?? '';
      turn.rating = 'down';
      paint();
      await onRate(turn, 'down', comment.trim() || null);
    };

    turn.rateBar = el('div', { class: 'pg__rate' }, up, down);
    mount(actions, turn.rateBar);
  }

  turn.bubble = el('div', { class: `pg__bubble pg__bubble--${who}` },
    el('div', { class: 'pg__who' },
      el('span', { class: 'avatar', style: who === 'agent' ? '' : 'background:var(--bg-subtle);color:var(--text-muted)' },
        who === 'agent' ? 'O' : 'U'),
      el('span', {}, who === 'agent' ? 'Agent' : 'You'),
      actions),
    who === 'agent' ? process : null,
    body);

  if (who === 'user') body.textContent = text;
  else setMarkdown(body, text);

  transcript.append(turn.bubble);
  transcript.scrollTop = transcript.scrollHeight;

  // `text` is the running source; `body` is its rendered form.
  return turn;
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
