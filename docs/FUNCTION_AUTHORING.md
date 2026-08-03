# Writing a registry function

Everything the agent can do is a function in the registry. This is the document
that keeps the architecture intact as more get added.

Read [SECURITY.md](./SECURITY.md) first if you have not. The rules below are not
style preferences.

---

## The shape

Two halves, deliberately separate:

- **The definition** is what the planner LLM sees: a name, a description, when
  to use it, and a parameter schema. It contains no table name, no column, and
  nothing about how the work is done.
- **The body** is what runs — parameterized SQL for a read, a declarative HTTP
  call for a write. The LLM never sees it.

Functions are written in the console at `/admin` → **Functions**, or through
`POST /v1/manage/functions`.

---

## Steps

### 1. Pick the kind

| Kind | `returns` | Disambiguates? | Body |
|---|---|---|---|
| **Lookup** | `single-or-ambiguous` | Yes | SQL |
| **List / report** | `list` | No | SQL |
| **Single fact** | `single` | No | SQL |
| **Action** | `confirmation` | No — takes a resolved id | HTTP |

### 2. Write the description

Retrieval quality depends far more on descriptions than on the retrieval
algorithm. Two functions both described as "get user info" collide in vector
space no matter how good the retriever is — and the console will warn you when a
new description reads too close to an existing one.

- Describe **what it returns and when to use it**, not how it works.
- **Name the exact identifiers it accepts.** "Accepts an order reference, a
  customer email, or a numeric order id" beats "finds an order".
- Fill in `whenNotToUse` pointing at the neighbouring function whenever two are
  plausibly confusable. Do it in *both* directions.

Good:

> Returns one order: its reference, current status, total, the date it was
> placed, and the customer it belongs to. Accepts an order reference, a numeric
> order id, or a customer email. When several orders match it returns them as
> choices rather than picking one.

Bad:

> Gets order data.

### 3. Declare parameters

JSON, in the editor:

```json
{
  "reference": {
    "type": "string",
    "description": "Order reference, full or partial.",
    "minLength": 3,
    "maxLength": 40
  },
  "orderId": {
    "type": "integer",
    "description": "Numeric order id, if known.",
    "min": 1
  }
}
```

- `requiredOneOf: [["reference", "orderId"]]` for "any one of these identifies
  the record".
- `required: true` for "always needed".
- `enum` for closed sets — the validator rejects anything outside it, and the
  planner sees the allowed values.
- `default` for optional knobs.
- **`resolvedIdentifier: true`** on action-function id parameters (see §6).

Unknown parameters are **rejected, not dropped**. A planner inventing one has
misunderstood the function, and running the call anyway would execute something
the model did not intend.

### 4. Write the SQL

Two tokens exist:

```sql
SELECT o.id                          AS id,
       o.reference                   AS label,
       o.status || ' · ' || o.total  AS detail,
       CASE
         WHEN o.reference = {{param:reference}} THEN 100
         WHEN o.reference ILIKE {{param:reference}} || '%' THEN 90
         ELSE 60
       END                           AS match_score,
       o.status, o.total, o.placed_at
  FROM orders o
 WHERE o.reference ILIKE '%' || {{param:reference}} || '%'
   AND {{scope:org_id}}
```

- `{{param:name}}` → a bound `$n` placeholder.
- `{{scope:key}}` → `column = $n` bound to the caller's scope value, or `TRUE`
  if their role is exempt.

Everything else is literal SQL. **A raw `$1` is rejected**, `${…}` is rejected,
and there is no syntax that puts a value into the query text.

Rules the validator enforces:

- One statement, starting with `SELECT` or `WITH`.
- No `SELECT *`, including `SELECT r.*`. A column you do not name is a column
  that cannot leak.
- Every `{{param:…}}` must be declared, and every declared scope filter must
  appear as a `{{scope:…}}` token. A declared-but-unapplied scope is refused —
  it reads as protected and is not.
- **You do not write `LIMIT`.** The engine wraps your query and adds it, along
  with the unpaged total, so a function cannot ship unbounded.

