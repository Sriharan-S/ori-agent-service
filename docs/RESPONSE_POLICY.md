# The response policy

Roles decide what the agent can **reach**. A response policy decides what it may
**say** about what it reached.

The two are different questions, and the second has no answer in a function
grant. "May give career advice from a candidate's own assessment scores" and
"must not offer a clinical opinion" describe the *same function* returning the
*same rows*. No amount of role editing separates them.

Like everything else here, a policy is configuration: one document per
application, edited in the console, exported and imported as JSON. Nothing about
any particular product lives in the service code.

---

## What it is

| Part | What it does |
|---|---|
| **Extra instructions** | Free text appended to the reasoning and the answering prompts. Voice, standing caveats, house style. |
| **Allowed subjects** | Topics the model is told it may cover, each with a note on how. |
| **Refused subjects** | Topics it must decline. Give a topic *patterns* and it is also blocked mechanically. |
| **Default refusal** | What the user sees when a rule that matched carries no message of its own. |

Console → **Response policy**.

---

## Two enforcement points, on purpose

**The prompt** is what makes the model *willing*. This is the half people
underestimate: a model given no policy falls back on its own caution and
declines questions it could have answered from the rows in front of it. "You may
give career guidance, grounded in the candidate's own scores" is not a
restriction — it is the thing that makes the feature work.

**The pattern check** is what makes a refusal *hold*. It runs on the raw message
before routing resolves, before the planner is called, before any function
executes. A refused message never leaves the process: not to a model provider,
not to the database, not to a registered service. It costs nothing and does not
depend on the model cooperating.

Neither can widen access. Every fact in an answer still comes from a registry
function the caller's role may call. A policy only narrows, or shapes, what is
said about what the caller could already read.

---

## Writing deny rules

A rule with **no patterns** is prompt-only: named as something to decline, but
nothing is blocked. That is the honest shape for a subject no keyword captures —
"predicting a person's future performance" has no reliable trigger word, and
inventing one would refuse innocent questions.

A rule **with patterns** is enforced. Two forms:

- A plain phrase matches on **word boundaries**. `art` will not match `start`.
- `/…/` is a regular expression. Flags `gimsu` are accepted; `g` is stripped, so
  a shared compiled rule cannot carry match state between requests.

A pattern that will not compile is **rejected when you save it**, not skipped at
match time. A rule that never fires reads as protection and is not.

### Keep patterns narrow

The failure mode that matters is the false positive. A user refused for a reason
they cannot see has no way forward — they do not know which word tripped it, and
they should not, because that is a map of how to phrase around it.

Prefer a pattern that requires structure over one that requires a word:

```
bad     depression
better  /\b(am|is|are)\s+(i|he|she|they)\b.{0,40}?\b(depressed|depression)\b/i
```

The first refuses "what depresses the completion rate for level 2". The second
does not.

Use **Try it** on the policy page to check a message against the rules without
sending it anywhere, and check the questions you *want* answered as well as the
ones you want blocked.

---

## Import and export

Export gives you an `ori.policy-bundle` JSON file. Import replaces the current
policy.

**An imported policy arrives switched off**, whatever the file says. A policy
written for another environment encodes that environment's judgement about who is
asking and what they may be told; enabling it unread is how a deployment starts
refusing people for reasons nobody here decided. Read it, then turn it on.

`POST /v1/admin/applications/:id/policy/import?enable=true` opts out of that,
for a scripted deployment that has already reviewed the file.

A hand-written bare policy object (no `bundle` wrapper) is accepted too — it is
what someone writing one by hand produces first.

---

## What a refusal looks like

The run is recorded with response type `refused`, distinct from both `answer`
and `error`: nothing failed, and no function ran. The audit log records which
rule matched and the matched text. The user sees only the refusal message.

The refusal is written to the conversation as a normal assistant turn, so a
follow-up — "why not?" — has something to refer to.

---

## Caching

A saved policy takes effect within the registry cache TTL
(`REGISTRY_CACHE_TTL_MS`), the same as a function going live. Saving invalidates
the entry for that application immediately, so in practice an edit is live at
once on the instance that made it and within the TTL everywhere else.

---

## The OriginBI starting policy

[originbi-response-policy.bundle.json](./originbi-response-policy.bundle.json)
is a worked example: it permits career and course guidance grounded in a
candidate's own scores, permits explaining what a score or band means, and
refuses clinical diagnosis, medical advice, legal advice, hiring decisions
presented as recommendations, performance prediction, and ranking people by
worth.

Import it, read it, then enable it.
