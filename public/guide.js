/* The in-app guide.
 *
 * Written as a document rather than tooltips, because the questions it answers
 * are not "what does this field do" — the editor answers those — but "what is
 * this thing, why is it built this way, and what do I do first". Those need
 * paragraphs and a worked example.
 *
 * It ships with the console rather than linking out: the console is what you
 * open when the network or the deployment is misbehaving, and documentation
 * that needs a working internet connection is documentation you do not have.
 */

import { el, frag, codeBlock, notice, table, button } from './ui.js';
import { navigate } from './app.js';

const SECTIONS = [
  {
    group: 'Start here',
    items: [
      { id: 'what', title: 'What this service is' },
      { id: 'setup', title: 'Installing it' },
      { id: 'first-run', title: 'Your first ten minutes' },
    ],
  },
  {
    group: 'Concepts',
    items: [
      { id: 'applications', title: 'Applications' },
      { id: 'roles', title: 'Roles and scopes' },
      { id: 'functions', title: 'Functions' },
      { id: 'ambiguity', title: 'Asking instead of guessing' },
      { id: 'knowledge', title: 'The knowledge base' },
    ],
  },
  {
    group: 'How to',
    items: [
      { id: 'write-read', title: 'Write a read function' },
      { id: 'write-write', title: 'Write a write action' },
      { id: 'models', title: 'Configure a model' },
      { id: 'calling', title: 'Call the agent' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { id: 'api-routes', title: 'API routes' },
      { id: 'security', title: 'Why it is safe' },
      { id: 'database', title: 'The database it uses' },
      { id: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
];

export function guideView(sectionId) {
  const prose = el('div', { class: 'prose' }, ...SECTIONS.flatMap((group) =>
    group.items.map((item) => article(item.id))));

  const toc = el('nav', {}, ...SECTIONS.flatMap((group) => [
    el('div', { class: 'toc-group' }, group.group),
    ...group.items.map((item) =>
      el('a', {
        href: `#/guide/${item.id}`,
        'data-toc': item.id,
        onclick: (event) => {
          event.preventDefault();
          // replaceState rather than assigning location.hash: changing the hash
          // fires hashchange, which re-renders the whole guide and loses the
          // scroll position we are about to set.
          window.history.replaceState(null, '', `#/guide/${item.id}`);
          jumpTo(item.id);
        },
      }, item.title)),
  ]));

  // The returned node is not in the document yet — the router appends it after
  // this function returns — so the jump has to wait. A macrotask, not a
  // microtask (which would still run first) and not requestAnimationFrame,
  // which never fires while the tab is not compositing.
  setTimeout(() => {
    if (sectionId) jumpTo(sectionId);
    else highlight(SECTIONS[0].items[0].id);
  }, 0);

  return el('div', { class: 'guide' },
    el('aside', { class: 'guide__toc' }, toc),
    prose);
}

/**
 * Move to a section and mark it in the table of contents.
 *
 * Deliberately not `behavior: 'smooth'`: it is silently a no-op in some
 * browsers, which turns "jump to Troubleshooting" into "nothing happens".
 * A table of contents that does not go anywhere is worse than one that jumps.
 */
function jumpTo(id) {
  document.getElementById(`guide-${id}`)?.scrollIntoView({ block: 'start' });
  highlight(id);
}

function highlight(id) {
  for (const link of document.querySelectorAll('[data-toc]')) {
    link.classList.toggle('is-active', link.dataset.toc === id);
  }
}

function article(id) {
  const build = ARTICLES[id];
  return el('section', { id: `guide-${id}` }, build ? build() : null);
}

const h3 = (id, text) => el('h3', { id: `guide-${id}-h` }, text);
const p = (...children) => el('p', {}, ...children);
const h4 = (text) => el('h4', {}, text);
const code = (text) => el('code', {}, text);
const ul = (...items) => el('ul', {}, ...items.map((item) => el('li', {}, item)));
const ol = (...items) => el('ol', {}, ...items.map((item) => el('li', {}, item)));
const b = (text) => el('strong', {}, text);

const goto = (label, hash) =>
  button(label, { size: 'sm', onclick: () => navigate(hash) });

const route = (method, path, purpose) => [code(method), code(path), purpose];

const ARTICLES = {
  // ── Start here ────────────────────────────────────────────────────────────

  what: () => frag(
    h3('what', 'What this service is'),
    p('An agent that answers questions about your data and performs actions on it, ',
      b('without ever writing SQL'), '. That is the whole design, and everything ',
      'else follows from it.'),
    p('A language model is given a catalogue of functions an administrator has ',
      'written and approved. It picks one and fills in its parameters. It does not ',
      'see your schema, it does not compose a query, and it has no path to the ',
      'database. What it produces is a function name and a small object of values, ',
      'both of which are validated before anything runs.'),

    h4('Why not let it write SQL'),
    p('The predecessor to this service did, and guarded the output with a six-step ',
      'regex pipeline: a forbidden-pattern blocklist, a table whitelist, ',
      'sensitive-column redaction, injected RBAC conditions, a row limit and a ',
      're-check. It was careful work and it had three confirmed bypasses, because a ',
      'regular expression cannot parse SQL. A ', code('UNION'), ' scoped only its ',
      'first branch; an injected ', code('WHERE'), ' landed in a subquery; ',
      code('SELECT *'), ' named no column so nothing was redacted.'),
    p('Here the parser is the authority. When you save a function, the compiled ',
      'query is handed to Postgres itself — ', code('LIMIT 0'), ' to resolve every ',
      'identifier, ', code('EXPLAIN'), ' for the plan — inside a ', code('READ ONLY'),
      ' transaction. Nothing tries to understand SQL by pattern.'),

    h4('What it is not'),
    ul(
      'It is not a text-to-SQL tool. There is no code path from model output to the driver.',
      'It is not tied to any product. Roles, scopes, functions and models are rows in tables, not code.',
      'It does not write to your database. Writes go back out through your own API.'),
  ),

  setup: () => frag(
    h3('setup', 'Installing it'),
    p('The service has no database of its own. You point it at a Postgres you ',
      'already run and it creates its own tables inside it — every one named ',
      code('agent_*'), ' — touching nothing that was already there.'),

    h4('1. Environment'),
    codeBlock(
      '# The agent\'s own tables. Needs to read and write rows, and ideally create them.\n' +
      'DATABASE_URL=postgres://user:password@host:5432/your_database\n\n' +
      '# Runs registry functions. Must hold SELECT and nothing else.\n' +
      'DATABASE_READ_URL=postgres://ori_reader:password@host:5432/your_database\n\n' +
      '# 32 bytes, base64 or hex. Encrypts model credentials at rest.\n' +
      'ENCRYPTION_KEY=<openssl rand -base64 32>\n\n' +
      '# Optional.\n' +
      'DATABASE_SCHEMA=ori          # where the agent_* tables go\n' +
      'PORT=3200',
      { wrap: true }),

    h4('2. The read-only role'),
    p('This is the one piece of setup worth doing carefully. The read connection is ',
      'what executes administrator-authored SQL, and its inability to write is what ',
      'makes that safe.'),
    codeBlock(
      "CREATE ROLE ori_reader LOGIN PASSWORD 'choose-a-strong-password';\n" +
      'GRANT CONNECT ON DATABASE your_database TO ori_reader;\n' +
      'GRANT USAGE   ON SCHEMA public TO ori_reader;\n' +
      'GRANT SELECT  ON ALL TABLES IN SCHEMA public TO ori_reader;\n' +
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ori_reader;',
      { wrap: true }),
    notice(
      'The service checks this before it opens the connection. If the role holds INSERT, ' +
      'UPDATE, DELETE or TRUNCATE on any table, the pool is not opened at all and no ' +
      'function can run — you will see exactly which tables on the Database page.',
      'info'),

    h4('3. Start it'),
    codeBlock('npm install && npm run start:dev', { wrap: true }),
    p('Open ', code('/admin'), '. If anything above is missing or wrong you get a setup ',
      'screen that says which step is outstanding and what to do, rather than a process ',
      'that exits. If the database will not let the service create its tables — common ',
      'on managed Postgres — the screen hands you the exact DDL to give whoever can.'),
  ),

  'first-run': () => frag(
    h3('first-run', 'Your first ten minutes'),
    ol(
      frag(b('Create an application.'), ' One row per product that will call this service. ',
        'It arrives with a live ', code('demo'), ' function, so there is something ',
        'working to test against immediately. ', goto('Applications', '#/applications')),
      frag(b('Look at the demo function.'), ' It lists the tables the read connection ',
        'can see. It reads ', code('pg_catalog'), ', so it needs no seed data and works ',
        'on any Postgres — and it answers the first question you will have when a ',
        'function you wrote returns nothing. ', goto('Functions', '#/functions')),
      frag(b('Define a role.'), ' Every chat request states one, and a role that is not ',
        'defined here is refused — there is no default. Start with one that allows ',
        code('*'), '. ', goto('Roles', '#/roles')),
      frag(b('Add a model.'), ' Any OpenAI-compatible endpoint. Use ', b('Test connection'),
        ' before saving; an unreachable model is otherwise only noticed by the first ',
        'real chat request. ', goto('Models', '#/models')),
      frag(b('Issue an API key'), ' with the ', code('chat'), ' and ', code('trace'),
        ' scopes, and ask it something. "What tables are in the database?" exercises ',
        'the whole pipeline: router, planner, executor, synthesizer.')),
    notice(
      'If you only do one thing: install the demo function and ask about tables. It proves ' +
      'the model, the registry, the read connection and the streaming path all work, ' +
      'before you have written anything of your own.',
      'ok'),
  ),

  // ── Concepts ──────────────────────────────────────────────────────────────

  applications: () => frag(
    h3('applications', 'Applications'),
    p('An application is one product calling this service. It owns its own functions, ',
      'roles, services and keys, and nothing crosses between applications. One ',
      'deployment can serve several.'),

    h4('How end users are identified'),
    p('Each application picks one of two modes, and the difference is a real one.'),
    table(['Mode', 'How it works', 'What you get'], [
      [code('jwt'),
        'Your application forwards the end user\'s token; the agent verifies it against your issuer and JWKS.',
        'Identity is proven.'],
      [code('asserted'),
        'Your server states who the user is in an X-End-User header, believed because the API key authenticated the channel.',
        'The trust boundary is the API key.'],
    ]),
    notice(
      'Stated plainly: with asserted identity, a chat key that reaches a browser is an ' +
      'impersonation primitive for every user of that application. Use jwt where you can ' +
      'issue verifiable tokens; keep asserted keys server-side.',
      'warn'),
    p('Neither mode has a fallback. There is no anonymous path, no default role, and no ',
      'way to construct a caller without authentication. An unknown role is refused ',
      'rather than defaulted, because a typo in a role name must not silently grant access.'),
  ),

  roles: () => frag(
    h3('roles', 'Roles and scopes'),
    p('A ', b('role'), ' is a row: a name, the functions it may call, the write scopes ',
      'it holds, and the scope keys it is exempt from. Not a class, not an enum — ',
      'something you edit in this console without a deploy.'),

    h4('Scopes'),
    p('A scope is a key you chose (', code('org_id'), ', ', code('tenant'), ', ',
      code('owner_id'), '), a value the caller supplies, and a column a function binds ',
      'it to. It is how one function serves every tenant without any of them seeing ',
      'another\'s rows.'),
    ol(
      frag('The function declares ', code('{"key":"org_id","column":"o.org_id"}'),
        ' and uses ', code('{{scope:org_id}}'), ' in its SQL.'),
      frag('The caller sends ', code('{"org_id": 42}'), ' with the request.'),
      frag('The engine compiles that to ', code('o.org_id = $3'), ' with 42 bound to it.')),

    h4('The rule that matters'),
    p('If a scope cannot be bound, the function is ', b('refused'), '. It does not quietly ',
      'become an unfiltered query. There are exactly three outcomes:'),
    table(['Situation', 'Result'], [
      ['The caller supplied a value', code('column = $n'), ],
      ['The caller\'s role lists the key as exempt', code('TRUE')],
      ['Neither', b('Refused')],
    ]),
    p('Exemption is stored on the role, explicit, and visible on the Roles page. It is ',
      'never the consequence of a missing value. That is the single most important ',
      'line in the codebase.'),
    p('The validator also refuses to save a function that ', b('declares'), ' a scope ',
      'filter but never applies it in the SQL — a function that looks protected and is ',
      'not is worse than one that obviously is not.'),
  ),

  functions: () => frag(
    h3('functions', 'Functions'),
    p('A function is the unit of everything the agent can do. Two kinds:'),
    ul(
      frag(b('read'), ' — parameterised SQL, run on the read-only connection.'),
      frag(b('write'), ' — a declarative HTTP call back into your own API. This service ',
        'never writes to your database, so your existing validation, business rules and ',
        'audit trail still apply.')),

    h4('The lifecycle'),
    table(['Status', 'Meaning'], [
      [code('draft'), 'Saved and validated by Postgres, but not reachable by the agent.'],
      [code('approved'), 'Reviewed by a person.'],
      [code('live'), 'Visible to the planner and callable.'],
      [code('disabled'), 'Kept, with its history, but switched off.'],
    ]),
    p('Editing a live function returns it to draft, because an approval covers the ',
      'version that was actually read.'),

    h4('What the planner sees'),
    p('Only the name, description, when-to-use, when-not-to-use, and the parameter ',
      'schema. Never the SQL, never the schema, never a row. This means the description ',
      'is not documentation — it is the interface. A function the model cannot tell ',
      'apart from its neighbour will be confused with it, no matter how good the ',
      'retrieval is, which is why the editor warns you when two descriptions overlap.'),
  ),

  ambiguity: () => frag(
    h3('ambiguity', 'Asking instead of guessing'),
    p('A lookup for "order 1002" might match ', code('ORD-1002'), ', ', code('ORD-10023'),
      ' and ', code('ORD-21002'), '. Returning the first is the kind of wrong answer ',
      'nobody catches.'),
    p('A function that returns ', code('single-or-ambiguous'), ' emits a ',
      code('match_score'), ' column between 0 and 100. The engine compares the top two:'),
    ul(
      'If the best score is confidently high and clearly ahead of the second, it answers.',
      'Otherwise it stops, returns the candidates with their labels and details, and asks which one was meant.',
      'The answer is remembered for the rest of the conversation, so nobody is asked twice.'),
    p('The reflector cannot be overridden by the model — an ambiguous result short-circuits ',
      'to a clarifying question before the synthesizer is ever reached.'),
    p('Your job when authoring is to make ', code('label'), ' and ', code('detail'),
      ' genuinely distinguishing. "Order ORD-1002" and "Order ORD-1002" as two candidates ',
      'is a question nobody can answer; "ORD-1002 · shipped 12 Jul" and ',
      '"ORD-21002 · pending" is one they can.'),
  ),

  knowledge: () => frag(
    h3('knowledge', 'The knowledge base'),
    p('Functions tell the agent what it can look up. They say nothing about what any of ',
      'it means — what a level is, when credits are consumed, what a band on a score ',
      'signifies. Documents fill that in.'),
    p('Upload them under Knowledge: PDF, Word, text, Markdown, CSV, or pasted straight ',
      'in. Each one declares which roles may retrieve it, and that filter is applied in ',
      'the query — a document a role may not see cannot influence what that role gets ',
      'back, and cannot take up one of the few slots a prompt has room for.'),
    p('They are used in four places:'),
    ul(
      'Choosing a function, so the user\'s words map onto the right one. Background only — every fact still comes from a function call.',
      'Writing an answer, so a returned number can be explained. A live result always beats a document.',
      'When no function fits: the agent answers from the documents instead, citing them with [1] markers.',
      '"What can you do", so the answer describes the product rather than reciting a list of functions.'),
    p('The first is the one to be careful with. A model handed documentation while it is ',
      'choosing a function will otherwise answer from the documentation, and report a ',
      'balance it read in a worked example. It is told explicitly that these are ',
      'documents and not data.'),

    h4('How a passage is found'),
    p('Two searches run and their rankings are combined. Keyword search is exact and ',
      'cannot match "how much does it cost" against a section headed "Pricing"; meaning ',
      'search does that, and will confidently return something adjacent when the user ',
      'typed a reference code. Each covers the other\'s blind spot.'),
    p('The meaning half needs an embedding model, and is optional:'),
    ul(
      'None configured — keyword search only. Works immediately, weaker on rephrasing. The Knowledge page says so rather than leaving you to guess.',
      'One configured — both halves run. Add it on Models with purpose "embedding", then Re-index all.',
      'It is a separate model row because the provider running your chat model often cannot embed at all, so it can point anywhere.'),
    p('Adding an embedding model later does not mean uploading everything again — the ',
      'extracted text is kept, and Re-index all rebuilds from it.'),
    p('A scanned PDF has no text to extract, and the upload says so rather than storing ',
      'an empty document. Run it through OCR, or paste the text in instead.'),
  ),

  // ── How to ────────────────────────────────────────────────────────────────

  'write-read': () => frag(
    h3('write-read', 'Write a read function'),
    p('Two tokens exist in the template language, and nothing else:'),
    table(['Token', 'Compiles to'], [
      [code('{{param:name}}'), frag('a bound ', code('$n'), ' placeholder')],
      [code('{{scope:key}}'), frag(code('column = $n'), ', bound to the caller\'s scope value')],
    ]),
    p('A raw ', code('$1'), ' is rejected — the engine assigns the numbers. ',
      code('${…}'), ' is rejected. ', code('SELECT *'), ' is rejected. Any second ',
      'statement is rejected. There is no syntax that produces string interpolation, ',
      'which is the property that matters: not that it is filtered, but that it cannot ',
      'be written.'),

    h4('A complete example'),
    codeBlock(
      "SELECT o.id                AS id,\n" +
      "       o.reference         AS label,\n" +
      "       o.status || ' · ' || to_char(o.placed_at, 'DD Mon') AS detail,\n" +
      "       CASE WHEN o.reference = {{param:reference}} THEN 100 ELSE 60 END AS match_score,\n" +
      "       o.status, o.total_amount, o.placed_at\n" +
      "  FROM orders o\n" +
      " WHERE o.reference ILIKE '%' || {{param:reference}} || '%'\n" +
      "   AND {{scope:org_id}}"),

    h4('The four special columns'),
    table(['Column', 'Used for'], [
      [code('id'), 'The record identifier. Required for single-or-ambiguous.'],
      [code('label'), 'What a user would recognise it by, shown in a clarifying question.'],
      [code('detail'), 'A second line that tells two candidates apart.'],
      [code('match_score'), '0–100, how well this row matches. Drives the ambiguity decision.'],
    ]),
    p('Everything else you select is returned as data.'),

    h4('What happens when you save'),
    p('The template is compiled to bound placeholders, then handed to Postgres: ',
      code('LIMIT 0'), ' to resolve every identifier and report the output columns, and ',
      code('EXPLAIN'), ' for the plan, both inside a ', code('READ ONLY'), ' transaction. ',
      'You see the plan in the editor, so "is this index-backed" gets answered while you ',
      'are writing it rather than being a checklist item nobody runs.'),
    p(code('LIMIT'), ' is added by the engine — a function cannot ship without one — and ',
      'paged results carry their true total for free.'),
    p(b('Try it'), ' runs the function as any role, on a draft, with scoping applied ',
      'exactly as in production. Leaving a scope blank is a real test of the refusal.'),
  ),

  'write-write': () => frag(
    h3('write-write', 'Write a write action'),
    p('A write function is a declarative HTTP call, stored as JSON:'),
    codeBlock(
      '{\n' +
      '  "service": "orders-api",\n' +
      '  "method": "POST",\n' +
      '  "path": "/v1/orders/{{param:order_id}}/cancel",\n' +
      '  "body": { "reason": "{{param:reason}}" },\n' +
      '  "forwardUserToken": true\n' +
      '}'),

    h4('Why it names a service, not a URL'),
    p('A saved function is data. If it could name its own host, anyone who could author ',
      'a function could make this server issue requests to internal addresses — cloud ',
      'metadata endpoints, admin panels on the private network. Resolving through a ',
      'per-application service registry means the reachable set is configuration an ',
      'operator controls. Register base URLs on the Applications page.'),

    h4('Also enforced'),
    ul(
      'Path parameters are URL-encoded, so a value cannot add a path segment or a query string.',
      'The resolved URL is checked against the registered origin.',
      'Redirects are not followed — another way to reach an unregistered host.',
      'Authorization and Cookie headers stored in a function body are dropped; the engine sets Authorization from the end user\'s token when the action asks for it.',
      'A failed write is never retried. Without an idempotency guarantee from your API, an automatic retry after a timeout can duplicate the change.'),
    notice(
      'requiresConfirmation is stored and shown but the two-turn confirm flow is not ' +
      'implemented yet, so a destructive action still executes on the first call. Mark ' +
      'destructive actions carefully until it is.',
      'warn'),
  ),

  models: () => frag(
    h3('models', 'Configure a model'),
    p('Any OpenAI-compatible endpoint works: vLLM, Ollama, or a hosted API. Which model ',
      'plans and which writes the answer is a row in a table, not an environment variable ',
      'that needs a redeploy.'),

    h4('Purposes and fallback'),
    p('Each model has a purpose — ', code('any'), ', ', code('planner'), ', ',
      code('synthesizer'), ' or ', code('router'), ' — and a priority. Within a purpose ',
      'the lowest priority number is primary and the next enabled model is its fallback. ',
      'A purpose-specific model outranks ', code('any'), ', so pointing ', code('router'),
      ' at something small and fast while ', code('any'), ' stays on something larger ',
      'works with no further wiring.'),

    h4('Test before saving'),
    p('The editor probes the endpoint with the values on screen. It is worth doing: an ',
      'unreachable model is otherwise only noticed by the first real chat request, and ',
      'the failure then looks like an agent problem rather than a configuration one.'),
    table(['What you see', 'What it means'], [
      ['Nothing accepted a connection', 'Wrong host or port, or the server is not running.'],
      ['That hostname did not resolve', 'A typo in the host part of the base URL.'],
      ['No endpoint at that path', 'The base URL usually ends in /v1.'],
      ['401 or 403', 'The API key is missing or wrong for this provider.'],
    ]),
    p('Credentials are encrypted at rest with ', code('ENCRYPTION_KEY'), ', never ',
      'returned by any API, and never shown again. Leaving the field blank when editing ',
      'keeps the stored one.'),
  ),

  calling: () => frag(
    h3('calling', 'Call the agent'),
    p('Issue a key on the Applications page, then:'),
    codeBlock(
      'curl -N http://localhost:3200/v1/chat/stream \\\n' +
      '  -H "X-Api-Key: ori_xxx.yyy" \\\n' +
      '  -H \'X-End-User: {"id":"4821","role":"support","scopes":{"org_id":42}}\' \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"message":"what is the status of order 10023?","trace":true}\'',
      { wrap: true }),

    h4('The event stream'),
    codeBlock(
      'event: run.started        {"runId":"…","conversationId":"…"}\n' +
      'event: router.decision    {"intent":"read"}                    ← trace only\n' +
      'event: plan.created       {"calls":[{"name":"get_order",…}]}   ← trace only\n' +
      'event: function.started   {"name":"get_order"}                 ← trace only\n' +
      'event: function.completed {"name":"get_order","status":"single","rowCount":1}\n' +
      'event: message.delta      {"text":"Order 10023 "}\n' +
      'event: message.delta      {"text":"shipped on 12 July"}\n' +
      'event: run.completed      {"responseType":"answer",…}',
      { wrap: true }),
    p(code('POST /v1/chat'), ' is the same run without the stream, returning the finished ',
      'response.'),
    notice(
      'Trace events name functions and echo extracted parameters. They are sent only when ' +
      'the API key carries the trace scope and the request asks for them. An end-user ' +
      'surface should use a key without that scope.',
      'warn'),
    p('The full API reference, generated from the code, is at ',
      el('a', { href: '/docs', target: '_blank', rel: 'noopener' }, '/docs'), '.'),
  ),

  // ── Reference ─────────────────────────────────────────────────────────────

  apiRoutes: () => frag(
    h3('api-routes', 'API routes'),
    p('The full OpenAPI reference is generated from the Nest routes and served at ',
      el('a', { href: '/docs', target: '_blank', rel: 'noopener' }, '/docs'),
      '. This page is the quick map for operators.'),
    notice(
      'The console shell and its files under /admin, such as /admin/app.js and ' +
      '/admin/styles.css, are static assets. They are intentionally omitted here and in Swagger.',
      'info'),

    h4('Health'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/health', 'Process liveness. This never touches a dependency.'),
      route('GET', '/ready', 'Database readiness, registry counts and enabled model count.'),
    ]),

    h4('Chat API'),
    p('These routes use an application API key. Chat calls also carry an end-user identity.'),
    table(['Method', 'Route', 'Purpose'], [
      route('POST', '/v1/chat', 'Run the agent and return the finished response.'),
      route('POST', '/v1/chat/stream', 'Run the same agent path as Server-Sent Events.'),
      route('POST', '/v1/chat/feedback', 'Record a thumbs up or down for one answer.'),
    ]),

    h4('Management API'),
    p('These routes use an application API key with the ', code('manage'),
      ' scope and are scoped to that key\'s application.'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/v1/manage/functions', 'List functions, optionally by status.'),
      route('GET', '/v1/manage/functions/{name}', 'Fetch one function, including drafts.'),
      route('POST', '/v1/manage/functions/check', 'Validate a function without saving.'),
      route('POST', '/v1/manage/functions', 'Create a draft function.'),
      route('PUT', '/v1/manage/functions/{name}', 'Update a function and return it to draft.'),
      route('POST', '/v1/manage/functions/{name}/status', 'Promote, disable or retire a function.'),
      route('GET', '/v1/manage/functions/{name}/versions', 'Read function version history.'),
      route('DELETE', '/v1/manage/functions/{name}', 'Delete a function.'),
      route('GET', '/v1/manage/roles', 'List roles.'),
      route('PUT', '/v1/manage/roles/{name}', 'Create or update a role.'),
      route('DELETE', '/v1/manage/roles/{name}', 'Delete a role.'),
      route('GET', '/v1/manage/services', 'List registered HTTP action targets.'),
      route('PUT', '/v1/manage/services/{name}', 'Register an HTTP action target.'),
      route('DELETE', '/v1/manage/services/{name}', 'Remove an HTTP action target.'),
      route('GET', '/v1/manage/conversations', 'List conversations.'),
      route('GET', '/v1/manage/conversations/{key}', 'Fetch a conversation transcript.'),
    ]),

    h4('Setup API'),
    p('These are unauthenticated because they exist before the first operator can log in. ',
      'Creating the first account is refused as soon as one already exists.'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/setup', 'Read setup status and stage.'),
      route('POST', '/admin/api/setup/check', 'Reconnect and refresh setup status.'),
      route('GET', '/admin/api/setup/sql', 'Return the DDL needed for manual setup.'),
      route('POST', '/admin/api/setup/admin', 'Create the first operator account.'),
    ]),

    h4('Console session'),
    p('These routes are used by the in-app console. Except for login and setup, they use ',
      'the ', code('ori_admin_session'), ' cookie. Mutating routes require the admin or ',
      'owner role where the controller marks that requirement.'),
    table(['Method', 'Route', 'Purpose'], [
      route('POST', '/admin/api/login', 'Start an operator session and set the cookie.'),
      route('POST', '/admin/api/logout', 'End the current operator session.'),
      route('GET', '/admin/api/me', 'Read the current operator.'),
    ]),

    h4('Console observability and database'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/overview', 'Dashboard overview, active runs and recent runs.'),
      route('GET', '/admin/api/runs/{runKey}', 'One run, including its recorded steps.'),
      route('GET', '/admin/api/audit', 'Audit log entries.'),
      route('GET', '/admin/api/database', 'Database connection and privilege report.'),
      route('GET', '/admin/api/database/tables', 'Service-owned table names.'),
    ]),

    h4('Console applications, services and keys'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/applications', 'List applications.'),
      route('POST', '/admin/api/applications', 'Create an application and install the demo function.'),
      route('PUT', '/admin/api/applications/{id}', 'Update an application.'),
      route('POST', '/admin/api/applications/{id}/functions/demo', 'Reinstall the demo function if it was deleted.'),
      route('GET', '/admin/api/applications/{id}/services', 'List registered HTTP action targets.'),
      route('PUT', '/admin/api/applications/{id}/services/{name}', 'Create or update an HTTP action target.'),
      route('DELETE', '/admin/api/applications/{id}/services/{name}', 'Delete an HTTP action target.'),
      route('GET', '/admin/api/applications/{id}/keys', 'List issued API keys.'),
      route('POST', '/admin/api/applications/{id}/keys', 'Issue an API key. The secret is returned once.'),
      route('DELETE', '/admin/api/keys/{id}', 'Revoke an API key.'),
    ]),

    h4('Console feedback and knowledge'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/applications/{id}/feedback', 'List answer feedback and summary counts.'),
      route('GET', '/admin/api/applications/{id}/feedback/{feedbackId}', 'Read one feedback item with run evidence.'),
      route('POST', '/admin/api/applications/{id}/feedback/{feedbackId}/reviewed', 'Mark feedback reviewed or open.'),
      route('DELETE', '/admin/api/applications/{id}/feedback/{feedbackId}', 'Delete feedback.'),
      route('GET', '/admin/api/applications/{id}/knowledge', 'List knowledge documents and indexing status.'),
      route('GET', '/admin/api/applications/{id}/knowledge/{documentId}', 'Read one knowledge document.'),
      route('POST', '/admin/api/applications/{id}/knowledge/text', 'Create a document from pasted text.'),
      route('POST', '/admin/api/applications/{id}/knowledge/upload', 'Upload a PDF, Word, text, Markdown or CSV document.'),
      route('PUT', '/admin/api/applications/{id}/knowledge/{documentId}/roles', 'Update document visibility by role.'),
      route('POST', '/admin/api/applications/{id}/knowledge/{documentId}/reindex', 'Re-chunk and re-embed one document.'),
      route('POST', '/admin/api/applications/{id}/knowledge/reindex', 'Re-index all documents.'),
      route('DELETE', '/admin/api/applications/{id}/knowledge/{documentId}', 'Delete a knowledge document.'),
    ]),

    h4('Console functions, roles and playground'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/applications/{id}/functions', 'List application functions, optionally by status.'),
      route('GET', '/admin/api/applications/{id}/functions/export', 'Export all functions as a portable bundle.'),
      route('POST', '/admin/api/applications/{id}/functions/import', 'Import a bundle as draft functions.'),
      route('GET', '/admin/api/applications/{id}/functions/{name}', 'Read one function and its versions.'),
      route('POST', '/admin/api/applications/{id}/functions/check', 'Validate a function without saving.'),
      route('POST', '/admin/api/applications/{id}/functions/{name}/try', 'Run a draft or live function as a chosen role.'),
      route('POST', '/admin/api/applications/{id}/functions', 'Create a draft function.'),
      route('PUT', '/admin/api/applications/{id}/functions/{name}', 'Update a function and return it to draft.'),
      route('POST', '/admin/api/applications/{id}/functions/{name}/status', 'Promote, disable or retire a function.'),
      route('DELETE', '/admin/api/applications/{id}/functions/{name}', 'Delete a function.'),
      route('GET', '/admin/api/applications/{id}/roles', 'List roles.'),
      route('GET', '/admin/api/applications/{id}/roles/{name}/scope-requirements', 'Show the scope values a role must supply.'),
      route('PUT', '/admin/api/applications/{id}/roles/{name}', 'Create or update a role.'),
      route('DELETE', '/admin/api/applications/{id}/roles/{name}', 'Delete a role.'),
      route('POST', '/admin/api/applications/{id}/playground/stream', 'Run the console playground as an SSE stream.'),
      route('POST', '/admin/api/applications/{id}/playground/feedback', 'Rate a playground answer.'),
    ]),

    h4('Console models, conversations and operators'),
    table(['Method', 'Route', 'Purpose'], [
      route('GET', '/admin/api/models', 'List model endpoints.'),
      route('POST', '/admin/api/models', 'Create a model endpoint.'),
      route('PUT', '/admin/api/models/{id}', 'Update a model endpoint.'),
      route('DELETE', '/admin/api/models/{id}', 'Delete a model endpoint.'),
      route('GET', '/admin/api/models/prefix-defaults', 'Read inferred embedding prefixes for a model id.'),
      route('POST', '/admin/api/models/test', 'Test unsaved model settings.'),
      route('POST', '/admin/api/models/health', 'Check model reachability for an application.'),
      route('GET', '/admin/api/applications/{id}/conversations', 'List conversations for an application.'),
      route('GET', '/admin/api/applications/{id}/conversations/{key}', 'Read one conversation.'),
      route('DELETE', '/admin/api/applications/{id}/conversations/{key}', 'Delete a conversation.'),
      route('GET', '/admin/api/conversations/{key}', 'Fetch a raw transcript.'),
      route('GET', '/admin/api/admins', 'List operator accounts.'),
      route('POST', '/admin/api/admins', 'Create an operator account.'),
      route('POST', '/admin/api/admins/{id}/password', 'Set an operator password.'),
    ]),
  ),

  security: () => frag(
    h3('security', 'Why it is safe'),
    p('Registry SQL is written by a human, but it is stored as ', b('data'),
      ', and data is not reviewed code. Three things contain it.'),

    h4('1. The read connection cannot write'),
    p('Checked before the pool is opened: the service asks Postgres whether that role ',
      'holds ', code('INSERT'), ', ', code('UPDATE'), ', ', code('DELETE'), ' or ',
      code('TRUNCATE'), ' on any table outside the system schemas, using ',
      code('has_table_privilege'), ' — which resolves role inheritance and grants made ',
      'to ', code('PUBLIC'), ', exactly where an unintended privilege hides. If it holds ',
      'any, the pool is never created and no function can run.'),
    p('It deliberately does not test by creating a temp table: Postgres grants ',
      code('TEMP'), ' to ', code('PUBLIC'), ' by default, so that probe rejects every ',
      'correctly configured role while proving nothing about your data. Nor does it ',
      'trust ', code('default_transaction_read_only'), ', which any client can undo with ',
      code('SET TRANSACTION READ WRITE'), '.'),

    h4('2. Postgres validates every function, not a regex'),
    p('Covered under ', b('What this service is'), '. The parser is the authority.'),

    h4('3. Nothing reaches live without approval'),
    p('And editing a live function returns it to draft.'),

    h4('Everything is audited'),
    p('Every call is recorded — successful, failed and refused alike — with the ',
      'parameters, the scopes that were applied, the row count and the latency. Search ',
      'terms are kept on purpose, since knowing what was asked for is most of the value, ',
      'but parameters named like credentials are masked and long strings truncated so a ',
      'prompt cannot smuggle a payload into a log line.'),
  ),

  database: () => frag(
    h3('database', 'The database it uses'),
    p('This service does not have a database. It uses yours, and creates its own tables ',
      'inside it. Every table it owns is named ', code('agent_*'), ' and lives in one ',
      'schema — ', code('ori'), ' by default, configurable with ', code('DATABASE_SCHEMA'),
      '. Nothing outside that prefix belongs to it.'),

    h4('Two connections, deliberately different'),
    table(['Variable', 'Used for', 'Privileges'], [
      [code('DATABASE_URL'), 'The agent\'s own agent_* tables', 'read/write'],
      [code('DATABASE_READ_URL'), 'Only for running registry functions', 'read-only, verified'],
    ]),

    h4('If it cannot create its tables'),
    p('Plenty of managed Postgres deployments hand out a login that can read and write ',
      'rows but not create objects. When that happens the setup screen gives you the ',
      'exact DDL to run as a role that can. It is pure DDL — no data — and once the ',
      'tables exist the service adopts them and records its own migration history on ',
      'the next check.'),
    p('Note that ', code('CREATE TABLE IF NOT EXISTS'), ' checks permissions ',
      b('before'), ' existence, so a restricted role fails on it even when the table is ',
      'already there. That is why the service skips the DDL entirely in that case rather ',
      'than relying on it being a harmless no-op.'),
    p('The Database page shows both connections with their passwords stripped, the pool ',
      'state, the write-assertion result, and which of the ', code('agent_*'),
      ' tables exist. ', goto('Open the Database page', '#/database')),
  ),

  troubleshooting: () => frag(
    h3('troubleshooting', 'Troubleshooting'),

    h4('"I couldn\'t work out what you\'re asking"'),
    p('The planner matched nothing. Either no function is ', code('live'), ', or the ',
      'caller\'s role does not allow the one that fits, or the description does not ',
      'resemble what was asked. Check the Functions page for a live function, then the ',
      'role\'s allowed list.'),

    h4('The agent says the model is unreachable'),
    p('No model is enabled, or the endpoint is down. Open Models and use ',
      b('Check health'), '. ', goto('Models', '#/models')),

    h4('A function returns no rows in production but works in Try it'),
    p('Almost always scoping. Try it with the same role and the same scope values the ',
      'real caller sends. If it returns rows for an exempt role and nothing for a scoped ',
      'one, the scope column is pointing at the wrong column.'),

    h4('A function I wrote returns nothing at all'),
    p('Check what the read connection can actually see — it is a different role from the ',
      'one you use in psql, and it may not have been granted SELECT on the table. The ',
      'demo function lists exactly this. ', goto('Database page', '#/database')),

    h4('The service will not start'),
    p('It should not refuse to start for a configuration problem any more — those become ',
      'a setup screen at ', code('/admin'), '. If the process really does exit, the two ',
      'causes left are the port already being in use, and ',
      code('DB_ALLOW_WRITABLE_READ_POOL'), ' being set in production, which is refused ',
      'deliberately.'),

    h4('Everything looks right but nothing is live'),
    p('Functions save as drafts. Approve, then take live. Only live functions are visible ',
      'to the planner. ', goto('Functions', '#/functions')),

    h4('Known gaps'),
    ul(
      'Rate limiting and the registry, role and key caches are in-process. With N replicas the effective rate limit is N times the configured value, and a revoked key stays usable for up to 30 seconds on replicas that cached it.',
      'requiresConfirmation is stored but the two-turn confirm flow is not implemented.',
      'There is no tool retrieval — the whole permitted catalogue goes to the planner. Fine below about 30 functions, degrading past that.'),
  ),
};
