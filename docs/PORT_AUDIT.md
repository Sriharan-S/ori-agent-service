# Port audit — verdicts for the four unreviewed services (§2.3)

> **Historical.** This service was originally scoped as an OriginBI-specific
> rewrite, and this document records the audit of the code it was to replace.
> The service is now product-agnostic and ports nothing from that codebase, so
> this is kept for two reasons: the verdicts still stand if anyone revisits that
> code, and the two cross-cutting findings at the end are why
> [FUNCTION_AUTHORING.md](./FUNCTION_AUTHORING.md) says what it says about
> scoping and row bounds.

Source: `originbi/backend/admin-service/src/rag/` at the commit checked out on
2026-07-28. Each file was read in full. The questions asked of each, per the
plan: does it generate SQL internally? does it call `text_to_sql`? does it use
parameterized queries?

**Headline: none of the four generate SQL or call `text_to_sql`.** All database
access is hand-written. The problems are elsewhere — missing RBAC scoping and
unbounded result sets — and they are why three of the four need rebuilding
rather than porting.

Note: the plan lists `role-fitment.service.ts`; the file is actually
`overall-role-fitment.service.ts`. Same file, verdict below.

---

## 1. `jd-matching.service.ts` (1684 lines)

**Verdict: rebuild as registry functions.**

| Question | Answer |
|---|---|
| Generates SQL? | No |
| Calls `text_to_sql`? | No |
| Parameterized? | Yes |

The one query (`~line 749`) is properly parameterized, including the RBAC
filter, which is appended as `AND r.corporate_account_id = $n` with the value
pushed onto the params array. That part is correct, and it is the pattern the
`{{scope:key}}` token generalises.

Two problems make it unsuitable to port as-is:

- **No row limit.** The query ends `ORDER BY aa.total_score DESC NULLS LAST`
  with no `LIMIT`. It loads every completed attempt in scope into memory and
  then scores them in JavaScript. At 1,761 attempts today that is survivable;
  it does not stay survivable.
- **Selects PII it does not need.** `r.mobile_number` and `u.email` come back
  on every row and are carried through the matching pipeline.

There is also a schema-introspection query at line 739 (`information_schema`
lookup for `sincerity_class`) used to branch the SELECT list at runtime. That
is a migration problem being papered over in the query path.

**What to do:** the JD-matching *scoring logic* (the LLM-driven part, ~line 499
onwards) is worth keeping and is independent of the data access. Split it: a
`list_candidates_for_role` read function with a bounded, explicitly-columned
query, and the scoring as a separate report function that takes the candidate
set. Do not port the file.

---

## 2. `overall-role-fitment.service.ts` (361 lines)

**Verdict: rebuild as a registry function. Do not port.**

| Question | Answer |
|---|---|
| Generates SQL? | No |
| Calls `text_to_sql`? | No |
| Parameterized? | Mostly — one exception |

This is the one with a real security problem.

- **No `UserContext` anywhere in the file.** `corporateId`, `groupId`,
  `affiliateId` and the rest arrive as *optional filter inputs* on the request
  object. RBAC is entirely the caller's responsibility, and nothing in the file
  enforces or even checks it. Omit `corporateId` and the query returns every
  registration in the platform.
- **`LIMIT ${maxStudents}`** at line 242 is string interpolation into SQL. The
  value comes from `input.limit`, which originates in a request DTO. It is
  almost certainly a validated number today, which is why this has not bitten;
  it is still exactly the pattern hard constraint 2 exists to forbid, and it is
  one refactor away from being reachable.
- No `is_deleted` guard on the base query.

The filter-building itself (lines 140–225) is good work — every user value is
pushed to `params` and referenced as `$${params.length}`. The structure is
worth imitating in the new `list_*` functions. The file is not worth keeping.

---

## 3. `future-role-report.service.ts` (430 lines)

**Verdict: port with rewrite.** The least problematic of the four.

| Question | Answer |
|---|---|
| Generates SQL? | No |
| Calls `text_to_sql`? | No |
| Parameterized? | N/A — no database access at all |

The file touches no database. It takes a profile object it is handed and drives
an LLM to produce a future-role report, with the fallback pattern already
applied around the call (`invokeWithFallback`, ~line 406).

Because it has no data access, it has no RBAC surface of its own — it inherits
whatever the caller resolved. That is fine under the new architecture, where the
caller is a registry function that has already scoped its read.

**What to do:** port the report-generation logic close to as-is. Wrap it as a
report-category function taking a resolved `registrationId`, which internally
uses the read path to fetch the profile and then calls this logic. Repoint the
LLM calls at `LlmService`. Rewrite the prompt for the new persona.

---

## 4. `custom-report.service.ts` (1667 lines)

**Verdict: rebuild as registry functions. Do not port.**

| Question | Answer |
|---|---|
| Generates SQL? | No |
| Calls `text_to_sql`? | No |
| Parameterized? | Yes |

Queries are parameterized (`$1` at lines 295 and 1067) and the name-search query
does guard `r.is_deleted = false`. But:

- **No RBAC scoping of any kind.** No `UserContext`, no corporate filter, no
  user filter. `getUserAssessmentData` (line ~1005) searches `registrations` by
  name across the entire platform and returns the first match, including
  `u.email`, `u.role`, DISC scores and full report payloads. Any caller who can
  reach this service can read any candidate's assessment data.
- **No `LIMIT`.** The name query is a triple fuzzy match
  (`= $1 OR LIKE '%$1%' OR '$1' LIKE '%full_name%'`) with no bound. A short
  search term matches most of the table.
- The third clause of that match — `LOWER(TRIM($1)) LIKE '%' || full_name || '%'`
  — matches when the *stored name is a substring of the search term*. Passing a
  long string matches many unrelated rows, and `results[0]` is then taken as
  "the" person.

That last point is worth stating plainly: this is the same class of bug the
disambiguation work exists to solve, and it currently resolves silently to
whichever row sorted first.

**What to do:** the report *composition* logic (sections, formatting, the
narrative prompts) is substantial and worth harvesting. The data access must be
replaced wholesale by bounded, scoped registry functions. Treat the file as a reference document, not as source to move.

---

## 5. `verify-rag-production.ts` (105 lines) — also requested

**Verdict: drop. Not a regression suite.**

The plan flags this as "likely the existing regression suite and may be worth
adapting". It is not one. It is a manual smoke script: boot the Nest context,
check the `pgvector` extension is installed, generate one embedding, run one
semantic search, print timings. There are no assertions and no exit-code
discipline beyond two `process.exitCode = 1` branches, and everything it checks
is embeddings/pgvector infrastructure this service does not use.

Nothing to adapt. The regression coverage it implies is provided by
`test/` in this repo, and the retrieval-quality question it gestures at is
the plan-correctness eval in `test/eval/`.

---

## Cross-cutting observations

Two things showed up in more than one file and are worth carrying into
`docs/FUNCTION_AUTHORING.md` as standing rules — both are already enforced:

1. **RBAC as an optional input is not RBAC.** Three of these services accept
   the scoping value as a filter the caller may omit. Here the scope comes from
   the caller's identity, and compilation throws rather than emitting an open
   filter (`test/security/sql-template.spec.ts`).

2. **Every read needs a bound.** Three of the four have no `LIMIT`. Here the
   engine adds one, so an author cannot forget it.
