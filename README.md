# Ori Agent Service

A standalone agentic LLM service that any application can put in front of its
Postgres database. It answers questions about live data and performs actions on
it — but only through hand-authored, parameterized functions that an
administrator writes and approves.

**The one thing to understand before reading any code:** the LLM's job is to
pick a function and fill in its parameters. It does not write queries, it never
sees the schema, and it has no path to the database.

The service is product-agnostic. Nothing in it names a domain concept: roles,
scopes, functions and models are all rows in tables, edited through a console
or a management API.

---

## What you get

- **One chat endpoint**, with streaming — every step of the agent's reasoning is
  available as Server-Sent Events.
- **A function registry in your database.** Administrators author parameterized
  SQL (reads) and declarative HTTP calls (writes) through a web console.
  Postgres itself validates every function before it can be saved.
- **An operator console** at `/admin`: live activity, run traces, conversation
  transcripts, the function editor, model management, connection diagnostics,
  API keys, audit log — and a guide covering all of it. Works on a phone.
- **Guided setup.** A missing variable, an unreachable database or a role that
  may not create tables produces a setup screen that says which step is
  outstanding and how to fix it, not a process that exits.
- **An API reference** at `/docs`, generated from the code and self-hosted.
- **Multi-tenant.** One deployment serves many applications; nothing crosses
  between them.
- **Ambiguity that asks instead of guessing.** When a lookup could mean several
  records, the agent returns a clarifying question and remembers the answer.
- **A knowledge base.** Upload PDFs, Word files, text or pasted notes describing
  what the application *is*. They help the agent pick the right function,
  explain what a result means, and answer questions no function covers — with
  per-role visibility and hybrid retrieval.
- **Feedback that lands next to the evidence.** A thumbs down is recorded with
  the question, the answer, and every function call the executor actually made.

## It has no database of its own

You point it at a Postgres you already run. It creates its own tables inside it,
every one named `agent_*`, in one schema (`ori` by default). Nothing it creates
touches a table that was already there, and which tables belong to the agent is
obvious from the name alone.

If the connected role may not create tables — common on managed Postgres — the
setup screen hands you the exact DDL to give to whoever can, then adopts the
schema once it exists.

---

## How a request flows

```
POST /v1/chat/stream          X-Api-Key + end-user identity
  │
  ├─ ApiKeyGuard ──────── authenticate the application, resolve the end user
  ├─ Router ───────────── read | write | conversational | clarification-reply
  ├─ Registry ─────────── the live functions this role may call
  ├─ Retrieval ────────── knowledge passages this role may see
  │
  ├─ Agent loop ───────── up to N times:
  │    ├─ model picks one function (native tool call) — or declines
  │    ├─ Executor: validate → check RBAC → bind scopes → run → audit
  │    └─ model reads the result and decides what is next
  │
  ├─ Reflector ────────── ambiguous? stop and ask. otherwise answer.
  └─ Synthesizer (LLM) ── stream the answer, or the clarifying question
```

The loop is the part worth understanding. The model chooses **one** function,
sees what it returned, and then chooses again — so a request like "generate the
report for Priya", where the second call needs an id the first call produces,
is something it observes rather than something it has to predict. It is also
free to call nothing at all: `tool_choice` is always `auto`, which makes "no
function here fits that" an answer the model can give instead of picking the
closest match and filling in a blank parameter.

A call rejected by the parameter validator is a turn, not a failure. The
validator's complaint goes back to the model, which usually corrects it on the
next step. The user never sees that complaint — see *Two audiences* below.

Two database connections, deliberately different:

| Connection | Used for | Privileges |
|---|---|---|
| `DATABASE_URL` | The agent's own `agent_*` tables — registry, conversations, audit, keys | read/write |
| `DATABASE_READ_URL` | **Only** for running registry functions | read-only, proven before the pool opens |

---

## Quick start

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `DATABASE_READ_URL` and `ENCRYPTION_KEY`. Generate the
key with:

```bash
openssl rand -base64 32
```

Create the read-only role (once, as a database owner):

```bash
psql "$DATABASE_URL" -c "CREATE ROLE ori_reader LOGIN PASSWORD 'choose-one'; GRANT CONNECT ON DATABASE yourdb TO ori_reader; GRANT USAGE ON SCHEMA public TO ori_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ori_reader; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ori_reader;"
```

