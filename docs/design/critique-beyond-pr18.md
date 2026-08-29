# Beyond PR 18: A Critique of the LLM Governance Gateway

**What the gateway still lacks once the timeout/deadline hardening lands — assessed against the full requirement set, and grounded in CareerPointers as the first proof point for both the gateway-convergence and Scout-extraction tracks.**

| | |
|---|---|
| **Author** | Manus AI |
| **Date** | August 29, 2026 |
| **Gateway version** | [`mpointer/llm-governance-gateway`](https://github.com/mpointer/llm-governance-gateway) @ `989f5af` (v0.9.0), with PR 18 in flight — **see the Addendum (§7) for PRs 19 & 20** |
| **Proof point** | [`futuremeanswered/CareerPointers`](https://github.com/futuremeanswered/CareerPointers) @ `fb252e28` |
| **Companion** | *The Pointer AI Component Architecture*; *FMA LLM Architecture Deep-Dive* |

---

## 1. Framing: Two Tracks, One Proof Point

The architecture is now explicitly **two coordinated tracks**. The **gateway-convergence track** moves each app's LLM execution onto `llm-governance-gateway` as the dependable plumbing. The **Scout-extraction track** lifts the conversational surface into `@pointer/scout`, which routes every generation through the gateway's `Gateway` interface. They are coordinated but independent: Scout depends on the gateway's *interface*, not its concrete adoption, so neither blocks the other.

**CareerPointers is the first proof point for both tracks simultaneously** — and it is an unusually informative one, because it sits between FMA and a greenfield app in maturity. It already has a real AI subsystem (`@pointers/ai`, which its own `package.json` describes as "Mirrors future-me-answered's AI subsystem"), a governed pipeline (`runStructured` with rate limit → spend cap → cache → failover chain → usage log → judge), a three-tier failover chain (`primary`/`fallback`/`backup2` with a `ROLE_ORDER`), live model discovery (`listAllProviderModels`), and a public grounded-Q&A surface (`PortfolioChat`). What it **lacks** is precisely what the two tracks are meant to supply — and where the gateway, even after PR 18, still falls short of supplying it.

This document is a **critique of the gateway's remaining gaps beyond PR 18**, each assessed for whether CareerPointers' adoption would be blocked or merely inconvenienced by it.

---

## 2. What PR 18 Covers (and Therefore Is Out of Scope Here)

PR 18 is a docs-and-design hardening pass on the gateway's **timeout and deadline semantics**. From its design document, it addresses: the single hardcoded 60s timeout covering only 3 of 7 outbound call sites; the absence of any timeout on the native/stream/embed paths; the ledger being written *after* generation so a platform kill loses the audit trail for money already spent ("the deadline covers generation, never the ledger"); and the introduction of per-attempt composed timeouts, wall-clock deadlines, and stream stall clocks.

These are real and necessary. But they are all **within a single call's lifecycle**. PR 18 deliberately does not touch the cross-cutting concerns that determine whether the gateway can serve as *shared* plumbing across multiple apps with different tenants, surfaces, and quality bars. Its own "out of scope" note is the tell: **task-routed calls are single-link, so the first adopter gets zero chain failover from the library.** Everything below is beyond PR 18's remit.

---

## 3. The Gap Analysis

Each gap is stated as a finding, grounded in the gateway source, and rated for its impact on CareerPointers specifically. The ratings: **Blocker** (CareerPointers cannot adopt without it), **Significant** (adoption works but regresses something CareerPointers or the architecture needs), **Minor** (a rough edge).

### 3.1 No multi-tenant org scoping — **Blocker for the shared vision, latent for CareerPointers**

> **RESOLVED — PR #21.** An optional `orgId` now threads through the whole SPI
> (`UsageStore.sumSpendCents`, `PromptStore.getPrompt`/`seedPrompt`,
> `ModelConfigStore.getOverride`/`getChain`, `TaskOverrideStore.getOverrides`),
> the spend-cap accounting (the circuit breaker is evaluated per-tenant, plus
> an optional `caps.orgDailyCents`), the cache key, and every usage and
> spend-cap row. `GatewayConfig.orgId` sets an instance default; per-call
> `orgId` wins. Every widened SPI method takes the tenant as an OPTIONAL
> TRAILING argument, so an existing store implementation remains assignable
> and functional unchanged. Unscoped callers are byte-identical to before —
> the cache key keeps its old shape and the breaker still sums everything.

The gateway has **no concept of an organization or tenant**. A grep for `orgId`/`organizationId`/`tenant` across `src/` returns a single test-fixture comment ("multi-tenant box") and nothing else. The `UsageStore.sumSpendCents` signature scopes spend by `userId` (with `undefined` = global, `null` = anonymous) — there is no org axis. The `ModelConfigStore.getChain()` and `PromptStore.getPrompt(slug)` interfaces take no tenant scope, so a chain or prompt is global to the gateway instance.

FMA's entire LLM control plane is **org-scoped** — `llm_settings`, prompt overrides, and feature flags all resolve per-organization. CareerPointers today is single-tenant (its `runStructured` scopes by `userId` only, matching the gateway), so this does not block *its* adoption. But the stated vision is one gateway serving FMA (org-scoped), CareerPointers, and Newshound. The moment two apps share a gateway instance — or FMA adopts it — the absence of a tenant axis means either (a) each app runs its own gateway instance (losing the shared-ledger and shared-cache benefits), or (b) org scoping is bolted on outside the gateway, re-creating the divergence the extraction was meant to eliminate. **This is the single largest architectural gap between the gateway as-is and the multi-app vision.**

### 3.2 Streaming is single-link with no mid-stream failover — **Significant**

> **RESOLVED — PR #23.** `streamStructured` now resolves a full chain
> (admin pin → task chain → config chain → default), ZDR-filters it, and on a
> stall or retryable mid-stream error advances to the next eligible link and
> continues. The PR 19 stall clocks are preserved per link; a stall is now a
> failover trigger rather than terminal. **Degradation contract**: each link
> restarts the object, so partials are not monotonic across a failover
> (`failovers[].hadPartialOutput` flags when that was visible); an exhausted
> chain surfaces the last link's error on both the iterator and the object
> promise; every attempted link leaves a zero-token ledger row before the
> driver moves on; a caller abort and a non-retryable error are terminal.
> `result.failovers` and an `onStreamFailover` observability hook expose the
> degradation. The governance front door (rate limit, caps, ZDR, ledger) is
> unchanged.

The gateway's `streamStructured` is explicit about its v1 constraint (gateway.ts:697-700): *"no mid-stream failover (the first resolvable link is used; a mid-stream provider error surfaces to the consumer), no repair retry, no judge, no native-Anthropic options."* The governance front door (rate limit, caps, ZDR, ledger) applies, but the resilience machinery does not.

FMA's chat engine has **streaming failover with degradation** — on a mid-stream provider error it fails over and, if all tiers fail, degrades gracefully. CareerPointers' only conversational surface, `PortfolioChat`, is **non-streaming** today (it awaits `answerPortfolioQuestion` and returns JSON), so this does not block CareerPointers *now*. But the Scout-extraction track delivers a streaming chatbot, and the moment CareerPointers adopts Scout, its chat surface becomes streaming — and inherits this single-link constraint. The gateway's streaming path needs the same chain-walking failover `runStructured` already has (the `for (const link of chain)` loop at gateway.ts:1296), plus a stall-clock (which PR 18 adds) and a degradation contract. **This is the gap most likely to bite CareerPointers first, because it arrives exactly when Scout does.**

### 3.3 Task-routed calls are single-link — **Significant, and PR 18's own admission**

> **RESOLVED — PR #22.** A task's model may now be a single id (unchanged) or
> an ordered chain (`["claude-sonnet-4-6", "openai:gpt-4.1", "google:..."]`),
> walked by the same `callWithChain` loop `runStructured`'s main chain uses —
> so a task gets repair retries, transient retries, schema-invalid
> fall-through and timeout ledgering identically. `primary`/`fallback`/
> `backup2` are positions in that array, so the gateway needs no separate
> role vocabulary to express FMA's and CareerPointers' role chains. The
> override store may return a chain too. ZDR now FILTERS the task chain
> rather than hard-failing its first link — previously task routing collapsed
> to one link before the ZDR filter ran. `modelForTask` still returns the head
> of the chain, so adopters comparing the gateway's resolution to their own
> are unaffected.

`runText` resolves a task to **one link** (gateway.ts:581-590): admin override → task model → `chain[0]` → default. Even when a chain is configured, task routing collapses to a single link before the ZDR filter runs. PR 18 flags this as out of scope. The fix the architecture needs is **per-task fallback chains** — a task names an ordered set of models, and the gateway walks it — with FMA's `primary`/`fallback`/`backup2` chain as the walked chain. CareerPointers *does* have a three-role chain (`ROLE_ORDER: primary/fallback/backup2` in its `model.ts`), so it has the chain concept; what it lacks is the gateway walking that chain *per task*. This is a convergence point: the gateway's task routing and FMA's/CareerPointers' role chains should merge into one per-task chain model.

### 3.4 The judge is not a first-class, admin-configurable tier — **Significant**

> **RESOLVED — PR #24.** `judge` is now a named tier alongside `fast`/`power`
> in `ProviderConfig.tiers`, and `ModelConfigStore.getJudgeModel?()` (optional,
> org-scoped) lets an admin pin the judge to a cheap, ZDR-compliant model on a
> DIFFERENT provider than the generation chain — the implicit coupling this
> finding objected to. Resolution is `judge.model ?? adminJudgeModel ??
> judgeDefaults.model ?? default provider's judge tier`, and an unset judge
> tier falls back to that provider's `fast` model, which is the pre-tier
> behavior. No built-in judge model is baked in for any provider (that would
> reintroduce 3.6's bias). The budget-aware and ZDR-aware skips and PR 20's
> failure isolation are unchanged, with tests pinning each; a throwing
> judge-model store degrades to config rather than failing the call.

The gateway's model-graded judge resolves its model as `judge.model ?? judgeDefaults.model ?? registry's default-provider fast tier` (gateway.ts:1638-1646). There is **no dedicated judge tier** in the chain model — the judge borrows the default provider's `fast` model. The architecture's objective 2 names **four** tiers: primary, backup, secondary backup, *and judge*. The gateway models three and treats the judge as an afterthought that happens to share the fast tier.

There is a partial mitigation: the judge is **budget-aware** (skipped if it would cross the global cap) and **ZDR-aware** (skipped if the judge model isn't asserted ZDR when the call requires it, gateway.ts:1652-1660) — both genuinely good. But "judge = default provider's fast tier" is exactly the kind of implicit coupling the no-hardcoded-model objective forbids, and it means an admin cannot independently pin the judge to a cheap, ZDR-compliant model on a *different* provider than the default. CareerPointers' judge, notably, is **not an LLM at all** — its `judgeRubric` is a deterministic function scored in-process (run.ts:431-438, 612-619), so CareerPointers has no judge-model cost or ZDR exposure today. Adopting the gateway's LLM judge would be a *new* capability for CareerPointers — which makes getting the judge tier right a CareerPointers concern, not just an FMA one.

### 3.5 No control plane — the admin surface is a thin HTTP skeleton — **Significant for the vision, not a CareerPointers blocker**

The gateway's admin surface is `src/http/app.ts`: `/health`, `/run`, `/models`, `/tasks`, `/prompt-test`, gated by static `adminTokens`. There is no UI, no prompt-library management, no analytics dashboard, no judge-review surface. This is **by design** — the gateway is plumbing, and the architecture assigns the control plane to the admin interface (which FMA already has and CareerPointers partially has via `/api/admin/ai-models`). So this is not a defect; it is a **boundary that must be held**. The risk is drift: the gateway's `PromptStore`/`ModelConfigStore` interfaces are the SPI the control plane implements, and if the gateway grows its own admin opinions (beyond the read-only `/tasks` and `/prompt-test` it has), it will collide with the app's control plane. CareerPointers' admin surface is currently a single 13-line route listing provider models — far thinner than FMA's — so for CareerPointers the question is whether to adopt FMA-style admin or the gateway's HTTP skeleton; the architecture says the former, with the gateway as the SPI.

### 3.6 The default provider/model is still hardcoded — **Minor, but symbolically important**

`resolveDefault` falls back to `"anthropic"` / `"claude-sonnet-4-6"` (providers.ts:266-278), and `BUILTIN_TIERS` hardcodes per-provider fast/power models (providers.ts:82-88). These are *defaults*, overridable by config and env — so they are not the hardcoded-favoritism bug FMA closed. But they are the same *shape*: an out-of-box bias toward one provider that a careless adopter inherits silently. The deep-dive flagged that wrapping the gateway without neutralizing these defaults would re-open FMA's hardcoded-model bug class. For CareerPointers, which already defaults to Anthropic in its own `MODEL_TIERS`, this changes nothing; for the shared package, the defaults should be **explicitly required config, not silent fallbacks** — fail loudly when no default is configured rather than assume Anthropic.

### 3.7 Embeddings are governed but OpenAI-only — **Minor for CareerPointers, relevant to the shared package**

The gateway's `embed()` runs the full governance front door (rate limit, caps, ZDR, ledger — gateway.ts:371-376), which is correct and matches the principle that "embedding spend is real money." But `buildEmbeddingModel` is **OpenAI-only** (embeddings.ts:50-56): *"v1: OpenAI only — the one provider our adopters embed with today."* Voyage and custom endpoints are deferred to a BYO `embeddingModel` seam. This is the same provider-neutrality gap the deep-dive flagged in FMA (the last hardcoded `text-embedding-3-small`), now present in the shared plumbing. CareerPointers does not currently embed (no vector/RAG pipeline in `packages/ai`), so this is latent for CareerPointers — but the Scout-extraction track's knowledge layer (`scout-knowledge`) needs embeddings, and if CareerPointers adopts Scout's RAG, it inherits the OpenAI-only constraint unless the BYO seam is exercised.

### 3.8 No hedged/parallel fallback — **Minor**

FMA's `openai.ts` has **hedged** fallback (a parallel `Promise.any`-style race across tiers for latency-sensitive paths). The gateway's failover is strictly **sequential** (walk the chain one link at a time). Hedging trades cost for latency; it is appropriate for interactive hot paths and inappropriate for batch. The gateway has no hedging primitive. CareerPointers has no hedging either and no latency-sensitive interactive surface beyond the non-streaming PortfolioChat, so this is Minor for CareerPointers — but it is a capability FMA would lose on the paths where it currently hedges, and a candidate harvest from FMA into the gateway.

---

## 4. Summary Matrix

| # | Gap | Type | CareerPointers impact |
|---|---|---|---|
| 3.1 | No multi-tenant org scoping | Architectural | **Latent** — single-tenant today; blocks the shared multi-app vision |
| 3.2 | Streaming single-link, no mid-stream failover | Resilience | **Arrives with Scout** — PortfolioChat is non-streaming now |
| 3.3 | Task-routed calls single-link | Resilience | **Significant** — CP has chains; gateway won't walk them per-task |
| 3.4 | Judge not a first-class admin tier | Config | **New capability** — CP's judge is deterministic today |
| 3.5 | No control plane (thin HTTP skeleton) | Boundary | **Hold the boundary** — CP should adopt FMA-style admin, gateway as SPI |
| 3.6 | Hardcoded default provider/model | Config hygiene | **None** — CP already defaults to Anthropic; fix for the shared package |
| 3.7 | Embeddings OpenAI-only | Provider neutrality | **Latent** — CP doesn't embed; Scout's RAG would inherit it |
| 3.8 | No hedged fallback | Latency | **Minor** — CP has no hedging need; an FMA harvest candidate |

---

## 5. What This Means for the Two Tracks

**For the gateway-convergence track**, the ordered priorities the critique implies are: (1) **org scoping** — the precondition for the shared multi-app vision, and the thing to design *before* a second tenant forces a bolt-on; (2) **per-task failover chains** — merging the gateway's task routing with the role-chain model both FMA and CareerPointers already have; (3) **streaming failover + degradation** — required before Scout lands on any app; (4) **a first-class judge tier**; (5) neutralizing the hardcoded defaults and broadening embeddings. PR 18's timeout/deadline work is the foundation all of this stands on, but it does not touch any of these five.

**For CareerPointers as the proof point**, the honest readout is encouraging: CareerPointers already has the *shape* of the governed pipeline (it mirrors FMA's), a three-role chain, live model discovery, and a deterministic judge — so its convergence onto the gateway is largely a matter of swapping its `runStructured` internals for the gateway's and implementing the `PromptStore`/`ModelConfigStore` SPI over its existing `@pointers/db` schema. The gaps that would actually bite CareerPointers are **3.3** (its chains won't be walked per-task), **3.2** (when Scout arrives), and **3.4** (if it adopts the LLM judge). The org-scoping gap (3.1) is the one to solve *for* CareerPointers before Newshound joins, so the second tenant never forces a retrofit.

**For the Scout-extraction track**, the takeaway is that Scout's `Gateway` interface is correctly scoped: it lets CareerPointers adopt Scout against its *current* pipeline (satisfying the interface with its own `runStructured`) and swap in the real gateway later — which is exactly the decoupling the two-track strategy requires.

---

## 7. Addendum: PRs 19 & 20 (landed 2026-08-29, after §1–§6 were written)

Two pull requests landed on the gateway hours after this critique was drafted. Both implement the `docs/design/timeouts-and-deadlines.md` design that PR 18 introduced. **Neither changes any gap finding in §3 — they are squarely inside the timeout/deadline scope this critique explicitly carved out in §2 — but two of their details are worth recording because they touch findings 3.2 and 3.3.**

### PR 19 — *bound the three unguarded provider paths* (MERGED 2026-08-29, `7a58917`)

Implements stages S1+S2 of the timeout design. The framing is notable and correct: it is treated as **a ledger bug, not a latency bug** — because the usage row is written *after* generation, a stalled stream left `await stream.object` pending forever, so a provider call that spent money left no audit trail. Every stall test asserts the ledger row, not just the throw.

- **S1 (streaming & embeddings):** `streamStructured` gains first-chunk and inter-chunk stall clocks (default 60s each, `0` disables); a stall writes a **zero-token usage row before throwing** `StreamStallError`. `embedMany` gains an `abortSignal` (the AI SDK's own `maxRetries` is deliberately left at default, since `embed()` has no gateway-level retry loop).
- **S2 (native Anthropic parity):** the native client gains an optional second `options` parameter — **non-breaking** for one-argument BYO clients — so both native calls carry the same 60s bound the AI SDK paths always had.

*Relevance to the critique:* this **partially mitigates finding 3.2 (streaming)**. The stall clock closes the "stalled stream hangs forever and leaves no ledger row" failure — the availability/audit half of the streaming gap. It does **not** add mid-stream failover: a stall now throws `StreamStallError` to the consumer rather than failing over to the next link. So 3.2 stands, narrowed from "no timeout, no failover" to "timeout yes, failover no."

### PR 20 — *whole-operation deadlines and configurable attempt bounds* (OPEN at time of writing, not yet merged)

Implements S3+S4, completing the design. `AttemptBudget` with a `MIN_ATTEMPT_MS` floor; `timeouts.attemptMs` config (default 60s, no behavior change); `deadlineMs` bounding every chain link, retry, and backoff sleep in one call (default `undefined` = unbounded); abortable backoff sleeps clamped to remaining budget; `DeadlineExceededError` terminal; timed-out attempts ledgered as zero-token rows.

Three details matter to the critique:

1. **It directly addresses finding 3.3 (task-routed calls).** The PR body states: *"Only the chain path ledgered timed-out attempts. The single-link paths (task routing, admin override) have no chain loop to catch them — and task routing is the shape NewsHound uses for every call, so that would have been the one path where a timed-out attempt left no audit trail. Fixed, with a test specifically on the task-routed path."* This is the audit/ledger half of 3.3 — but it is about **ledgering** single-link timeouts, **not** about giving task routing a failover chain. Task-routed calls remain single-link; 3.3 stands.
2. **A behavior change to `runText` failover** worth a release note: `runText` now advances only on retryable errors and attempt timeouts (matching `callWithChain`), so *"a non-retryable error such as a 400 no longer burns a call on the next provider."* This is the correct failure-classification behavior the deep-dive recommended.
3. **A judge-hardening detail** relevant to finding 3.4: giving the judge its own budget was insufficient because a judge timeout would still propagate out of `runJudge` and fail the main response — *"making a governance check the thing that breaks the request it was watching."* `runJudge` now catches and skips, matching its behavior under spend pressure. This hardens the judge's *failure isolation* but does not make it a first-class admin-configurable tier; 3.4 stands.

### Net assessment

PRs 19 & 20 are **exactly the timeout/deadline hardening this critique scoped out in §2**, executed well (153 tests passing, up from 134; the ledger-first framing is the right one). They **narrow findings 3.2 and 3.3 on the audit/availability axis** — stalled streams and single-link timeouts now leave a ledger row and throw promptly — **without closing the resilience axis** (no mid-stream failover, no per-task failover chain). **No gap finding in §3 is resolved; the ordered priorities in §5 are unchanged.** The one action item they create is a **release note for the `runText` failover behavior change** (400s no longer advance the chain), since that alters default behavior adopters may have relied on.

| Finding | Before PR 19/20 | After PR 19/20 | Still open? |
|---|---|---|---|
| 3.1 Org scoping | Absent | Absent | **Yes — unchanged** |
| 3.2 Streaming failover | No timeout, no failover | Stall clock + ledger row; still no failover | **Yes — narrowed** |
| 3.3 Per-task chains | Single-link, no timeout ledger | Single-link, timeout now ledgered | **Yes — narrowed** |
| 3.4 Judge tier | Borrows fast tier; timeout could fail main call | Borrows fast tier; timeout now isolated | **Yes — narrowed** |
| 3.5 Control plane | Thin HTTP skeleton | Unchanged | **Yes — unchanged** |
| 3.6 Hardcoded defaults | `anthropic`/`claude-sonnet-4-6` | Unchanged | **Yes — unchanged** |
| 3.7 Embeddings OpenAI-only | OpenAI-only | Unchanged (gains abortSignal) | **Yes — unchanged** |
| 3.8 No hedging | Sequential only | Unchanged | **Yes — unchanged** |

---

## 8. References

1. [mpointer/llm-governance-gateway](https://github.com/mpointer/llm-governance-gateway) @ `989f5af` — all gateway findings verified against this tree on 2026-08-29
2. [futuremeanswered/CareerPointers](https://github.com/futuremeanswered/CareerPointers) @ `fb252e28` — all CareerPointers findings verified against this tree on 2026-08-29
3. [mpointer/future-me-answered](https://github.com/mpointer/future-me-answered) @ `dbe6c688` — the org-scoped control plane and hedged/streaming failover the gateway is compared against
4. Gateway PR 18 (in flight) — the timeout/deadline hardening this critique explicitly scopes out
5. *The Pointer AI Component Architecture* (Manus AI, 2026-08-29) — the two-track strategy and the control-plane/data-plane split
6. *FMA LLM Architecture Deep-Dive* (Manus AI, 2026-08-29) — the 10-objective assessment establishing the four-tier model and the hardcoded-model bug class
