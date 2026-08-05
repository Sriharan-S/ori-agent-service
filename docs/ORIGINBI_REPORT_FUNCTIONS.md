# OriginBI report functions

Configuration, not service code. Everything here is a function definition in
[originbi-reports.bundle.json](./originbi-reports.bundle.json). No part of the
Ori agent service knows what a report is.

This bundle is imported **after**
[originbi-functions.bundle.json](./originbi-functions.bundle.json). It replaces
three functions with corrected versions and adds thirteen new ones.

---

## The bug

Report readiness was read from `assessment_sessions.is_report_ready`.

```
 sessions total ......... 2202
 is_report_ready = true .... 0
 sessions with a report .. 743
```

The column is `false` on **every row in the database**. Nothing writes it. So
every function that derived readiness from it — `find_candidate`,
`list_candidates`, and by extension every answer built on them — reported every
report as missing, including the 743 that exist.

That is the whole of what the admin panel transcript showed:

| Asked | Answered | Actually |
|---|---|---|
| Anjaly's report | "not ready yet" | Ready. `OBI-02/26-SCHOOL_STUDENT-018`, generated 2026-02-23, downloadable. |
| Maha Vidhya Sri's report | "not ready yet" | Ready. `OBI-G39-06/26-CS-005`, generated 2026-06-18, **plus** a level 3 IAT report. |
| Ariyappan's report | "not ready" | Correct, but by accident — the session expired and no report row exists. |
| "how many in the DI trait" | "I don't have access to live numbers" | 66 candidates. There was no trait-code function to call. |
| "DI trait code students list" | same refusal | Same. |

The last two were not a bug — nothing in the registry could answer them. That is
the other half of this bundle.

Readiness is now derived from the report rows themselves. `is_report_ready` is
not read by anything in this bundle. Fixing the column on the OriginBI side is
still worth doing, but nothing here depends on it any more.

---

## Where reports actually live

Three tables, not one. This is the part that was not obvious.

| Level | Name | Stored in | Keyed on | Ready when | Numeric score? |
|---|---|---|---|---|---|
| 1 | Behavioural (DISC) | `assessment_reports.disc_scores` | `assessment_session_id` | a row exists | yes, out of 40 |
| 2 | Agile Compatibility Index | `assessment_reports.agile_scores` | `assessment_session_id` | a row exists | yes, out of 125 |
| 3 | IAT Gen | **`iat_reports`** — `bias_map` array + `report_text` narrative | `assessment_attempt_id`, also carries `assessment_session_id` and `user_id` | `status = 'DONE'` | no — pattern based |
| 4 | Metaphor | **`metaphor_reports`** — `markdown` | `assessment_attempt_id`, also carries `assessment_session_id` and `user_id` | a row exists | no — pattern based |

Levels 1 and 2 share one row in `assessment_reports`, which also carries the
report number, the download URL, the password and `dominant_trait_id`.

`assessment_reports.level3_scores` and `.level4_scores` exist but are `{}` on all
1,486 rows. They are a dead end — nothing writes them, and nothing here reads
them. The level 3 and 4 material is in the two dedicated tables.

`iat_reports.status` only ever takes the value `DONE` in this database; the
functions still test for it rather than assuming, because a failed generation
would be the case that matters.

### Three traps

**127 of the 182 IAT reports point at a level 2 attempt id.** `iat_reports`
carries `assessment_attempt_id`, `assessment_session_id`, `registration_id` and
`user_id`. Only 55 of its rows reference an attempt that is actually at level 3;
the other 127 reference the candidate's *level 2* attempt. The session and
registration references are sound in every row, so the functions here key level 3
readiness off `assessment_session_id` and count the reports themselves — which is
why `level_report_coverage` shows 182 level 3 reports against 66 level 3
attempts. That is the anomaly showing through, not a counting error.
`metaphor_reports` does not have this problem: all 40 rows point at a level 4
attempt.