Then:

```bash
npm install && npm run start:dev
```

Open `http://localhost:3200/admin`. If anything above is missing or wrong you
get a setup screen naming the step and the fix, with a button that re-checks in
place — no restart, no reading the log. It walks through the database
connection, the agent tables, the read-only role, and creating the first
operator account.

Once you are in:

1. **Create an application** — your product. Choose how it identifies end users.
   It arrives with a live `demo` function so there is something to test against
   immediately.
2. **Define roles** — which functions each role may call, and which data scopes
   it is exempt from.
3. **Add a model** — any OpenAI-compatible endpoint (vLLM, or a hosted API).
   **Test connection** before saving; an unreachable model is otherwise only
   noticed by the next real chat request.
4. **Write a function.** Validate, **Try it** as any role, approve, take it live.
5. **Issue an API key** and call `/v1/chat`.

The **Guide** in the console covers all of this end to end, with worked
examples. It ships with the console rather than linking out, because the console
is what you open when the network is misbehaving.

The **Database** tab shows both connections, their pool state, which `agent_*`
tables exist, and whether the read connection has been proven unable to write —
passwords are never rendered.

If `DATABASE_READ_URL` can write, the read pool is never opened and no registry
function can run. That is intentional — see *Why that matters* below.

---

## Calling the agent

```bash
curl -N http://localhost:3200/v1/chat/stream \
  -H "X-Api-Key: ori_xxx.yyy" \
  -H 'X-End-User: {"id":"4821","role":"support","scopes":{"org_id":42}}' \
  -H "Content-Type: application/json" \
  -d '{"message":"what is the status of order 10023?","trace":true}'
```

Events arrive as they happen:

```
event: run.started        {"runId":"…","conversationId":"…"}
event: router.decision    {"intent":"read"}                    ← trace only
event: plan.created       {"calls":[{"name":"get_order",…}]}   ← trace only
event: function.started   {"name":"get_order"}                 ← trace only
event: function.completed {"name":"get_order","status":"single","rowCount":1}
event: message.delta      {"text":"Order 10023 "}
event: message.delta      {"text":"shipped on 12 July"}
event: run.completed      {"responseType":"answer",…}
```

`POST /v1/chat` is the same run without the stream, returning the finished
response.

**Trace events name functions and echo extracted parameters.** They are sent
only when the API key carries the `trace` scope *and* the request asks for them.
An end-user surface should use a key without that scope.

---

## Writing a function

Functions are written in the console. A read function is parameterized SQL in a
small template language:

```sql
SELECT o.id                AS id,
       o.reference         AS label,
       o.status || ' · ' || to_char(o.placed_at, 'DD Mon') AS detail,
       CASE WHEN o.reference = {{param:reference}} THEN 100 ELSE 60 END AS match_score,
       o.status, o.total_amount, o.placed_at
  FROM orders o
 WHERE o.reference ILIKE '%' || {{param:reference}} || '%'
   AND {{scope:org_id}}
```

Two tokens exist, and nothing else:

- `{{param:name}}` compiles to a bound `$n` placeholder
- `{{scope:key}}` compiles to `column = $n`, bound to the caller's scope value

A raw `$1` is rejected. `${…}` is rejected. String concatenation of a value is
not expressible. `LIMIT` is added by the engine, so a function cannot ship
without one.

When you save, the service compiles the template and hands it to **Postgres** —
`LIMIT 0` to read the output column names, `EXPLAIN` to get the query plan. You
see the plan in the editor, so "is it index-backed" is answered at authoring
time rather than being a checklist item nobody runs.

Full guide: [docs/FUNCTION_AUTHORING.md](./docs/FUNCTION_AUTHORING.md).

---

## Why that matters

Registry SQL is authored by a human, but it is stored as **data**, and data is
not reviewed code. Three things contain it:

1. **The read connection cannot write.** Checked before the pool is opened: the
   service asks Postgres whether that role holds any write privilege on any
   table, and if it does the pool is never created — so no registry function can
   run at all, and the console says which tables are writable. (It does *not*
   test by creating a temp table — Postgres grants `TEMP` to `PUBLIC`, so that
   probe rejects every correctly configured role while proving nothing about
   your data.)
