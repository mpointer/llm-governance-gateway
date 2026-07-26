# Design: pluggable guardrail hooks (pre/post)

Status: proposed. Not scheduled until a real adopter demand lands (the
harvest rule: features enter from production need, not speculation).

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