**A level's id is not its level number.** Level 3 (IAT) is `assessment_levels.id
= 5`; level 4 (Metaphor) is `id = 3`. Every function resolves the id through
`assessment_levels` on `level_number` rather than hardcoding.

**Every table is double-seeded.** Sessions, attempts, reports, levels and score
bands each have exactly two physical rows per id, with no primary key. A plain
join silently doubles counts — that is why `agile_scores_all` returned 1,325 rows
for 665 candidates in the first draft. Every function here uses `DISTINCT ON`,
`COUNT(DISTINCT id)`, or `LATERAL … LIMIT 1`, so each is correct whether or not
that gets fixed.

---

## What the numbers are

Verified against the live database, deduplicated:

```
registered candidates ............ 1149
completed the assessment .......... 763
main report generated ............. 743
  of those, downloadable .......... 723
level 3 IAT report ................ 182
level 4 Metaphor report ............ 40
completed but still no report ...... 41
```

The panel's earlier "1,153 registered" was itself slightly over — there are 1,149
registration rows and none are soft-deleted.

---

## The functions

### Corrected — same names, replaced on import

| Function | What changed |
|---|---|
| `find_candidate` | `report_ready` now checks `assessment_reports`, not the dead flag. Adds `iat_report_ready` and `metaphor_report_ready`. The session is picked with a `LATERAL … LIMIT 1` so a candidate with several sessions no longer multiplies rows. |
| `list_candidates` | Same readiness fix, same three flags, plus `user_id` so a report can be generated straight from the list. |
| `my_report` | Was "does a report row exist". Now reports readiness per session with a plain-language `readiness` line, the trait code and style, and level 3 / level 4 availability. |

### New — report status and coverage

| Function | Roles | Answers |
|---|---|---|
| `candidate_report_status` | CORPORATE, ADMIN | "Is *X*'s report ready?" — per session: report number, generated, downloadable, trait code and style, and level 3 / level 4 separately. This is the one that was missing. |
| `report_readiness_summary` | CORPORATE, ADMIN | The seven headline counts above, in one row. |
| `candidates_with_reports` | CORPORATE, ADMIN | Every candidate who has a report, newest first, with totals, trait code and which extra reports exist. |
| `level_report_coverage` | CORPORATE, ADMIN | Per level: attempts, completed, reports generated — counting each level's reports in the table they actually live in. Currently `1: 1101/916/743`, `2: 1038/805/665`, `3: 66/55/182`, `4: 176/44/40`. |
| `program_report_breakdown` | CORPORATE, ADMIN | Registered / completed / report-ready per program. |

### New — bulk score tables

| Function | Roles | Answers |
|---|---|---|
| `behavioural_scores_all` | CORPORATE, ADMIN | "All the scores of students who completed level 1." 916 rows: D/I/S/C, total, trait code, style, sincerity. Optional `trait_code` and `program` filters. |
| `agile_scores_all` | CORPORATE, ADMIN | The same for level 2. 805 rows: the five agile values, total, band. Optional `program` filter. |

Both are **attempt-based**, not report-based, so a candidate who finished the
level appears whether or not their report has been generated — they get a total
either way, and the per-dimension breakdown once the report exists. That is why
`behavioural_scores_all` returns 916 rows where `candidates_with_reports` returns
743.

`out_of` comes from the attempt's own `max_score_snapshot`, falling back to the
level maximum. A handful of older level 1 records carry a total above the current
maximum of 40, which makes their share exceed 100% — that is stale source data,
surfaced rather than hidden.

Level 2 totals above 125 fall outside every published band and are labelled
`outside the published band range` rather than being silently given the top band.

### New — trait codes

| Function | Roles | Answers |
|---|---|---|
| `trait_code_distribution` | CORPORATE, ADMIN | "How many are in the DI trait?" Every code with its style name, count and share. |
| `candidates_by_trait_code` | CORPORATE, ADMIN | "DI trait code students list." The 66 DI candidates with their scores. |

The code is `personality_traits.code` — the two-letter DISC blend reached through
`assessment_reports.dominant_trait_id`. Current spread:

```
CD 168  DC 95  CS 87  DI 66  DS 54  CI 52  SC 49
SD 49   IS 37  ID 34  IC 27  SI 24  C 1        (743 total)
```

### New — level 3 and level 4 report bodies

| Function | Roles | Answers |
|---|---|---|
| `candidate_iat_report` | CORPORATE, ADMIN | The stored IAT report: one row per bias area with pattern strength, hesitation gap and error rate, plus the narrative. |
| `candidate_metaphor_report` | CORPORATE, ADMIN | The stored Metaphor report body. |
| `my_iat_report` | STUDENT | The caller's own. |
| `my_metaphor_report` | STUDENT | The caller's own. |

`candidate_iat_report` reads the generated report. The existing
`candidate_iat_patterns` reads the raw per-module timings from
`iat_attempt_modules`. Both are useful and `whenNotToUse` points each at the
other.

---

## Installing

1. **Functions → Import →** `docs/originbi-reports.bundle.json`.

   Every function is validated against the database on the way in and stored as
   a draft. The three replaced names upsert over the existing definitions.

2. **Approve → Go live** on each.

3. **Roles → CORPORATE → allowed functions**, add:

   ```
   candidate_report_status
   report_readiness_summary
   candidates_with_reports
   behavioural_scores_all
   agile_scores_all
   trait_code_distribution
   candidates_by_trait_code
   candidate_iat_report
   candidate_metaphor_report
   level_report_coverage
   program_report_breakdown
   ```

4. **Roles → STUDENT → allowed functions**, add:

   ```
   my_iat_report
   my_metaphor_report
   ```

ADMIN holds `*` and is exempt from `corporate_account_id`, so it picks all of
these up on import with no role change. The admin panel is what the transcript
was using, so step 3 and step 4 are only needed for the other two roles.

---

## Scoping

Unchanged from the existing bundle, and worth restating because it is what makes
the bulk functions safe to expose:

- Every corporate-facing function filters on `r.corporate_account_id` via
  `{{scope:corporate_account_id}}`. A CORPORATE caller sees only their own
  candidates; `behavioural_scores_all` returns their rows, not all 916.
- ADMIN is exempt, so the filter compiles to `TRUE` and the counts are
  platform-wide.
- Student functions bind `{{scope:user_id}}` to the caller's proven identity —
  `s.user_id`, `i.user_id` or `mr.user_id` depending on the table. The model
  never supplies it.
- A scope that cannot be bound refuses the query rather than running it
  unfiltered.

---

## Verification

All sixteen were checked against the live database before this was written:
the service's own `checkTemplateStatically` passes with no errors, each compiles
through `compileSqlTemplate`, and each executes under `applyRowBounds` returning
the expected columns. Slowest is `list_candidates` at 195 ms over 1,149 rows;
everything else is under 50 ms.

Spot checks that previously answered wrongly:

```
candidate_report_status(registration_id: 1206)  → MAHA VIDHYA SRI L
    main_report_ready true, OBI-G39-06/26-CS-005, iat_report_ready true
