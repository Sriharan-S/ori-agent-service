# Wiring OriginBI report downloads

Everything here is configuration. No part of the Ori agent service knows what a
report is, that OriginBI exists, or that `/report/generate/student/:id` means
anything — the behaviour below comes entirely from a service row and two
function definitions in
[originbi-functions.bundle.json](./originbi-functions.bundle.json).

If the report API changes, this file and that bundle change. No service code
moves.

---

## What the host API does

`student-service` renders reports as a background job. Two calls:

```
GET /report/generate/student/:user_id?reportType=full
  → 200 { "success": true, "jobId": "...", "statusUrl": "/report/download/status/..." }

GET  <statusUrl>          Accept: application/json
  → 200 { "status": "PROCESSING", "progress": "..." }
  → 200 { "status": "COMPLETED", "downloadUrl": "...?download=true", "password": "..." }
  → 500 { "status": "ERROR", "error": "..." }
```

Two details that matter:

- **`:user_id` is a `users.id`, not a `registrations.id`.** The handler queries
  `assessment_sessions.user_id`. A registration id in that slot produces a
  different person's report and nothing downstream notices. `find_candidate`
  returns both columns for exactly this reason, and
  `generate_candidate_report` takes the user id.
- **The status route answers JSON only for `?json=true` or
  `Accept: application/json`.** The agent always sends that header when polling,
  so the `statusUrl` the host returns can be used unchanged.

---

## 1. Register the service

Applications → **Registered services** → *Register service*.

| Field | Value | Why |
|---|---|---|
| Name | `reports` | What the action's `service` field names. |
| Base URL | `http://localhost:3001/` | Where the agent sends the request. An internal hostname is fine. |
| Public base URL | `http://localhost:3001/` | Where a download link should point. Must work in a browser. |

Set the base URL to wherever `student-service` actually listens.

**Set the public base URL when the two differ** — a container name, a private
address, anything a browser cannot reach. Download links are rebuilt against it.
Leave it blank only when the base URL is already publicly openable.

The agent will not call a host that is not registered here, and will not follow
a URL out of a response body that resolves anywhere else. That is what stops a
saved function from reaching an internal address.

---

## 2. Import the bundle

Functions → **Import** → `docs/originbi-functions.bundle.json`.

Every function is validated against your database on the way in: the reads are
planned by Postgres, and each action's precondition is compiled and executed
with `LIMIT 0`. Anything that will not run is reported rather than saved.

Two of the twenty-five are actions:

| Function | Role | Acts on |
|---|---|---|
| `generate_my_report` | STUDENT | The caller's own `user_id`, from their proven scope. No parameter. |
| `generate_candidate_report` | CORPORATE, ADMIN | A `user_id` from `find_candidate`, proven to be in the caller's tenant. |

---

## 3. Give the roles permission

An action needs **two** grants. Missing either one refuses the call.

Roles → each role:

| Role | Add to allowed functions | Add to write scopes |
|---|---|---|
| STUDENT | `generate_my_report` (plus the new read functions) | `reports.generate` |
| CORPORATE | `generate_candidate_report` (plus the new read functions) | `reports.generate` |
| ADMIN | already `*` | `reports.generate` |

`ADMIN` keeps `corporate_account_id` and `user_id` in its **unscoped keys**,
which is what lets it generate for any candidate.

---

## 4. Try it

Playground, as each role:

- **STUDENT**, `user_id` set to a real user → *"download my report"*
- **CORPORATE**, `corporate_account_id` set → *"get me the report for Priya Sharma"*
  (two steps: `find_candidate`, then the action with the id it returned)
- **CORPORATE**, with another tenant's candidate → must be refused

The answer ends with a **Download the report** link and the report password,
rendered as controls rather than as text in the reply.

---

## How each guarantee is enforced

| Concern | Mechanism |
|---|---|
| A student can only ever get their own report | `{{scope:user_id}}` in the path. The value is the caller's proven scope; the model never supplies it. A role with no value is refused before the call. |
| Corporate can only get their own candidates' | A `precondition` — `SELECT 1 FROM registrations r WHERE r.user_id = {{param:user_id}} AND {{scope:corporate_account_id}}` — must return a row first. |
| Admin can get anyone's | `ADMIN` is exempt from `corporate_account_id`, so that filter compiles to `TRUE`. The existence check still applies: a user id that matches no registration is refused even for an admin. |
| A hallucinated id | The precondition. The id reaches the function through the model, so it is proven against the tenant before anything is generated. |
| The link is correct | It is never shown to the model. The host's URL is appended to the answer verbatim and emitted as an `artifact` event. |
| The agent cannot be redirected | The `statusUrl` comes out of a response body, so it is re-pinned to the registered origin. A download link that resolves off-origin is discarded rather than handed over. |
| A report that takes too long | `OUTBOUND_POLL_MAX_MS` caps the wait. Past it the agent says the report is still being prepared, which is true. |

---

## Notes and limits

- **`reportType=auto` is not wired up.** The student portal uses it, and it can
  answer `200 { "blocked": true }` with no `statusUrl` — the agent would report
  that it could not find where to follow the job up. The bundle uses explicit
  `full` / `short` / `level1` instead. If you want `auto`, the clean fix is for
  the host to return a job whose status settles to a failure, rather than a
  success-shaped body with nothing in it.
- **The report password is exposed.** `result.expose` hands it back verbatim.
  It never enters a model prompt, but anyone who can call the function sees it.
  Remove that entry from both actions if that is not what you want.
- **No confirmation step.** `requiresConfirmation` is stored and surfaced but
  the two-turn confirm flow is not implemented yet. Generating a report is
  idempotent and harmless, which is why these two are safe without it; do not
  copy the pattern to something destructive until that lands.
