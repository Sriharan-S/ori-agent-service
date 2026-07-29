# Running it locally

A demo stack is already set up on this machine. This is how to drive it, and how
to rebuild it from nothing.

---

## Start / stop

The database is a container; the service is a plain Node process.

```bash
docker start ori-agent-db
```

```bash
npm run build && node dist/main.js
```

Stop the service (Windows — `pkill` does not reach it):

```bash
powershell -Command "Get-NetTCPConnection -LocalPort 3200 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"
```

Then open **http://localhost:3200/admin**

| | |
|---|---|
| Console | `admin@local.test` / `change-me-after-first-login` |
| Database | `postgres://ori:ori@localhost:5442/oridemo` |
| Read role | `ori_reader` / `ori_reader_pw` (SELECT only) |

Ports 5432 and 5433 were already taken on this machine, hence 5442.

The service no longer exits when something is wrong with the database — it
serves a setup screen at `/admin` instead. Stopping the container under a
running service is a reasonable thing to try: the console says the database has
stopped responding, and **check now** reconnects once it is back, with no
restart.

---

## What is already in it

A stand-in host application — `organisations`, `customers`, `orders`, with two
tenants (Acme = org 1, Globex = org 2) and five orders. The service's own tables
live in the `ori` schema of the same database, named `agent_*`.

Two further databases exist from testing the onboarding paths, and are safe to
drop:

| Database | What it demonstrates |
|---|---|
| `orifresh` | A host database the service installed itself into from nothing. |
| `oriwiz` | Installed by hand from the setup script, because `wiz_app` may not create tables. |

Configured: one application (`shop`), two roles, and a live `find_order`
function.

| Role | Sees |
|---|---|
| `support` | One organisation. Must supply `org_id` or it is refused. |
| `staff_admin` | Everything — exempt from `org_id`. |

---

## Things worth trying

**The refusal.** In the console → Functions → `find_order` → *Try it*. Run as
`support` and leave the `org_id` box blank. It returns `denied`, not an
unfiltered result. That is the single most important behaviour in the service.

**The disambiguation.** Same dialog, `org_id` = 1, params
`{"reference": "ORD-1002"}`. Four orders match equally, so it asks instead of
picking. Change it to `ORD-10023` and it resolves.

**The tenant boundary.** `org_id` = 1 with `{"reference": "ORD-20001"}` returns
empty — that order belongs to Globex. Switch to `org_id` = 2 and it appears.

**The validator.** Edit the function and try to break it: change a
`{{param:reference}}` to `$1`, or add `SELECT *`, or delete the
`AND {{scope:org_id}}` while leaving the scope filter declared. Each is refused
with a specific reason. Introduce a typo in a column name and *Postgres* is what
tells you.

---

## Rebuilding from scratch

```bash
docker rm -f ori-agent-db
```

```bash
docker run -d --name ori-agent-db -e POSTGRES_USER=ori -e POSTGRES_PASSWORD=ori -e POSTGRES_DB=oridemo -p 5442:5432 postgres:16-alpine
```

Then apply `docs/local-seed.sql` (the demo tables and the read-only role), set
`.env` — `ENCRYPTION_KEY` from `openssl rand -base64 32` — and start the
service. Migrations for the `ori` schema run automatically at boot.

---

## Still needed for chat

No model is configured, so the planner has nothing to think with. Everything
else works; a chat request returns *"I'm having trouble reaching my language
model"*, which is the honest answer.

Add one in the console → **Models**: any OpenAI-compatible base URL, the model
id, and a key. A vLLM instance and a hosted API are configured the same way.
Then **Check health** to confirm it is reachable.