2. **Postgres validates every function before it saves** — not a regex. The
   predecessor to this service tried to police LLM-generated SQL with a
   six-step regex pipeline and had three confirmed bypasses, all of them
   because a regex cannot parse SQL.
3. **Nothing reaches `live` without explicit approval**, and editing a live
   function returns it to draft — an approval covers the version that was read.

[docs/SECURITY.md](./docs/SECURITY.md) has the detail, including the bypass
history and the review checklist.

---

## The knowledge base

Functions tell the agent what it can *look up*. They say nothing about what any
of it means — what a "level" is, how credits are consumed, what a band on a
score signifies. Documents fill that in.

Upload them under **Knowledge** in the console: PDF, Word (`.docx`), text,
Markdown, CSV, or pasted straight in. Each document declares which roles may
retrieve it, in the same shape as a function's `allowedRoles`, and the filter is
applied in SQL before ranking — a document a role may not see cannot influence
what that role gets back.

They are used in four places, and the framing differs in each because the risk
does:

| Where | What it does | The rule |
|---|---|---|
| Choosing a function | Maps the user's words onto the right function | Background only. Never a fact. |
| Writing an answer | Explains what a returned number means | Live results always win |
| No function fits | Answers from the documentation, with `[1]` citations | Must say when the docs do not cover it |
| "What can you do" | Describes the product, not a list of functions | Only what is configured |

The first row is the one to be careful about: a model handed documentation while
it is choosing a function will otherwise answer *from* the documentation, and
report a balance it read in a worked example. The grounding block says
explicitly that it is documentation and not data.

### Retrieval

Hybrid, because the two halves fail on opposite inputs. Postgres full-text
search is exact and cannot match "how much does it cost" against a section
headed "Pricing"; vector search does that and will confidently return something
adjacent when the user typed a product code. Both run, and the ranks are fused
with Reciprocal Rank Fusion — ordering only, never raw scores, which are not on
comparable scales.

The vector half is **optional**:

- **No embedding model configured** → lexical search only. Works out of the box,
  weaker on paraphrase. The Knowledge page says so in a banner rather than
  leaving you guessing.
- **An embedding model configured** → hybrid. Add one on the Models page with
  purpose `embedding`. It is a separate purpose because it is a separate API
  shape, and because the provider running your chat models often cannot embed at
  all — Groq, for instance, hosts no embedding model, so a deployment planning
  on Groq points this at OpenAI, Jina, a local Ollama, or anything else speaking
  `/v1/embeddings`.
- **pgvector present** → distances are computed in Postgres. Detected at
  migration time; without it the same vectors live in a `REAL[]` column and are
  compared in the service, which is fine into the low thousands of passages.

Adding an embedding model after uploading documents does not mean uploading them
again — the extracted text is kept, and **Re-index all** rebuilds from it.

---

## Feedback

```
POST /v1/chat/feedback
{"rating":"down","runId":"…","assistantMessageId":270,"comment":"wrong programme"}
```

Any client can call it — the playground does, and so should your application.
Send the `runId` and `assistantMessageId` from the response being rated; rating
the same turn again replaces the previous verdict rather than adding a second.

Only identifiers are accepted. The question, the answer and the functions used
are read back out of the agent's own tables, and the per-call detail — every
function, its parameters, the scopes bound to it, its result and its timing —
comes from `agent_audit_log`, written by the executor as it ran. A client cannot
describe a run differently from how it happened.

**Feedback** in the console is the queue. A dislike stays in it until someone
marks it reviewed, and opening one shows the exchange beside what actually ran —
which is usually enough to see that a function's description sent the model
somewhere it should not have gone.

---

## Two audiences, two vocabularies

A failed call produces two different sentences, and keeping them apart is what
stopped `find_user needs at least one of: email, userid.` from being shown to
end users:

- `result.message` is user-facing and deliberately vague.
- `operatorDetail` is the specific one. It goes to the audit row, the trace
  channel, and the agent loop — which can only correct a mistake it is told the
  shape of. It never reaches the user.

