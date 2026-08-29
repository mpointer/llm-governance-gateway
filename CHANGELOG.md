# Changelog

Notable changes per release. This project follows [semantic versioning](https://semver.org/).

Still pre-1.0: the store interfaces (`UsageStore`, `PromptStore`,
`ModelConfigStore`, `TaskOverrideStore`, `RateLimiter`, `CacheStore`) are the SPI
adopters implement, and in practice they have only ever gained capability through
*optional* parameters — but they are not yet under a formal semver freeze. 1.0.0
is gated on a downstream integration proving the SPI holds, not on a date.

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
