# Changelog

Notable changes per release. This project follows [semantic versioning](https://semver.org/).

Still pre-1.0: the store interfaces (`UsageStore`, `PromptStore`,
`ModelConfigStore`, `TaskOverrideStore`, `RateLimiter`, `CacheStore`) are the SPI
adopters implement, and in practice they have only ever gained capability through
*optional* parameters — but they are not yet under a formal semver freeze. 1.0.0
is gated on a downstream integration proving the SPI holds, not on a date.

## 0.12.0

One fix, reported by two independent adoptions (#9, and #28 item 3).

**No breaking changes from 0.11.0.**

### Fixed

- **Pricing accepts prefixed model ids.** Everything else in the library takes a
  scheme-prefixed id — `tasks.defaults`, `ChainLinkConfig.model`, `judge.model`.
  Pricing alone keys on the **bare** id, because that is what a chain link
  carries, and nothing said so.

  An adopter following the convention the README teaches registered
  `"openai:gpt-4.1"`, lookups happened under `"gpt-4.1"`, nothing matched, and
  every call for that model was priced at the fallback estimate rather than the
  real rate. `addPricing`, `hasPricing`, `ProviderConfig.pricing` and the lookup
  now normalise through `parseModelId`, so **both forms work**.

  Only a *recognised provider prefix* is stripped: OpenRouter's `:free`/`:beta`
  variants and slash-scoped vendor ids keep their shape.

- **The missing-pricing warning fires once per model, not once per call**, and
  names the prefixed-key mistake that causes it. The old per-call warning sat on
  a hot path, which in production means drowned out or switched off.

### Added

- **`registry.assertPricingComplete(ids)`** and **`registry.missingPricing(ids)`**
  — a startup or CI preflight. `assertPricingComplete` throws listing everything
  unpriced.

  There is deliberately **no** strict mode inside the cost calculation itself.
  `estimateCostCents` runs inline in the `estimatedCostCents` field of the
  usage-row payload, so throwing there would lose the ledger row for a call that
  already spent money — a wrong cost traded for no record at all. The preflight
  fails at boot, before anything is billed.

### Documented

- The bare-vs-prefixed contract on `ProviderConfig.pricing` and on
  `UsageEntry.provider`/`model` (usage rows keep the split and never rejoin it),
  plus a README section.

## 0.11.0

Two SPI shape gaps closed before a 1.0 freeze would make them expensive to
fix. Both were reported by adopters and independently confirmed by a second
integration (#28).

**No breaking changes from 0.10.0.** Both features are opt-in, and omitting
them behaves exactly as 0.10.0 did.

### Added

- **Spend-cap observe mode** (#8). `caps.mode: "observe"` evaluates every cap
  and records the breach but never throws — for routing real traffic through
  the gateway before you trust your thresholds. Default `"enforce"` is
  unchanged, short-circuit at the first breach included.

  This is not the same as zeroing the caps, which skips the spend sum and the
  cap event entirely and leaves nothing to measure. Observe does the whole
  computation and writes the audit row; only the throw is suppressed.

  `SpendCapEvent.enforced` (nullable) distinguishes "blocked" from "would have
  blocked" — `wouldBlock` is true in both modes, so without it the rows before
  and after flipping the switch are indistinguishable.

- **Caller-defined usage metadata** (#12). `metadata?: Record<string, unknown>`
  on `UsageEntry` and on every call surface that writes rows. For attribution
  the gateway has no opinion on — a background-job run id, a request id — that
  previously had to be dropped by the store adapter, losing granularity the app
  had before it adopted the gateway.

  It reaches every row the call writes, including the easily-missed ones: cache
  hits, the judge's row, and the zero-token row written when an attempt times
  out. The gateway never reads it — not in the cache key, not in routing, not
  in caps.

  Not covered by the `encrypt` hook, which is `inputText`/`outputText` only.
  Keep PII out of it or encrypt it yourself.

### Schema

Additive and nullable, applied in place by `ensureTables` on SQLite and
exported on the pg table defs for drizzle-kit. No backfill:

```sql
ALTER TABLE spend_cap_events ADD COLUMN enforced INTEGER;  -- boolean on pg
ALTER TABLE ai_usage_log     ADD COLUMN metadata TEXT;     -- jsonb on pg
```

## 0.10.0

Timeouts and deadlines, multi-tenancy, and the architecture-critique work.

No type-level breaking changes from 0.9.0, and every feature below is opt-in.
But "opt-in" is not the same as "nothing changes on upgrade" — read the upgrade
notes first if you use the native Anthropic path or `runText` failover.

### Upgrade notes — behavior changes that need no code change to hit you

- **Native Anthropic calls are now bounded at 60s, and this supersedes a
  `timeout` you set on your own client.** Before 0.10.0 the native path had no
  gateway-level bound at all: whatever `timeout` you constructed your
  `@anthropic-ai/sdk` client with was the only clock. It now also races the
  gateway's own `attemptMs` signal (default 60_000), and the shorter one wins —
  so a client built with `timeout: 90_000` and handed to
  `GatewayConfig.anthropic.client` has an effective ceiling of 60s after
  upgrading.

  This is invisible to a test suite: it is a live-latency effect, not a logic
  change, and it surfaces as `AttemptTimeoutError` plus retries under load. If
  your native-path calls legitimately run long (extended thinking, large
  prompt-cached contexts, server-side web search), pin the bound to match what
  you had:

  ```ts
  new Gateway({ ...cfg, timeouts: { attemptMs: 90_000 } });
  await gw.runText({ ...opts, attemptMs: 180_000 }); // or per call
  ```

  The gateway deliberately does not pass the Anthropic SDK's own `timeout`
  (two competing clocks make it ambiguous which aborted a call), so `attemptMs`
  is the single knob for this path.

- **`runText` failover now walks the chain.** See "Changed" below. Failing calls
  that previously threw at the first link now fall through to later ones, which
  costs more and takes longer in the failure case but succeeds where it used to
  throw.

### Added

- **Timeouts and deadlines.** `attemptMs` (one provider attempt, default 60s),
  `deadlineMs` (the whole governed operation, default unbounded),
  `streamFirstChunkMs` and `streamStallMs` (chunk-relative stream clocks), on
  `GatewayConfig.timeouts` and per call. A caller `signal` is now accepted and
  forwarded on every provider path, including embeddings and native Anthropic.
  New errors: `AttemptTimeoutError`, `DeadlineExceededError`, `StreamStallError`.
- **Multi-tenancy.** Optional `orgId` on `GatewayConfig` and per call, scoping
  cache keys, the global circuit breaker, and every store lookup. New
  `caps.orgDailyCents`.

  This closes a gap adopters were already working around rather than adding a
  speculative feature: with no first-class tenant field, integrations were
  repurposing `UsageEntry.userId` to carry a tenant id. If you did that, `orgId`
  is where that value belongs now, and it gets you cache and circuit-breaker
  isolation that a stringified `userId` never provided.
- **Per-task failover chains.** A task's model may now be an ordered chain
  (`TaskModelSpec = string | string[]`) rather than a single id.
- **Mid-stream failover.** `streamStructured` abandons a stalled or retryably
  failing link and restarts on the next. New `StreamStructuredResult.failovers`
  and `observability.onStreamFailover`.
- **First-class judge tier.** `judge` joins `fast`/`power` in `ProviderTiers`,
  with an admin-pinnable `ModelConfigStore.getJudgeModel()`.
- **Voyage embeddings.** `voyage:` model ids are first-class alongside OpenAI,
  with list pricing. New `EMBEDDING_PROVIDER_IDS`, `parseEmbeddingModelId`.
- **`ProviderConfig.requireExplicitDefault`** — throw instead of warn when a call
  falls through to the library's last-resort default provider/model.

### Changed

- Falling through to the library's built-in default provider/model now warns
  loudly (once per registry), naming the assumption and how to configure it.
- Every new failure path writes a zero-token usage row before throwing, so a
  provider call that spent money but never returned still leaves an audit trail.
- `runText` failover now goes through the same `callWithChain` path as
  `runStructured`. **This is the one behavior change since 0.8.0**: `runText`
  previously stopped at the first resolvable link, and now walks the chain on
  retryable errors as `runStructured` always has.
- The `org_id` column is added to `ai_usage_log` and `spend_cap_events` by
  `ensureSchema` on the Drizzle adapters. Nullable, added in place, no backfill.

## 0.9.0

### Security

- Bumped `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai` (2.x → 4.x) and
  `ai` (5.x → 7.x), closing 13 npm-audit advisories rooted in two transitively
  bundled packages: `undici <=6.27.0` (12 advisories, HIGH) and
  `@ai-sdk/provider-utils <=3.0.35` (GHSA-866g-f22w-33x8, moderate). Neither had
  a fix on the bundled major line, so the provider majors were the only route.

### Changed

- `EmbeddingModel` is no longer generic in the AI SDK v7 (`EmbeddingModel<string>`
  → `EmbeddingModel`). This is the only public type that changed shape; callers
  passing a BYO `embeddingModel` may need to drop the type argument.

## Earlier releases

See [ROADMAP.md](./ROADMAP.md), which records what shipped in 0.1.0–0.8.0 and why —
including the v0.6–v0.7 adoption harvest (`runText`, governed embeddings, per-link
temperature) that came from the first production adopter.
