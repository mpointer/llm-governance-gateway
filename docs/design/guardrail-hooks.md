# Design: pluggable guardrail hooks (pre/post)

Status: shipped in 0.16.0 (`src/guardrails.ts`, `src/trustgate.ts`) on
`runStructured`; extended to every path and to cache hits in 0.17.0 via the
shared front door (`Gateway.frontDoor`, `Gateway.applyPostGuardrail`). The
shape below is what shipped, with the decisions at each step at the end.

## Problem

Adopters bolt content checks around the gateway today: PII scrubbing
before the prompt goes out, crisis-phrase screens on what comes back,
compliance filters. Each app reinvents the wrapping, and none of it shows
up in the ledger, so a "blocked by guardrail" outcome is invisible to
audit. FMA has a real crisis-classifier pipeline and maryjane has content
constraints, so the demand is plausibly one adoption away.

## Shape

TypeScript-native hooks in the existing pipeline, no Python sidecar, no
new dependencies. Two seams:

```ts
observability-style config:

guardrails?: {
  pre?: (ctx: { prompt: string; system?: string; slug: string }) =>
    GuardrailVerdict | Promise<GuardrailVerdict>;
  post?: (ctx: { output: unknown; text?: string; slug: string }) =>
    GuardrailVerdict | Promise<GuardrailVerdict>;
}

type GuardrailVerdict =
  | { action: "allow" }
  | { action: "transform"; prompt?: string; output?: unknown } // scrub and continue
  | { action: "block"; reason: string };                        // throws GuardrailError
```

Pre runs after prompt render, before rate limit spend (a blocked call
should not burn provider budget). Post runs after schema validation and
before cache write (a transformed output is what gets cached), and before
the judge (the judge scores what the caller will actually receive).

## Rules

1. Verdicts are ledgered: a `guardrail` column (allow/transform/block +
   reason) on the usage row, so audits see blocks, not silence.
2. Unlike observability hooks, guardrails FAIL CLOSED on error by
   default: a throwing pre-hook blocks the call (config flag
   `failOpen: true` for apps that prefer availability; the flag's state
   is ledgered too). This is the same posture question FMA's crisis
   classifier already answered: name the failure mode, make it a
   decision, not an accident.
3. The judge is not a guardrail: judge scores quality on a sample,
   guardrails enforce policy on every call. Different budgets, different
   latency tolerance, both stay separate.
4. Mock mode runs guardrails for real: CI must be able to test policy.

## Open questions (answer before building)

- Streaming: post-guardrail on a stream means buffering or chunk-level
  checks. v1 should probably exclude streaming (documented), as batch
  reconcile-time checks make sense but double the per-item cost.
- Batch: run post-guardrails at reconcile time per item?
- Does `transform` need to be visible to the caller (a "was scrubbed"
  flag on the result), or is the ledger enough?

## Decisions at ship time (0.16.0)

- **Where pre runs.** After prompt render and after the rate limiter and spend
  check, before any provider spend. The limiter has already counted the call
  by then, which is the right accounting: a request that was made is a
  request, blocked or not. What a block never costs is provider tokens.
- **Ledger shape.** `UsageEntry.guardrails` is an array of records, one per
  hook that ran, rather than a single column: a call can have both a pre and a
  post verdict. A pre block writes a zero-token row with `provider:
  "guardrail", model: "pre"`. NULL means no hooks were configured, which keeps
  pre-0.16 rows and unguarded rows indistinguishable on purpose.
- **Transform visibility.** The ledger is enough. The caller gets the
  transformed object with no flag on the result; the row says it was
  transformed and why. An app that needs to tell its user can read the record
  through `observability.onUsage`.
- **Schema-invalid transforms** are a block (or, under `failOpen`, an allow of
  the original object with the error recorded). A scrubber must not hand the
  caller an object the type system says cannot exist.
- **Streaming, batch and `runText`:** excluded in 0.16.0, as the open
  questions suggested. See the 0.17.0 decisions below; the exclusion was
  caused by each path carrying its own copy of the front door, not by the
  open questions.
- **Cache hits skip the hooks** in 0.16.0. Reversed in 0.17.0, below.

## Decisions at 0.17.0: one front door, every path

The structural cause of the 0.16.0 limits was that `runStructured`, `runText`
and `streamStructured` each reimplemented rate limit → spend cap → cache key
→ cache read → prompt. A hook added to one had to be ported by hand to the
others, and was not. `frontDoor` is now the single implementation; the three
paths call it and keep only their generation body. `applyPostGuardrail` is
the single post-verdict implementation (transform validation, fail-open,
record shape), parameterised on how a path validates a transformed value.

- **Pre hook runs before the cache read**, on the rendered prompt. A policy
  added today applies to a prompt cached last week, and a per-caller policy
  (a banned user) cannot be bypassed by a shared cache entry. Cost: when a
  pre hook is configured, a cache hit loads the prompt before the read (free
  when `invalidateCacheOnPromptChange` already prefetches it). With no pre
  hook the order is unchanged and a hit costs no prompt-store read.
- **Post hook runs on cache hits**, with `provider: "cache"`. A transform is
  returned to the caller but not written back, so the stored value stays what
  the provider produced; a block writes the cache row with the verdict and
  throws. The row for a plain hit with no hooks is byte-identical to before
  except that `guardrails` is now an explicit NULL rather than absent.
- **`runText`:** a post transform must return a string; anything else is the
  schema-invalid case (block, or allow-with-error under `failOpen`).
- **`streamStructured`:** the pre hook runs before any stream opens. The post
  hook runs in `finalize`, once, on the completed link's object. A block can
  only stop the FINAL object: the partials were already visible. The row is
  written with the spent tokens and the block is *returned* to the driver,
  not thrown, so the driver can tell policy from a link failure: a block
  never fails over. `object` rejects and the iterator fails with the same
  `GuardrailError`. A transformed final object is published as the last
  partial so a consumer converges on what `object` resolves to.
- **`submitBatch`:** the pre hook runs per item, before the cache pre-check.
  A blocked item is excluded from the batch, reported in `result.blocked`,
  and leaves a zero-token row of its own (trace id
  `batch:guardrail:<slug>:<item id>`) because no other row would carry the
  verdict. Allow/transform verdicts ride the reservation row, one record per
  item, tagged `detail.batchItemId`.
- **`reconcileBatch`:** the post hook runs per schema-valid item. A block
  marks the item `{ ok: false, reason: "guardrail", error }` and the item's
  usage row carries the verdict; the tokens were spent, so the row is billed.
  The job store persists no per-item prompt or input in v1, so the hook sees
  `prompt: ""` and `input: undefined`. A hook that grounds against the input
  (TrustGate's grounder) has nothing to ground against at reconcile and
  should allow; that is a job-store schema change for a later version, not
  a reason to skip output policy now.
- **`embed()` is not a hook path.** There is no prompt and no object; the
  governance it gets is caps, ZDR and the ledger.
- **Allow verdicts may carry `reason` and `detail`** so a hook that computed
  something expensive (TrustGate's confidence blend) can leave it in the
  ledger even when it let the call through.
