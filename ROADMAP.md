# Roadmap

Positioning: **the governance layer LLM proxies promised, as a TypeScript library you can read.** In-process — no sidecar proxy to deploy, no new attack surface, minimal dependency tree. Type-safe from Zod schema to failover chain to spend cap.

Three things no popular tool combines today, all shipped here:

1. **Spend caps that actually block** — per-user daily caps plus a global circuit breaker, enforced in-process against your own database (not observed after the fact, not gated behind a hosted control plane).
2. **Schema-validated failover** — provider chains for `generateObject`, an [open](https://github.com/vercel/ai/issues/9950) [pain point](https://github.com/vercel/ai/issues/9002) in the AI SDK.
3. **Deterministic CI for the whole pipeline** — mock the provider, keep the governance: caps, cache, failover, and judge all run in tests with zero keys.

## v0.2 (announcement-ready)

- [x] CI (typecheck + tests on PR), npm publish workflow with provenance
- [x] Live smoke script (validated on anthropic, openai, openrouter)
- [x] Schema-validation-aware failover: shipped in 0.1.0 (repair retry + chain fall-through)
- [x] `examples/` — Node, Next.js server action, Worker HTTP
- [x] README positioning rewrite around governance + supply-chain posture

## v0.3

- [x] **Judge-in-the-request-path with budget-aware sampling** — shipped: sampled model-graded scoring, cap-aware self-skip, observe/gate modes, audit-first gating
- [x] Native Anthropic path — shipped: BYO @anthropic-ai/sdk client, adaptive/budgeted thinking, cache_control, server-side web search, cache-token cost accounting, cross-path failover
- [x] **Governed batch processing** — shipped: two-phase reservation/release, cache pre-check, maxCostCents ceiling, idempotent reconcile, per-item schema validation. Design: [docs/design/batch-processing.md](./docs/design/batch-processing.md)
- [x] Cache-aware cost model — shipped with the native path (cacheWrite/cacheRead rates, web-search per-call pricing)
- [x] Streaming — shipped: streamStructured with the full governance front door (v1: no mid-stream failover/judge/native)

## Shipped via adoption harvest (v0.6–v0.7)

These weren't planned here; they were demanded by the first production
adopter and flowed back within days. That loop is the project's real
development model, so it gets recorded alongside the plan:

- [x] `runText` — governed plain-text generation (v0.6.0): the adopter's
      seam was text-first; same front door, chain failover, finishReason
      surfaced for truncation diagnostics
- [x] Token counts on `RunTextResult` (v0.6.0) — first-adopter feedback,
      same day
- [x] `default` export conditions (v0.6.0) — drizzle-kit's CJS resolver
      couldn't load import-only subpath exports
- [x] Governed embeddings `gw.embed()` (v0.7.0) — embedding spend was
      bypassing the ledger and caps entirely in the adopter's doc pipeline
- [x] Per-link temperature `number | null` (v0.7.0) — claude-sonnet-5
      rejects non-default temperature; per-call temperature couldn't express
      per-link tolerance

## v0.4+

- [x] OTel / Langfuse export hooks — shipped: `GatewayConfig.observability` (onUsage / onSpendCapEvent / onJudgeScore, fire-and-forget after durable writes) plus `toOtelAttributes` mapping to the GenAI semantic conventions. No new dependencies.
- [x] Together.ai + Hugging Face providers (#1) — shipped: first-class ids, discovery, Together pricing sync
- [x] Local serving (#3) — shipped: custom OpenAI-compatible endpoint registry, ollama/vllm/lmstudio presets, zero-cost cap exclusion, local-first chains
- [x] Enterprise providers (#2) — shipped: provider-factory registry (BYO cloud SDK, zero new deps), factory: chain links, recipes for all four clouds incl. watsonx IAM refresh. Design: [docs/design/enterprise-providers.md](./docs/design/enterprise-providers.md)
- [x] ZDR-aware routing (#4) — shipped: caller-asserted retention map (fail closed), task/call constraints, chain skip, zdrEnforced audit field, judge/stream/batch enforcement
- [x] OpenRouter pricing auto-sync — shipped: discovery registers vendor pricing into the registry
- [x] Web-search-grounded `runText` — shipped: `runText({ anthropic: { webSearch } })` runs the native text path (no emit tool, text blocks concatenated, stop_reason mapped to AI SDK vocabulary), web searches ledgered and priced, failover to plain AI SDK links preserved. Demand source: civic-data-adapters' discovery callback.
- [x] Docs: local-bootstrap publish guide — shipped: [docs/publishing.md](./docs/publishing.md), the first-publish bootstrap sequence with both traps written down
- [ ] Pluggable guardrail hooks (pre/post) — TypeScript-native, no Python sidecar. Design: [docs/design/guardrail-hooks.md](./docs/design/guardrail-hooks.md); gated on real adopter demand (FMA crisis pipeline is the likely trigger)
- [ ] Admin UI reference (prompt library, task routing, spend dashboards) — design: [docs/design/admin-ui-reference.md](./docs/design/admin-ui-reference.md); sequenced after the Show HN wave, informed by external-adopter issues
- [x] Timeouts and deadlines — shipped S1–S4: chunk-relative stream stall clocks, `abortSignal` on every provider path, native-Anthropic parity, configurable `attemptMs`, whole-operation `deadlineMs` (unbounded by default) across links/retries/backoff, aborted attempts ledgered as zero-token rows, and `runText` failover aligned to `callWithChain`. Framed as ledger correctness, not latency: the usage row is written after generation, so anything that kills a call mid-flight loses the audit trail for money already spent. Design: [docs/design/timeouts-and-deadlines.md](./docs/design/timeouts-and-deadlines.md)

## v0.10 — architecture critique (findings 3.1-3.8)

An external critique of the post-timeouts design named eight gaps. Six are
closed, one PR each, under a hard backward-compatibility constraint: every
change is opt-in or default-preserving. Two were deliberately not closed —
see below; that is a decision, not a backlog.

- [x] **3.1 Multi-tenant org scoping** (#21) — optional `orgId` scoping cache
      keys, the global circuit breaker, and every store lookup. Unscoped cache
      keys keep their original bytes, so upgrading doesn't cold-start a cache.
- [x] **3.2 Streaming mid-stream failover** (#23) — a stalled or retryably
      failing link is abandoned and the next one restarts the object. The
      degradation contract (partials are not monotonic across a failover) is
      documented rather than hidden, and `onStreamFailover` reports it.
- [x] **3.3 Per-task failover chains** (#22) — `TaskModelSpec = string | string[]`.
      The array form is the primary/fallback/backup role chain adopters already
      model, with roles as positions, so no new role vocabulary was needed.
- [x] **3.4 First-class judge tier** (#24) — `judge` joins fast/power, pinnable
      by an admin via `getJudgeModel()`. The judge runs on its own budget and a
      judge failure can never fail the response it was scoring.
- [x] **3.6 Neutralize hardcoded defaults** (#25) — falling through to the
      library's built-in provider/model warns loudly once;
      `requireExplicitDefault` upgrades it to a throw. Resolved as "warn loudly,
      strict mode opt-in" rather than the critique's "fail loudly", because the
      backward-compatibility constraint outranked it.
- [x] **3.7 Broaden embeddings** (#25) — Voyage as a first-class embedding
      provider with list pricing, plus `parseEmbeddingModelId` so embedding-only
      providers can't be mis-attributed to a chat provider.

### Deliberately not closed

- **3.5 No control plane** — *held, not deferred.* The gateway is plumbing: its
  `PromptStore`/`ModelConfigStore`/`UsageStore` interfaces are the SPI an
  application's control plane implements, and the thin HTTP skeleton
  (`/health`, `/run`, `/models`, `/tasks`, `/prompt-test`) is the whole intended
  surface. Growing an admin UI or prompt-management surface here would collide
  with the adopting app's own control plane. This finding names a boundary to
  hold, not a gap to fill.
- **3.8 No hedged/parallel fallback** — *deferred.* Failover is strictly
  sequential. Hedging (racing links in parallel) trades cost for latency: right
  for an interactive hot path, wrong for batch, and a spend-governance library
  should not race two paid calls by default. A candidate harvest once an adopter
  has a latency-sensitive surface that needs it.

Design and resolution log: [docs/design/critique-beyond-pr18.md](./docs/design/critique-beyond-pr18.md)

## v0.11 — second-integration harvest

A second real consumer (NewsHound) migrated 0.8.0 → 0.10.0 and filed #28.
Nothing in it was a type-level SPI break — the store interfaces held — but it
independently confirmed three gaps already filed from a different adoption.
Two of those are *shape* gaps in the SPI, which a 1.0 freeze would make
expensive to fix, so they were closed first:

- [x] **Spend-cap observe mode** (#8, PR #30) — `caps.mode: "observe"` measures
      what your thresholds would have blocked without blocking. Replaces the
      zero-cap workaround, which recorded nothing.
- [x] **Caller-defined usage metadata** (#12, PR #31) — attribution along an
      axis the gateway has no opinion on, reaching every row a call writes.
- [x] **Upgrade-note correctness** (#28 item 5, PR #29) — the native-Anthropic
      `attemptMs` bound supersedes a caller's own client `timeout`, which the
      0.10.0 changelog's "no breaking changes" framing did not surface.

Still open from #28, unchanged in priority: #9 (pricing lookup falls back
silently on a key-format mismatch — the fix is the loud-warning-plus-strict-mode
treatment 0.10.0 already gave the analogous default-provider case).

### On 1.0.0

The freeze is gated on a real integration proving the store interfaces hold,
not on a date. #28 is that evidence and it came back clean: no type-level
breaks across a second adopter. What it also showed is that *shape* gaps are
the real 1.0 risk, which is why #8 and #12 landed first.

## Non-goals

- Observability breadth (traces, dashboards, analytics) — export to Langfuse/OTel instead.
- Being a universal proxy for 100+ providers — LiteLLM exists; this is a governance library first.
- Hosted control plane — self-host is the point. (A managed offering may come later; the library stays complete without it.)
