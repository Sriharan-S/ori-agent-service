# OriginBI endpoints needed for write functions

> **Integration note, not a service requirement.** This service is
> product-agnostic; write functions call whatever HTTP API the host application
> registers as a service. This document is the gap list for OriginBI
> specifically — the first application expected to use the service — and is
> handed back to that team rather than actioned here.

Writes never touch the database. Every write goes out through an existing
OriginBI microservice API so that validation, business rules and side effects
stay where they already live.

**Nothing in this list should be built from this repository** — these are
OriginBI-side changes.

Scanned: `admin-service`, `auth-service`, `student-service`, `corporate-service`
controllers on 2026-07-28.

---

## Exists and is usable

| Write function (proposed) | Endpoint | Service | Notes |
|---|---|---|---|
| `update_registration_status` | `PATCH /registrations/:id/status` | admin | Takes a resolved registration id. Good fit. |
| `set_ai_counsellor_access` | `PATCH /registrations/:id/ai-counsellor` | admin | Boolean toggle, resolved id. |
| `extend_assessment_deadline` | `PUT /admin/assessments/:id/extend` | admin | Resolved attempt id. |
| `grant_counsellor_access` | `POST /registrations/counsellor-access` | admin | Verify the body shape before wiring. |

For each of these, confirm before use:

- Does it accept the **user's** bearer token, or only an admin service key? The
  agent forwards the end user's token when an action asks it to; an endpoint
  that only accepts a service identity would mean writes run with more
  authority than the user has.
- Does it support an idempotency key? If not, the client must not retry.
- What does it return on success — enough to record `afterState`?

---

## Missing — needs building in OriginBI

| Write function (proposed) | Needed endpoint | Service | Why it does not exist yet |
|---|---|---|---|
| `update_user_name` | `PATCH /registrations/:id` accepting `full_name` | admin | Only status and the AI-counsellor flag are patchable today. The obvious first gap to close. |
| `update_user_email` | `PATCH /users/:id` accepting `email` | auth | Email lives in both Cognito and `users`. Needs a single endpoint that keeps them consistent — the agent must not be the thing coordinating that. |
| `deactivate_user` | `PATCH /users/:id` accepting `is_active` | auth | No endpoint found. High-impact: mark `requiresConfirmation`. |
| `reset_assessment_attempt` | `POST /assessments/:id/reset` | exam-engine | Only the IAT report retry exists (`POST /iat/admin/:attemptId/report/retry`), which is not the same operation. |
| `update_corporate_details` | `PATCH /corporate-accounts/:id` | corporate | Not found in the controller scan. Confirm before assuming it is absent. |

---

## Questions for the OriginBI side

1. **Token forwarding.** Do the admin-service write endpoints accept a Cognito
   ID token in `Authorization`, and do they enforce role checks on it? The
   `RolesGuard` exists but is applied per-controller — confirm coverage for each
   endpoint above.

2. **Idempotency.** None of the endpoints found advertise an idempotency key.
   Without one the agent must never retry a write. That is the safe default and
   it is what the client will do, but it means a timed-out write is reported to
   the user as uncertain rather than retried.

3. **Response bodies.** Audit records need before/after state. If these
   endpoints return `{ success: true }`, the agent has to read the record before
   and after — two extra replica round trips, and a race. Returning the updated
   resource would be better.

4. **`corporate-service` scan.** The scan above did not surface write
   controllers there. Either they live elsewhere or the service is read-mostly;
   worth confirming with someone who knows the service rather than inferring it
   from grep.

---

## Related finding

While scanning auth, `admin-service/src/auth/cognito-universal.guard.ts` was
found to accept an unsigned `X-User-Context` header as an identity, and to fall
back to an anonymous context rather than rejecting.

Concretely, `cognito-universal.guard.ts` tries four paths in order:

1. `Authorization: Bearer <cognito-id-token>` — verified properly.
2. **`X-User-Context: {"id": 123, …}` — an unsigned JSON header.**
3. An existing `request.user` from upstream middleware.
4. **Anonymous fallback** — `canActivate` returns `true` regardless.

Path 2 calls `enrichFromHeader`, which looks the claimed `id` up in the database
and derives role and scope from the row. Deriving the role from the database is
the right instinct, but the *identity* still comes from an unauthenticated
header: setting `X-User-Context: {"id": <an admin's user id>}` yields a fully
populated ADMIN context with no token at all. Path 4 means the guard never
rejects.

Impact depends on whether `admin-service` is reachable from outside the cluster
— worth confirming and fixing regardless of this project's timeline. It touches
the same endpoints as the gap list above, so it is worth doing in the same pass.
