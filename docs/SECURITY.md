# Security model

What this service is built around, why, and how to check a change has not broken
it.

The short version: **the LLM chooses a function and fills in its parameters.
Administrators write the functions. Postgres validates them. A read-only
connection runs them.**

---

## The constraints

| # | Constraint | Enforced by |
|---|---|---|
| 1 | The LLM never generates SQL | No code path passes model output to the driver. The planner's entire vocabulary is the function catalogue. |
| 2 | No value ever reaches query text | The template language has no syntax that produces one. `test/security/sql-template.spec.ts` and `test/security/no-sql-interpolation.spec.ts`. |
| 3 | Registry functions run on a connection that cannot write | `ReadDb.runWriteAssertion` asks Postgres for the role's actual write privileges, and the pool is only created if it holds none. |
| 4 | Writes go through the host application's API | The read connection is the only database path. Actions are HTTP calls to registered services. |
| 5 | Every call is scoped to the real end user | `compileSqlTemplate` binds the caller's scope values and throws rather than emitting an open filter. |
| 6 | Every call is audit-logged | `ExecutorService` audits every path, including refusals and validation failures. |
| 7 | Ambiguous lookups ask, they don't guess | `decideAmbiguity` returns `ambiguous`; the reflector short-circuits to a question and cannot be overridden. |
| 8 | Nothing reaches `live` without approval | `FunctionManagementService.setStatus`, and editing a live function returns it to draft. |

---

## Why a validator, not a sanitiser

An earlier version of this system let the LLM write SQL and guarded it with a
six-step regex pipeline: forbidden-pattern blocklist, table whitelist,
sensitive-column redaction, RBAC `WHERE` injection, row limit, post-transform
re-check.

It was careful work, and unfixable in that form, because a regex cannot parse
SQL. Three confirmed bypasses:

### 1. UNION bypass

RBAC injection inserted the condition before the first `GROUP BY | ORDER BY |
LIMIT | HAVING | UNION | INTERSECT | EXCEPT` keyword found:

```js
const insertBeforePattern = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|INTERSECT|EXCEPT)\b/i;
```

For `SELECT … FROM t UNION SELECT … FROM t`, only the first branch was scoped.

### 2. First-`WHERE` bypass

When the query already had a `WHERE`:

```js
sql = sql.replace(/\bWHERE\b/i, `WHERE ${qualifiedCondition} AND`);
```

`String.replace` with a non-global regex replaces the **first** match. If that
`WHERE` belonged to a subquery — a `SELECT` list, a `LATERAL`, an `EXISTS` — the
RBAC condition landed there and the outer query stayed unscoped.

### 3. `SELECT *` redaction bypass

Redaction only fired when a restricted column appeared textually between
`SELECT` and `FROM`:

```js
const selectRegex = new RegExp(`\\bSELECT\\b[^]*?\\b${col}\\b[^]*?\\bFROM\\b`, 'i');
```

`SELECT * FROM users` never names the column, so nothing was redacted.

### What this service does instead

Nothing here tries to understand SQL by pattern. Save-time validation
**compiles the template and hands the result to Postgres**:

- `LIMIT 0` execution — parses, plans, resolves every identifier, returns column
  metadata, reads no rows.
- `EXPLAIN` — produces the plan, which is shown to the author.

Both run inside a `READ ONLY` transaction, so anything that is not a read is
rejected by the server rather than by a keyword list. The parser is the
authority, which is the whole point.

`SELECT *` is banned outright, so there is no redaction step to bypass.

---

## The write assertion

`runWriteAssertion` runs before the read pool is created. It does two things, in
order:

1. If `pg_is_in_recovery()` is true the server is a standby and cannot accept a
   write at all — that is the strongest form of the guarantee, and it passes.
2. Otherwise it asks whether the role holds `INSERT`, `UPDATE`, `DELETE` or
   `TRUNCATE` on any table outside the system schemas, using
   `has_table_privilege`. Any hit means the pool is never created, and the
   tables are named in the log and on the console's Database page.

`has_table_privilege` is the right question because it resolves role
inheritance and grants made to `PUBLIC`, which is exactly where an unintended
privilege hides.

Two things it deliberately does **not** do:

- **It does not try `CREATE TEMP TABLE`.** Postgres grants `TEMP` on a database
  to `PUBLIC` by default, so a correctly configured read-only role creates temp
  tables happily. That probe would reject every valid deployment while proving
  nothing about user data. This was an early implementation and it was wrong.