### 5. Lookups need four columns

A `single-or-ambiguous` function must return:

| Column | Required | Purpose |
|---|---|---|
| `id` | yes | The value written back when the user picks this record |
| `label` | yes | What the user reads in the choice list |
| `detail` | no | Extra context that tells two similar records apart |
| `match_score` | strongly advised | 0-100. Drives the ambiguity decision |

Checked against real result metadata when you save.

Without `match_score` every row scores 100, so any multi-row result ties and
always asks. That is the safe direction to fail in, but it is not a good
experience — write a scoring expression for anything doing fuzzy matching.

Set `ambiguityResolvesTo` to the parameter a chosen `id` goes into. The registry
refuses to save a lookup without it — you cannot ask a question you could not
act on the answer to.

### 6. Actions take resolved identifiers only

An action accepts an id, never a name. The agent resolves identity with a lookup
first, then acts.

```json
{
  "service": "core",
  "method": "PATCH",
  "path": "/orders/{{param:orderId}}",
  "body": { "status": "{{param:newStatus}}" },
  "forwardEndUserToken": true,
  "idempotent": true
}
```

with:

```json
{
  "orderId": {
    "type": "integer",
    "description": "Numeric order id, from a prior lookup.",
    "required": true,
    "resolvedIdentifier": true
  },
  "newStatus": {
    "type": "string",
    "description": "The status to set.",
    "required": true,
    "enum": ["CONFIRMED", "CANCELLED"]
  }
}
```

This keeps every action simple and auditable, keeps all "which one did you mean"
logic in one place, and produces a clean two-step audit trail: *looked up X* →
*changed Y on X*.