The same split governs what the model sees. Inside the loop it reads
*observations*, which carry mechanical detail so it can retry properly. The
synthesizer reads *evidence*, which is humanised and stripped of ids and failure
mechanics, because whatever it sees it may repeat.

---

## End-user identity

Configured per application:

| Mode | How | Guarantee |
|---|---|---|
| `jwt` | The application forwards the end user's token; the agent verifies it against that application's JWKS | Identity is proven |
| `asserted` | The application states who the user is in an `X-End-User` header | Trust boundary is the API key |

`asserted` is a real reduction and worth naming precisely: an API key that
reaches a browser becomes an impersonation primitive for every user of that
application. Keep chat keys server-side.

Neither mode has a fallback. There is no anonymous path and no default role — an
unresolvable caller gets a 401.

---

## Scopes

A scope is a key an application chose (`org_id`, `tenant`, `owner_id`), a value
the caller supplies, and a column a function binds it to.

- A role **exempt** from a key sees every value of it.
- A role that is **not** exempt must supply one, or every function declaring
  that scope is refused.

A scope that cannot be bound is never silently dropped. That is the single most
important line in the codebase, and it is
[tested](./test/security/sql-template.spec.ts).

---

## Repository layout

```
src/
  admin/          operator console API, sessions, observability
  api/            chat controller (JSON + SSE), health
  auth/           API keys, end-user resolution, roles, rate limiting
  common/         crypto, request ids, maintenance
  config/         typed configuration, boot validation
  db/             primary + read-only connections, migrations
  llm/            model registry, streaming provider, failover
  management/     function/application management services + API
  memory/         conversations, pending disambiguation
  feedback/       ratings, joined to the run that produced them
  knowledge/      documents, extraction, chunking, embeddings, hybrid retrieval
  orchestrator/   router, agent loop, executor, reflector, synthesizer
  registry/       function contract, SQL template engine, runners, validator
  setup/          onboarding: stage detection, manual DDL, first account
  audit/          per-call audit records
public/           the console — plain modules, no build step, no CDN
  index.html      shell
  styles.css      tokens and components
  ui.js           DOM helpers and the component vocabulary
  app.js          API client, hash router, sidebar shell
  views.js        activity, functions, roles, models, applications, database
  function-editor.js   the authoring page
  knowledge.js    document upload, visibility, re-indexing
  feedback.js     the review queue for rated answers
  setup.js        the onboarding wizard
  guide.js        the in-app manual
test/             unit, security, eval
docs/             SECURITY, FUNCTION_AUTHORING, PORT_AUDIT
```

---

## Commands

```bash
npm run start:dev    # watch mode
npm test             # 470 tests, no network, no database
npm run typecheck
npm run lint
npm run build
```

---

## Status

Working end to end: tenancy, API keys, both identity modes, data-driven roles,
the DB-backed registry with save-time validation, SQL and HTTP function
execution, scope binding, disambiguation, streaming chat, audit, the management
API, the console, the agent loop with native tool-calling, and the knowledge
base with hybrid retrieval.

Not built yet:

- **Tool retrieval at scale.** Below ~30 functions the whole catalogue goes to
  the model as tools, which is correct and simpler. Past that it needs an
  embedding shortlist — the machinery for one now exists in `knowledge/`, but it
  is not wired to the catalogue.
- **An ANN index on the knowledge vectors.** pgvector, when present, computes
  distances in the database but without an HNSW index, because the index needs a
  fixed dimension and the dimension belongs to whichever embedding model the
  operator chose. Sequential distance is fine into the low tens of thousands of
  passages.
- **Confirmation-before-execution.** `requiresConfirmation` is stored and
  surfaced but the two-turn confirm flow is not implemented, so mark
  destructive actions carefully until it is. The loop makes this more pressing,
  not less: it can now reach a write action in the same turn as the lookup that
  found its target.
- **Ingestion is synchronous.** A document is extracted, chunked and embedded
  inside the request that uploaded it. Right for one file at a time and an
  operator watching the screen; wrong for a bulk import, which needs a queue.
- **Redis-backed rate limiting and caches.** Both are in-process, so limits are
  per-replica. Fix before scaling out.

Nothing has run against a production database yet. The first thing you will
exercise is the read-connection write assertion, which is designed to refuse to
open the connection on the wrong credentials.
