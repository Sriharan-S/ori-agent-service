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
  ├─ Planner (LLM) ────── choose 1-3 functions, extract parameters
  ├─ Executor ─────────── validate → check RBAC → bind scopes → run → audit
  ├─ Reflector ────────── ambiguous? stop and ask. otherwise answer.
  └─ Synthesizer (LLM) ── stream the answer, or the clarifying question
```

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
  orchestrator/   router, planner, executor, reflector, synthesizer
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
  setup.js        the onboarding wizard
  guide.js        the in-app manual
test/             unit, security, eval
docs/             SECURITY, FUNCTION_AUTHORING, PORT_AUDIT
```

---

## Commands

```bash
npm run start:dev    # watch mode
npm test             # 231 tests, no network, no database
npm run typecheck
npm run lint
npm run build
```

---

## Status

Working end to end: tenancy, API keys, both identity modes, data-driven roles,
the DB-backed registry with save-time validation, SQL and HTTP function
execution, scope binding, disambiguation, streaming chat, audit, the management
API, and the console.

Not built yet:

- **Tool retrieval at scale.** Below ~30 functions the full catalogue goes to
  the planner, which is correct and simpler. Past that it needs an embedding
  shortlist.
- **Confirmation-before-execution.** `requiresConfirmation` is stored and
  surfaced but the two-turn confirm flow is not implemented, so mark
  destructive actions carefully until it is.
- **Redis-backed rate limiting and caches.** Both are in-process, so limits are
  per-replica. Fix before scaling out.

Nothing has run against a production database yet. The first thing you will
exercise is the read-connection write assertion, which is designed to refuse to
open the connection on the wrong credentials.