- **It does not trust `default_transaction_read_only`.** That is a session
  default and any client can undo it with `SET TRANSACTION READ WRITE`. Useful
  as a seatbelt, worthless as a guarantee.

Holding `CREATE` on a schema is reported as a warning rather than a refusal: it
cannot alter existing data, but a read-only role has no business with it.

### Refusing the pool, not the process

A failed assertion used to call `process.exit(1)`. It now refuses to open the
pool instead. That is not a weakening, and the distinction is worth being
precise about:

- **What is unchanged:** no registry function can execute either way. Every path
  to the read connection goes through `requirePool()`, which throws with the
  reason. There is no code path that reaches the driver without it.
- **What is better:** the console comes up and says *which tables* the role can
  write and how to fix it. A process in a crash loop tells nobody anything, and
  on a first deployment it is the operator who most needs telling.

The one configuration that still stops the process is
`DB_ALLOW_WRITABLE_READ_POOL=true` in production — an operator explicitly
disabling the guard where there is real data to lose.

---

## The setup endpoints

`/admin/api/setup` answers without authentication, because before the first
operator account exists there is nobody to authenticate. What each route can do
is bounded rather than trusted:

| Route | What it can do |
|---|---|
| `GET /setup` | Report stage names, the agent's own table names, and the DDL that creates them. All public knowledge. |
| `POST /setup/check` | Reconnect and report again. Floored to one call every two seconds, because it tears down and rebuilds two pools. |
| `POST /setup/admin` | Create the first account. A single conditional `INSERT … WHERE NOT EXISTS` refuses the moment one exists, so two concurrent submissions cannot both win. |

The one genuinely sensitive field is the raw driver message, which can name a
host, a port or a user. It is attached **only while no operator account
exists** — exactly the window in which there is nothing yet to protect. After
that the same detail is one sign-in away on the Database page.

Note that the account guard depends on the database being reachable. If it is
not, the conditional insert fails and no account can be created — the endpoint
cannot be used to seize a deployment whose database has gone away.

---

## The template language

Two tokens, and nothing else:

```
{{param:name}}   →  $n, bound to a validated parameter
{{scope:key}}    →  column = $n, bound to the caller's scope value
```

Rejected at save time: raw `$1` (the engine assigns numbers), `${…}`, any other
`{{…}}` token, a second statement, anything that is not `SELECT`/`WITH`, and
`SELECT *`.

**An author has no way to express interpolation.** That is the property that
matters — not that interpolation is filtered, but that it cannot be written.

Row bounds are applied by the engine, not the author:

```sql
SELECT ori_result.*, COUNT(*) OVER () AS ori_total
FROM ( <the author's query> ) AS ori_result
LIMIT $n OFFSET $n
```

so a function cannot ship without a limit, and paged results know their true
total for free.

---

## Scope binding fails closed

`compileSqlTemplate` resolves `{{scope:key}}` three ways:

| Situation | Result |
|---|---|
| Caller supplied a value | `column = $n`, bound |
| Caller's role lists the key in `unscopedKeys` | `TRUE` |
| Neither | **throws** |

The third case is the one that matters. A scope we cannot bind must never
quietly become an unfiltered query. Exemption is stored on the role, explicit,
and visible in the console — it is never the consequence of a missing value.

The validator also refuses to save a function that *declares* a scope filter but
never applies it in the SQL: a function that looks protected and is not is worse
than one that obviously is not.

---

## Authentication

### API keys

Authenticate the calling **application**, not a person. Stored as a clear prefix
(for lookup and display) plus a SHA-256 of the full secret, compared in constant
time. SHA-256 rather than a slow KDF is deliberate: these are 192 bits of
machine-generated randomness, so there is no dictionary to defend against, and
key checks sit on the hot path.

Scopes: `chat`, `manage`, `trace`. `trace` gates the internal event channel.

### End users

Per application, one of:

**`jwt`** — the application forwards the end user's token, verified against that
application's issuer and JWKS via `jose`. Identity is proven; role and scopes are
read from configured claims.

**`asserted`** — the application states who the user is in an `X-End-User`
header, believed because the API key authenticated the channel.