`service` must be registered for the application. An action cannot name a host —
see [SECURITY.md](./SECURITY.md#http-actions).

### 6a. Acting on the caller's own record

Not every action has an id to be handed. "Generate *my* report" has no lookup
step — the identity is the caller's, and demanding it as a parameter would mean
accepting a user id the agent would have to trust.

For that, a path or body may use `{{scope:key}}`:

```json
{
  "service": "reports",
  "method": "GET",
  "path": "/report/generate/student/{{scope:user_id}}"
}
```

The value comes from the caller's proven scope, never from the model. Two rules
follow from that, and both fail closed:

- **No value, no call.** A caller whose role is not exempt and who supplied no
  value for the key is refused before anything leaves the process.
- **An exempt role is refused too.** Exemption means "sees every value of this
  key". That is a coherent thing to say about a filter and a meaningless one
  about an identifier an action must act *on* — there is no "every user" to put
  in a URL. Compiling it away would send an empty path segment and quietly
  address the wrong resource, so it is a refusal instead.

An action satisfies the "never act on a name" rule with either a
`resolvedIdentifier` parameter or a scope binding. It needs one of the two.

### 6b. Proving the target is in scope

A read function carries its tenant filter in its own `WHERE` clause. An action
cannot: it is an HTTP call, and the filtering happens on the other side. Left
there, the agent is *asserting* the tenant and trusting the target API to check
it.

A `precondition` closes that. It is a read that must return a row before the
call goes out:

```json
{
  "service": "reports",
  "method": "GET",
  "path": "/report/generate/student/{{param:user_id}}",
  "precondition": {
    "sqlTemplate": "SELECT 1 FROM registrations r WHERE r.user_id = {{param:user_id}} AND {{scope:corporate_account_id}}",
    "denyMessage": "That candidate is not in your account."
  }
}
```

It is compiled by the same template engine as every read function, against the
same declared `scopeFilters`, and runs on the same read-only connection. So a
scope that cannot be bound refuses the action exactly as it refuses a query, and
an exempt role compiles the filter to `TRUE` and passes.

Three ways it stops: the scope will not bind, the query returns no row, or the
query fails to run. All three refuse. A guard that could not run has not passed.

### 6c. Waiting for a background job

Some APIs accept work and finish it later, handing back a job reference. Without
help, the agent can only report that reference — which is not what anyone asked
for.

A `poll` block makes the agent follow the job:

```json
{
  "poll": {
    "urlFrom": "statusUrl",
    "statusField": "status",
    "successWhen": ["COMPLETED"],
    "failureWhen": ["ERROR"],
    "intervalMs": 2000,
    "maxAttempts": 30
  }
}
```

`urlFrom` names the field in the first response holding the follow-up URL. Use
`path` instead when the host returns only an id — it templates with
`{{result:field}}`.

**The follow-up URL is re-pinned to the registered service.** It arrives in a
response body, which makes it attacker-adjacent input: a host that can be made
to echo a URL would otherwise become a request-forgery primitive. A follow-up
that resolves anywhere but the registered origin is refused, not followed.

Two bounds apply on top of the function's own: `OUTBOUND_POLL_MIN_INTERVAL_MS`
floors the interval, and `OUTBOUND_POLL_MAX_MS` caps the total wait. A job that
outlives the cap is reported as still being prepared — which is true, and more
useful than an error the host never gave.

### 6d. Handing back a link

A URL cannot survive being described. A model asked to repeat a long signed link
will eventually get a character wrong, and a humanised value is no longer the
value.

So declared results bypass the model entirely:

```json
{
  "result": {
    "link": { "from": "downloadUrl", "label": "Download report" },
    "expose": [{ "from": "password", "label": "Password" }]
  }
}
```

The model is told an artifact is coming — so the sentence it writes makes room
for it — and is never shown the value. The link is appended to the answer
verbatim and emitted as its own `artifact` event, so a client can render a
button instead of parsing prose.

Links are rebuilt against the service's **public base URL**, set on the
Applications page. The address the agent calls is often not one a browser can
open; without this, an action would hand out a link to an internal host.

`expose` hands a value over literally. It never reaches a prompt, but everyone
who can call the function will see it — declare one field at a time, and only
what the answer genuinely needs.

### 7. Validate, approve, go live

**Validate** compiles your template and asks Postgres. You get back:

- errors and warnings
- the output column names
- **the query plan** — a sequential scan is flagged as a warning

**Save** stores it as a draft. A draft is invisible to the planner and cannot
execute.

**Approve** → **Go live**. Live functions are re-validated on the way, because a
function approved last week may not still plan — the tables it reads can change
underneath it.

Editing a live function returns it to draft. An approval covers the version that
was read, not whatever replaced it.

**Disable** is the kill switch for something misbehaving. One click, effective
within the registry cache TTL.

---

## Checklist

- [ ] Description says what it returns and names the identifiers it accepts
- [ ] `whenNotToUse` points at every plausibly confusable neighbour, both ways
- [ ] The console shows no similarity warning against an existing function
- [ ] Every value is a `{{param:…}}`; no raw `$n`, no concatenated value
- [ ] Every declared scope filter appears in the SQL
- [ ] Explicit column list; no sensitive columns selected
- [ ] Validation passes and the plan looks sane — no unexpected sequential scan
- [ ] Lookups return `id` and `label`, score with `match_score`, and declare
      `ambiguityResolvesTo`
- [ ] Actions take `resolvedIdentifier` parameters and declare a write scope
- [ ] The roles that need it are listed in `allowedRoles`
- [ ] Added to the eval set in `test/eval/questions.json`

---

## Things that look reasonable and are not

**"I'll add a `tableName` parameter so one function covers several tables."**
That is text-to-SQL wearing a costume. Write separate functions.

**"I'll take the scope value as a normal parameter."**
Then the planner supplies it, which means the LLM decides which organisation's
data to read. Scope values come from the caller's identity, never from a
parameter.

**"There's only ever one match, so I don't need `match_score`."**
Then it returns `single` and costs you nothing. When that assumption breaks —
and for anything name-shaped it will — the machinery is already there.

**"I'll return the top match and mention the others in the answer."**
That is guessing with a disclaimer. Return the candidates and let the user
choose.

**"I'll grant the role `unscopedKeys` so it stops being refused."**
That role now sees every tenant's data. Sometimes that is exactly right, for an
internal support role. Make sure it is a decision and not a workaround.
