# Hedged fallback and shadow calls

Status: **design only**. Nothing here is built. Gated on adopter demand, in the
same way `guardrail-hooks.md` is — see "Sequencing".

Supersedes the framing of §3.8 in [critique-beyond-pr18.md](./critique-beyond-pr18.md),
which filed this as "no hedged/parallel fallback — Minor, latency". That framing
is why it was deferred, and it undersold the feature. See
[#33](https://github.com/mpointer/llm-governance-gateway/issues/33).

## Problem

The gateway can tell you what a call **cost**. It cannot tell you whether it was
**worth it**.

Every governance decision we ship — a task's model, a tier, a chain's ordering —
is a bet that the chosen model is good enough for that call site. The ledger
records the outcome of the bet we placed and nothing about the bet we didn't.
An operator asking the obvious follow-up question:

> Our `enrich` task runs on Haiku. Would Sonnet actually be better? By enough to
> justify 12× the price?

has no way to answer it inside the gateway. They have to hand-roll an experiment
outside it, which means re-implementing prompt loading, model resolution, cost
accounting and judging — the things they adopted this library to stop writing.

### Why this is a governance concern, not a research one

The library's pitch is that spend control belongs in your runtime, checked
before every call, against your own data. "Is this model worth its price on this
call site" is the same species of question as "are we over budget" — it is about
money, it is answerable from the adopter's own traffic, and getting it wrong is
expensive in a way that compounds silently.

We already ship the two halves that make it answerable: a judge that scores
responses, and a ledger that prices them. What's missing is the primitive that
puts two models on the *same* input so the scores can be compared.

### The structural gap, stated precisely

A comparison needs the counterfactual: how did model A **and** model B do on
this same query. Today's ledger has no counterfactual at all. It is
logged-bandit feedback — one arm pulled per query, outcome recorded, the other
arms unobserved.

The two apparent exceptions are not exceptions:

- **Failover** produces a second model's output only when the first *failed*.
  That is a censored, selection-biased sample of "what the fallback does on
  inputs that broke the primary" — the opposite of a fair comparison.
- **The judge** scores only the response that won.

So an adopter who tries to answer the Haiku-vs-Sonnet question by training or
even eyeballing `ai_usage_log` learns, roughly, that the model they already
route to is fine. Training a policy on its own logged decisions is a known way
to get a confident wrong answer.

**Calling more than one model on the same query is the only thing that fixes
this**, and that is what §3.8 was really about.

## Two modes that share one sentence and nothing else

"Call more than one model on one query" describes two features with opposite
semantics. Conflating them would be a design error, so this doc separates them
and specs one.

| | **Race** (latency hedging) | **Shadow** (data collection) |
|---|---|---|
| Goal | Cut tail latency | Learn which model is better |
| Caller latency | Lower | Unchanged (see Rule 2) |
| Cost | Higher | Higher |
| Result used | Whichever returns first | Always the primary's |
| Loser | Cancelled mid-flight | Runs to completion — it is the data |
| Judged | No | Both, that's the point |
| Failure of second call | Irrelevant, first won | **Is itself a datum** |

They share link resolution and nothing else — not result selection, not
cancellation, not ledger semantics, not failure handling.

**This document specs `shadow`.** Race is deferred (see "Explicitly out of
scope"): it has a real use case but no evidence behind it, whereas shadow has an
argument — it is the missing input to every routing decision the gateway might
later make, including the content-based routing question in #33.

## Shape

```ts
export interface ShadowConfig {
  /**
   * The model to compare the primary against. A bare id resolves through the
   * registry like any other; a ChainLink lets you pin a BYO model.
   */
  model: string | ChainLink;
  /**
   * Fraction of eligible calls that also run the shadow. Default 0 — the
   * feature is absent unless explicitly switched on, because it spends money.
   */
  sampleRate?: number;
  /**
   * Scores BOTH responses. Defaults to the call's own `judge` config when it
   * has one; without a judge you still get cost/latency/token comparison but
   * no quality signal, which is usually the interesting axis.
   */
  judge?: JudgeConfig;
  /**
   * Run the shadow without awaiting it. Default false.
   *
   * ONLY safe on a long-lived server. On serverless the invocation can be
   * frozen or killed the moment the response is returned, losing both the
   * shadow's usage row and the money it spent — the exact failure the
   * ledger-first principle exists to prevent.
   */
  detached?: boolean;
  /** Injectable RNG for deterministic sampling in tests. Default Math.random. */
  random?: () => number;
}
```

Available per call and as a gateway-level default, mirroring `judge` exactly:

```ts
const gw = new Gateway({ ...cfg, shadow: { model: "anthropic:claude-sonnet-4-6", sampleRate: 0.02 } });

await gw.runStructured({
  ...opts,
  task: "enrich",
  shadow: { model: "openai:gpt-4.1", sampleRate: 0.05 },
});
```

## Rules

These are the load-bearing part. Each exists because violating it produces a
specific, quiet failure.

**1. The shadow never affects the response.**
The primary's result returns regardless of what the shadow does. A shadow that
errors, times out, fails schema validation, or is skipped by a cap is logged and
swallowed. This is the judge's rule (`runJudge` catches and skips) and it exists
for the same reason: *a governance check must never be the thing that breaks the
request it was watching.*

**2. The shadow never delays the response — but it is awaited by default.**
These pull against each other and the resolution matters.

Fire-and-forget gives true zero added latency, but on a platform that freezes
the invocation at response time, the shadow call and its usage row vanish —
money spent, no audit trail. So the default is **awaited after the primary
result is in hand, on its own small `AttemptBudget`**. The caller's response is
already determined; only its delivery waits.

Cost of that choice, stated honestly: on the sampled fraction, latency roughly
doubles. At `sampleRate: 0.02` the p50 and p99 are untouched and p100 is worse.
`detached: true` opts into the faster, riskier behaviour with the serverless
caveat documented on the field.

**3. Both calls write usage rows, and they share a traceId.**
The shadow row is logged under `route: "shadow:<route>"`, mirroring
`judge:<route>` so shadow spend is visible rather than hidden in the primary's
line item. Both rows carry the same `traceId` — that is the join (see below).

**4. Spend caps govern the shadow, and it self-skips.**
Before the shadow runs, its estimated cost is checked against the caps exactly
as the judge's is. If it would cross, the shadow is skipped with a warning and
the primary is unaffected. An experiment must not be the thing that trips the
circuit breaker.

**5. Never shadow a cache hit.**
There is no fresh primary output to compare against. Comparing a cached response
— possibly generated days ago, possibly by a since-changed model — against a
freshly generated shadow produces a comparison of two different experiments. The
sample would also be biased toward whatever caches poorly.

**6. The shadow's output never touches the cache.**
If the shadow result were written under the primary's cache key, later requests
would silently be served the shadow model's output while being attributed to the
primary. This is the single most dangerous bug available in this feature: it
converts an experiment into an undetected model swap.

**7. ZDR filters the shadow model like any other link.**
A `requireZdr` call must not quietly ship its prompt to a non-ZDR model just
because that model is only being measured.

**8. A shadow failure is data, not a failover trigger.**
If the shadow model errors or returns schema-invalid output, that is a recorded
outcome ("model B failed on this input"), which is often the most useful result
in the set. It never causes a retry, a chain advance, or any change to the
primary.

**9. Shadow calls are not free of side effects.**
The prompt is executed twice. For pure generation that is fine. For a prompt
using server-side web search, tool use, or anything the provider bills per call
or that mutates state, doubling is real. Documented, not prevented — the
gateway cannot know which prompts are pure.

## The comparison record: deliberately no new table

The obvious move is a `ComparisonStore` SPI with a row per trial. **Don't.**

`traceId` is already generated once per governed call and stamped on every row
that call writes. A shadow row sharing it means the comparison is a join over
data we already persist:

```sql
SELECT
  p.trace_id,
  p.model            AS primary_model,
  s.model            AS shadow_model,
  p.estimated_cost_cents AS primary_cents,
  s.estimated_cost_cents AS shadow_cents,
  jp.overall_score   AS primary_score,
  js.overall_score   AS shadow_score
FROM ai_usage_log p
JOIN ai_usage_log s   ON s.trace_id = p.trace_id AND s.route LIKE 'shadow:%'
LEFT JOIN ai_judge_scores jp ON jp.usage_log_id = p.id
LEFT JOIN ai_judge_scores js ON js.usage_log_id = s.id
WHERE p.route NOT LIKE 'shadow:%' AND p.route NOT LIKE 'judge:%';
```

This is the right answer for three reasons:

- **No new SPI surface.** Adding `ComparisonStore` would oblige every adopter to
  implement another interface for a feature most won't switch on.
- **The analysis is control-plane work.** Deciding what the comparison *means* —
  a significance threshold, a rollout decision, a retraining trigger — belongs to
  the adopting application. Our job is to produce the rows honestly. This is the
  §3.5 boundary.
- **It composes with what exists.** Org scoping, `metadata`, encryption and
  observability hooks all apply to the shadow row because it is an ordinary
  usage row.

## What this actually gives a router

Framed against the training-data schema in
[#33](https://github.com/mpointer/llm-governance-gateway/issues/33):

| Router needs | Shadow provides |
|---|---|
| `query` | `inputText` — **truncated at 2000 chars, encrypted if a hook is set** |
| `model_name` | `provider`/`model` on both rows |
| `response` | `outputText`, same caveats as `query` |
| `performance` | judge `overallScore` on both — a rubric score, not a task metric |
| `token_num`, cost, latency | already on every row |
| `ground_truth`, `metric` | **still absent.** Production traffic has no labels |

Two honest limits:

- **This is a designed experiment, not free data.** You get comparisons only on
  the sampled fraction, and only against the shadow model you chose. Comparing
  five candidates means five times the shadow spend, or a longer collection
  window.
- **`inputText` may be unusable.** Truncation and the `encrypt` hook mean a
  privacy-conscious deployment — the kind that adopts a governance library — may
  have no embeddable query text. Anyone planning to train on this should verify
  their own ledger before designing around it. A future `SNAPSHOT_LIMIT` override
  is the obvious follow-up, and is out of scope here.

Even with those limits, the cost/quality comparison alone answers the operator
question that opened this document, which is worth more to most adopters than a
learned router would be.

## Cost

Switching this on multiplies spend on the sampled fraction. For shadow model
price ratio `r` relative to the primary:

```
added spend ≈ sampleRate × r × (1 + judge overhead)
```

At `sampleRate: 0.02` against a 12× model, roughly +24% on the sampled slice and
+0.5% overall. At `sampleRate: 0.1` against the same model, +120% / +12%. The
default of `0` exists so nobody discovers this by accident, and Rule 4 exists so
a mis-set value cannot run away.

## Testing

Following the pattern established in `timeouts-and-deadlines.md` — every test
asserts the **ledger**, not just the absence of an exception.

- Deterministic sampling via injected `random`, as `JudgeDefaults.random` already
  allows. `sampleRate: 1` with a fixed RNG for "always shadow".
- Mock-mode shadow responders (`shadow:<slug>`), mirroring `judge:<slug>`, so the
  whole path runs in CI with zero keys.
- **Both rows written**, sharing a `traceId`, shadow under `route: "shadow:*"`.
- **The primary survives a shadow that throws** — the load-bearing test.
- Cap-skip: seeded spend near the cap, shadow skipped, primary unaffected, no
  shadow row.
- Cache hit: no shadow row (Rule 5).
- The shadow output is **not** readable from the cache afterwards (Rule 6). This
  needs an explicit test because the failure is silent and severe.
- ZDR: a non-ZDR shadow model is skipped on a `requireZdr` call.
- `detached: true` still writes its row on a long-lived process.

## Sequencing

- **H1 — the primitive.** `shadow` on `runStructured`, sampled, awaited, both
  rows ledgered, traceId join, caps and ZDR respected, cache rules enforced.
  Useful on its own: cost/latency/token comparison with no judge.
- **H2 — quality signal.** Judge both responses. This is what makes the data a
  training set rather than a cost report.
- **H3 — `runText`.** Same rules, no schema validation.
- **H4 — race mode.** Only if an adopter has a latency-sensitive surface that
  needs it. Different result-selection and cancellation logic; do not build it
  speculatively alongside shadow.

**Gate: H1 does not start without a named adopter who will switch it on.** This
is the `guardrail-hooks.md` discipline, and it was the right call there. A data
primitive with nobody collecting data is worse than nothing — it is surface area
that has to keep working.

## Backward compatibility

Non-negotiable, per the project's standing constraint.

`sampleRate` defaults to `0` and `shadow` is optional everywhere, so an existing
caller is byte-identically unaffected: no extra calls, no extra rows, no cache
key change, no schema change. **No new columns are required** — the shadow row is
an ordinary `ai_usage_log` row and the join key already exists.

## Explicitly out of scope

- **Race / latency hedging.** H4 above, deferred with reasons.
- **Streaming.** Shadowing `streamStructured` means buffering an entire second
  stream while managing the existing failover and stall clocks. The degradation
  contract there is already the most complex thing in the codebase.
- **Multi-arm (>2 models).** The mechanism generalises, the cost does not.
- **Any automatic action on the result.** The gateway never re-routes, promotes a
  model, or changes a chain because a comparison came out a particular way. That
  is a control-plane decision informed by this data — §3.5 again.
- **Statistical machinery.** No significance tests, no confidence intervals, no
  bandit allocation. Rows out; interpretation is the adopter's.
- **Lifting `SNAPSHOT_LIMIT` or the encryption caveat.** Real, related, separate.

## Open questions (answer before building)

1. **Should `detached` default to true on a detected long-lived process?** Auto-
   detection is a guess and getting it wrong loses money silently. Current lean:
   no — keep the safe default and document the flag.
2. **Should the shadow reuse the primary's resolved prompt verbatim?** Yes for
   comparability, but it forecloses comparing prompt variants on one model.
   Prompt A/B is arguably a different feature; keep this one about models.
3. **Does a skipped shadow deserve a zero-token row?** The judge's skip is a
   `console.warn` with no row. A row would make sample-rate accounting exact at
   the cost of ledger noise. Lean: no row, match the judge.
4. **`runText` in H1 or H3?** Splitting it costs a second pass over the same
   logic; folding it in widens H1. Lean: H3, keep H1 minimal.

## Decisions

| Decision | Answer | Why |
|---|---|---|
| Spec race or shadow first? | Shadow | It has an argument behind it; race has a use case but no evidence |
| New `ComparisonStore` SPI? | No | `traceId` already joins; analysis is control-plane |
| New schema columns? | None | The shadow row is an ordinary usage row |
| Awaited or detached by default? | Awaited | Ledger-first; detached loses rows on serverless |
| Shadow on cache hits? | Never | No fresh primary to compare against |
| Shadow output cached? | Never | Would silently swap the served model |
| Shadow failure → failover? | No | It is the data |
| Default `sampleRate` | 0 | It spends real money |