`asserted` is a genuine reduction in guarantee. Stated plainly: **the trust
boundary becomes the API key**, so a chat key that reaches a browser is an
impersonation primitive for every user of that application. Use `jwt` where the
host can issue verifiable tokens; keep `asserted` keys server-side.

What neither mode has is a fallback. There is no anonymous path, no default
role, and no `UserContext` constructible without authentication. An unknown role
is refused rather than defaulted — a typo in a host application's role name must
not silently grant or deny access.

---

## HTTP actions

Write functions call the host application's API. The target is a **registered
service name**, never a URL from the function body.

That matters because a saved function is data. If it could name its own host,
anyone who could author a function could make the service issue requests to
internal addresses — cloud metadata endpoints, internal admin panels. Resolving
through a per-application service registry means the reachable set is
configuration an operator controls.

Also enforced (`test/security/http-action.spec.ts`):

- Path parameters are URL-encoded, so a value cannot add a path segment or a
  query string.
- The resolved URL is checked against the registered origin.
- Redirects are not followed — another way to reach an unregistered origin.
- `Authorization` and `Cookie` headers in a stored function body are dropped;
  the engine sets `Authorization` from the end user's token when the action asks
  for it.
- A failed write is **never** marked retryable. Without an idempotency guarantee
  from the target, an automatic retry after a timeout can duplicate the change.

---

## Secrets

- **Model provider credentials**: AES-256-GCM with `ENCRYPTION_KEY`, never
  returned by any API or shown in the console. A credential that cannot be
  decrypted logs once and is treated as absent rather than failing every request.
- **Console passwords**: scrypt (node's own crypto — no native module), salted
  per account. Changing a password invalidates every existing session.
- **Console sessions**: opaque tokens in an HttpOnly cookie, stored hashed. A
  dump of the sessions table does not let anyone log in.
- **Logs**: `authorization`, `x-api-key`, `x-end-user-token`, `x-end-user`,
  `cookie`, `set-cookie`, message bodies and passwords are stripped by pino
  redaction.
- **Audit**: search terms *are* recorded — knowing what was asked for is most of
  the value — but parameters named like credentials are masked and long strings
  truncated, so a prompt cannot smuggle a payload into a log line.

---

## The console

Served from a fixed map of filenames rather than a path resolved from the
request, so directory traversal is not something it can do. `X-Frame-Options:
DENY` and a CSP of `default-src 'none'` with `'self'` for script, style and
connect — it loads nothing from anywhere else, which also means it works when
the network does not. There is no inline script: the theme bootstrap is its own
file precisely so the CSP needs no hash to keep in sync.

Local accounts rather than SSO, deliberately: the console is most useful when
something is broken, and that is exactly when a dependency on another system
being up is worst.

---

## Review checklist

Before merging anything that touches data access or authentication:

- [ ] `npm test` passes, including `test/security/`.
- [ ] No new entry in `ALLOWED_FRAGMENTS` in `no-sql-interpolation.spec.ts`. If
      you added one, justify it in review — the alternative is binding the value.
- [ ] No new path constructs a `RequestContext` outside `ApiKeyGuard`.
- [ ] No new code path reaches the read connection except through
      `SqlFunctionRunner`, and none bypasses `ReadDb.requirePool()`.
- [ ] Nothing new was added to the unauthenticated setup response. Anything that
      names a host, a user or a credential belongs behind a session.
- [ ] Any new outbound HTTP resolves through the service registry.
- [ ] New engine queries use explicit column lists.
- [ ] Scope handling still throws rather than defaulting to open.
- [ ] Anything new that a function author controls is validated at save time,
      not at execution time.

---

## Known gaps

Stated rather than left to be discovered:

- **Rate limiting, the API key cache, the role cache and the registry cache are
  in-process.** With N replicas the effective rate limit is N × the configured
  value, and a revoked key stays usable for up to 30 seconds on replicas that
  cached it. Move to Redis before scaling out.
- **`requiresConfirmation` is stored and surfaced but not enforced.** The
  two-turn confirm flow is not implemented, so a destructive action marked with
  it will still execute on the first call. Do not rely on the flag yet.
- **No tool retrieval.** The full permitted catalogue goes to the planner. Fine
  below ~30 functions, degrading past that.
- **Console sessions are not rotated on privilege change** — a role change takes
  effect on the next request, but an existing session keeps its cookie until
  expiry or a password change.
- **Nothing has run against a production database.**
