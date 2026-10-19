# Design: pluggable guardrail hooks (pre/post)

Status: shipped in 0.16.0 (`src/guardrails.ts`, `src/trustgate.ts`). The
shape below is what shipped, with the open questions answered at the end.

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
- **Streaming, batch and `runText`:** excluded in this version, as the open
  questions suggested. Streaming needs buffering or chunk-level policy; batch
  reconcile-time checks double the per-item cost; both are decisions for an
  adopter with the need. `runText` is a small addition when someone asks.
- **Cache hits skip the hooks.** The cached object was produced under the
  guardrails in force when it was written. A pre policy that depends on the
  caller rather than the prompt needs `cache: false`.
- **Allow verdicts may carry `reason` and `detail`** so a hook that computed
  something expensive (TrustGate's confidence blend) can leave it in the
  ledger even when it let the call through.
