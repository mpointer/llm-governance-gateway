# Design: Governed Batch Processing

Status: DRAFT — target v0.3/v0.4. Derived from a production batch pipeline
(LocalNewsBuddy) that has run Anthropic Message Batches for menu extraction,
place enrichment, and translation at scale.

## Why batch belongs in a governance library

Batch APIs are a 50% cost lever — that IS governance. But batch also breaks
every assumption the synchronous pipeline makes: results arrive hours later,
spend commits at submit time, and schema validation can't repair-and-retry
inline. Doing this right means designing for those differences, not bolting
`generateObject` onto a queue.

## Production lessons being ported (evidence, not theory)

1. **DB-tracked jobs, not fire-and-forget.** The source system uses a
   `batch_jobs` table (unique `batch_id`, `status`, `type`, indexed) with a
   poll loop. Crash between submit and reconcile must not orphan spend.
2. **`custom_id` correlation.** Every item carries a caller ID; results
   arrive unordered and possibly partial.
3. **Stream results, don't buffer.** Large result sets are JSONL; the source
   system streams over HTTP/1.1 specifically because undici HTTP/2 stream
   errors killed large batch fetches. Port this workaround.
4. **Self-healing loops.** Batch-driven enrichment marks items done even on
   permanent failure so the next batch can't spin on the same candidates.

## API sketch

```ts
const job = await gw.submitBatch({
  task: "menu_extract",               // task routing decides the model
  items: [{ id, slug, schema, variables }, ...],
});
// Governance AT SUBMIT: rate limit, spend cap against ESTIMATED cost
// (prompt tokens × batch rate), cache pre-check (cached items are served
// immediately and excluded from the submitted batch).

const status = await gw.pollBatch(job.id);   // cron/queue-friendly
// On "ended": stream results, Zod-validate each item, log usage per item
// (batch: true, discounted rates), record item-level failures.

for await (const r of gw.batchResults(job.id)) {
  // { id, ok: true, object } | { id, ok: false, error, reason }
}
```

## Adapters

- `BatchJobStore` — createJob / transition(status) / getJob / listOpen.
  Reference Drizzle implementations (sqlite + pg), mirroring `batch_jobs`.
- `BatchClient` — submit / check / streamResults. Anthropic Message Batches
  first (this arrives WITH the native-Anthropic v0.3 work since it needs the
  native SDK); OpenAI Batch API second. BYO-client seam for tests, exactly
  like `ChainLinkConfig.languageModel`.

## Hard requirements (the "unimpeachable" list)

- **Spend accounting is two-phase**: reserve estimated cost at submit
  (counts against caps immediately — a submitted batch is committed money),
  reconcile to actual usage per item at result time. No double count, no
  orphaned reservation on expiry/cancel.
- **Idempotent reconcile**: re-running result processing after a crash must
  not duplicate usage rows (unique on `batch_id` + `custom_id`).
- **Expiry semantics**: Anthropic batches expire in 24h; expired/canceled
  items release their reservation and surface as `ok: false, reason:
  "expired"` — never silently dropped.
- **No inline repair**: schema-invalid batch items are flagged with the
  validation error; callers choose requeue-in-next-batch or sync fallback
  (`runStructured` with the failover chain). The library never silently
  re-runs batch items at sync prices.
- **Deterministic CI**: fake BatchClient fixtures for partial results,
  out-of-order results, expiry, malformed JSONL lines, and crash-between-
  submit-and-reconcile. Zero keys, zero network.
- **Cost model**: per-provider batch discount multiplier (default 0.5 for
  Anthropic), integrated with the cache-aware token rates work.

## Decisions

- **Submit-time reservation: estimate by default, optional hard ceiling.**
  (Decided 2026-07-23.) Reservation = estimated prompt tokens × batch rate,
  plus a bounded output allowance. Callers may set `maxCostCents` per job as
  a hard ceiling — submit fails fast if the estimate exceeds it. The docs
  MUST call out prominently that the default reservation is an ESTIMATE:
  actual reconciled spend can exceed it (long outputs), so the ceiling — not
  the estimate — is the guarantee. Estimation accuracy gets a dedicated test
  fixture comparing reserved vs reconciled across realistic workloads.

## Open questions

- Judge sampling on batch results: same rubric path as sync, sampled — cheap
  to add once judge-in-path (v0.3) lands. Sequence judge first.
```