candidate_report_status(registration_id: 578)   → Anjaly
    main_report_ready true, OBI-02/26-SCHOOL_STUDENT-018
candidate_report_status(registration_id: 541)   → Ariyappan
    main_report_ready false, "No report — the assessment is expired"
```

---

## Left for the OriginBI side

Not actionable from this repository.

- **`assessment_sessions.is_report_ready` is never written.** Nothing here reads
  it any more, but it is a false signal for anything else that does — including
  the OriginBI UI if it uses it.
- **`iat_reports.assessment_attempt_id` is wrong on 127 of 182 rows** — it points
  at the candidate's level 2 attempt rather than their level 3 one. Anything
  joining IAT results to attempts is currently attributing them to the wrong
  level. The session and registration references on those rows are correct, which
  is the only reason level 3 is reportable at all.
- **41 sessions are `COMPLETED` with no report row.** Worth finding out whether
  those generation jobs failed or were never queued.
- **Level 1 totals above the level maximum.** Some older attempts have a
  `total_score` of 60 against a maximum of 40 with no `max_score_snapshot`, so
  any percentage computed from them is wrong. Either the maximum changed and the
  old rows were not snapshotted, or the scoring changed.
- **Level 2 totals above 125.** Same shape of problem, and it puts those
  candidates outside every band in `aci_score_bands`.
- **Every table is double-seeded** with no primary key. The functions tolerate
  it; it should still be fixed.
