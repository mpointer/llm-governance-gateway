# llm-governance-gateway

**The governance layer LLM proxies promised as a TypeScript library you can read.**

Every call runs through one governed pipeline:

```
rate limit → spend caps (per-user + global circuit breaker) → cache
→ schema-validated provider failover → usage log → LLM-judge
```

No sidecar proxy to deploy. No hosted control plane. No sprawling dependency tree and five runtime deps (the [Vercel AI SDK](https://sdk.vercel.ai), three provider adapters, Zod), everything else optional peers. It runs *in your process*, enforces caps against *your* database, and the whole pipeline from caps, cache, failover, to judge, runs deterministically in CI with zero API keys.

Providers: Anthropic, Google, OpenAI, OpenRouter, Venice, Together.ai, Hugging Face, plus self-hosted endpoints (Ollama, vLLM, LM Studio, or any OpenAI-compatible server) and enterprise clouds (Bedrock, Azure, Vertex AI, watsonx.ai) via BYO-SDK [provider factories](./examples/enterprise-recipes.md), all mixable in one failover chain.

## Why

Spend controls in this space are usually observed (dashboards that tell you *after* the money is gone) or enforced by infrastructure you must operate and trust (proxies, gateways, hosted control planes). This library takes the third path: governance as code in your own runtime, checked before every call, type-safe from Zod schema to spend cap.

- **Spend caps that actually hold.** Per-user daily caps plus an app-wide daily circuit breaker, checked against your usage store before every call. Unset ≠ uncapped: defaults are conservative, and only an explicit `0` opts out.
- **Schema-validation-aware failover.** primary → fallback → backup providers, with 429/5xx-aware retries, `Retry-After` honoring, and equal-jitter backoff. When a model returns schema-invalid output, the validation error is fed back for one repair attempt, then the chain falls to the next provider. A different model often satisfies the schema where the first couldn't ([vercel/ai#9950](https://github.com/vercel/ai/issues/9950), [#9002](https://github.com/vercel/ai/issues/9002)). Chain links accept bring-your-own AI SDK models (Azure, Bedrock, custom base URLs).
- **Deterministic CI.** Mock mode replaces providers with registered responders so your AI-dependent test suite runs offline with zero keys.
- **Prompt library pattern.** Store-as-override, code-as-fallback: admins can edit prompts at runtime; a broken edit (missing `{{placeholder}}`) falls back to the code default instead of silently sending a malformed prompt.
- **Judge in the request path — sampled and budget-aware.** Model-graded rubric scoring runs inline (not offline, not async-later): define criteria, sample a fraction of calls, and optionally *gate* low-scoring responses. The judge skips itself when its estimated cost would cross the global spend cap — a governance check never blows the budget — and gated responses still persist their scores for audit. Plus a free caller-computed rubric and full usage accounting (tokens, cost, latency, trace IDs) with an optional at-rest encryption hook.
- **Task-based routing.** Name your call sites (`"enrich"`, `"dedup_judge"`, `"editorial"`), assign each a default model in code, and let an admin store override models per task at runtime — with TTL caching and graceful degradation to code defaults when the store is down.
- **Live model discovery.** `listAllProviderModels()` queries each vendor's models API for every provider with an API key configured; keyless or erroring providers fall back to static lists so admin UIs stay usable offline.
- **Prompt test runs.** `runPromptTest()` executes an edited (even unsaved) prompt body with sample variables against any model, bypassing the cache but *not* usage logging.  The test spend shows up in the cost dashboard under `admin:prompt-test`.

## Quickstart

```ts
import { z } from "zod";
import { Gateway, MemoryUsageStore } from "llm-governance-gateway";

const gw = new Gateway({
  usage: new MemoryUsageStore(),
  promptDefaults: [
    {
      slug: "summarize",
      body: "Summarize in one sentence:\n\n{{text}}",
      variables: ["text"],
    },
  ],
  providers: { apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } },
  caps: { userDailyCents: 200, globalDailyCents: 5000 },
});

const { object } = await gw.runStructured({
  slug: "summarize",
  schema: z.object({ summary: z.string() }),
  input: { text: "..." },
  variables: (i) => ({ text: i.text }),
  cacheParts: ["..."], // or cache: false for PII-bearing calls
  userId: "user-123",
});
```

### API key setup

```bash
npx llm-gateway init     # guided key entry → .env.local (chmod 600)
npx llm-gateway doctor   # validate every configured key against the provider's live models API
```

Keys resolve in order: `ProviderConfig.apiKeys` (programmatic) → shell env → `.env.local` / `.env` (loaded by the CLI and smoke script via `loadEnvFiles()`; call it yourself in dev servers if you want file-based keys there too). This is deliberately not a secrets manager because production keys belong in your deploy platform's secret store.

One honest limit: `doctor` validates keys against each provider's *models* API. Providers with scoped keys (Venice separates inference from admin keys, for example) can pass `doctor` yet 401 on generation — a generation-level smoke test is the stronger check.

### Testing without API keys

```ts
const gw = new Gateway({ usage, promptDefaults, mock: true });
gw.registerMockResponder("summarize", () => ({ summary: "stub" }));
```

### Production storage

Reference `UsageStore` implementations ship for Drizzle ORM (optional peer dependency):

```ts
// SQLite / libSQL / Turso (also better-sqlite3, D1, sql.js)
import { DrizzleSqliteUsageStore, ensureTables } from "llm-governance-gateway/drizzle-sqlite";
const store = new DrizzleSqliteUsageStore(db);
await ensureTables(db); // dev quick-start; use drizzle-kit migrations in prod

// PostgreSQL (node-postgres, postgres.js, neon, vercel)
import { DrizzlePgUsageStore } from "llm-governance-gateway/drizzle-pg";
```

Both export their table definitions (`aiUsageLog`, `spendCapEvents`, `aiJudgeScores`) — re-export them from your schema file so `drizzle-kit generate` produces migrations. Or implement `UsageStore` yourself over any database (four methods — see `src/types.ts`).

Pass Redis-backed cache/rate limiting for multi-instance deployments:

```ts
import { Redis } from "@upstash/redis";
import { RedisCacheStore, RedisRateLimiter } from "llm-governance-gateway";

const redis = Redis.fromEnv();
const gw = new Gateway({
  usage: myDrizzleUsageStore,
  cache: new RedisCacheStore(redis),
  rateLimiter: new RedisRateLimiter(redis, 20, 60),
});
```

`RedisLike` is a four-method interface (`get/set/incr/expire`) — `@upstash/redis` satisfies it directly; ioredis needs a thin wrapper. The package has no hard Redis dependency.

### Multi-tenancy (optional)

`orgId` scopes a call to one tenant. **It is entirely optional** — omit it everywhere and the gateway behaves exactly as it did before tenancy existed, down to the cache-key bytes. Single-tenant apps can skip this section.

```ts
// One instance serving one tenant:
const gw = new Gateway({ usage, orgId: "acme" });

// One instance serving many — per-call wins over the config default:
await gw.runStructured({ ...opts, orgId: "acme" });
```

What `orgId` scopes, once present:

| Surface | Scoped behavior |
|---|---|
| Cache keys | `aicache:org:<org>:<slug>:<hash>` — one tenant can never read another's cached completion |
| Global circuit breaker | Evaluated against **that org's** spend only; one tenant can't trip another's breaker |
| `caps.orgDailyCents` | Optional per-org daily cap, on top of per-user caps |
| `PromptStore`, `ModelConfigStore`, `TaskOverrideStore` | Receive `orgId` so prompts, chains and task routing can differ per tenant |
| `UsageStore` | Rows and cap events carry `orgId`; `getSpendToday` scopes the sum |

**Why it's non-breaking.** The store SPIs take `orgId` as an *optional trailing parameter*, and in TypeScript a function of fewer parameters is assignable to a type declaring more — so an existing `getChain: async () => [...]` still compiles and still passes. Unscoped cache keys keep their original `aicache:<slug>:<hash>` form, so upgrading doesn't cold-start your cache. The `org_id` column is nullable and added in place by `ensureSchema`, with no backfill.

The one thing that isn't opt-out is the column existing: on the Drizzle adapters `ensureSchema` adds a nullable `org_id` to `ai_usage_log` and `spend_cap_events` whether or not you use tenancy.

### Failover chains and tiers

Provide a `ModelConfigStore` (e.g. an admin-editable table) to control routing at runtime:

```ts
const gw = new Gateway({
  usage,
  modelConfig: {
    getOverride: async () => null, // hard-pin escape hatch
    getChain: async () => [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "openai", model: "gpt-4.1" },
    ],
  },
});

// tier: "fast" re-routes every chain link to its provider's cheapest model
await gw.runStructured({ ...opts, tier: "fast" });
```

**Configure your own default.** A call with no chain, no task and no override falls through to a last-resort default baked into the library. That fallback exists so the quickstart works, not as a recommendation — inheriting it means this library, rather than your deployment, picked your model and your vendor. Reaching it warns loudly once, naming the assumption. Set your own:

```ts
providers: { defaultProvider: "openai", defaultModel: "gpt-4.1" },
// or AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL in the environment
providers: { requireExplicitDefault: true }, // upgrade the warning to a throw
```

Config or env overrides silence the warning entirely. `requireExplicitDefault` is off by default so existing callers are unaffected.

### Timeouts and deadlines

Every outbound provider call is bounded. The framing is **ledger correctness, not latency**: the usage row is written *after* generation returns, so anything that kills a call mid-flight loses the audit trail for money already spent.

```ts
const gw = new Gateway({
  usage,
  timeouts: {
    attemptMs: 30_000,          // bound on ONE provider attempt. Default 60s.
    deadlineMs: 25_000,         // bound on the WHOLE call. Default: unbounded.
    streamFirstChunkMs: 60_000, // time to a stream's first emission. 0 disables.
    streamStallMs: 60_000,      // time since a stream's last emission. 0 disables.
  },
});

// Per call, and a caller signal for request teardown / client disconnect:
await gw.runStructured({ ...opts, attemptMs: 10_000, deadlineMs: 20_000, signal });
```

Precedence is the same as every other knob: per call → config → built-in default.

**`attemptMs` vs `deadlineMs`.** An attempt timeout means *this link is slow* — the chain advances to the next provider. A blown deadline means *the whole operation is over* — no further links, no retries, terminal. Keeping them distinguishable is why the gateway composes abort signals by hand instead of using `AbortSignal.any([AbortSignal.timeout(ms), signal])`; that composite reports a bare `DOMException` and [can silently never fire](https://github.com/nodejs/node/issues/57736).

Set `deadlineMs` on any platform with its own function deadline. A three-link chain with retries can otherwise run for minutes, and a platform kill takes the usage row with it. Unbounded is the default only because it preserves pre-existing behavior.

**Streaming uses chunk-relative clocks**, not a total-duration cap: a long stream that is actively producing tokens is healthy, and killing it at N seconds would be a regression. Silence is what is never healthy. Note these clocks measure *parsed partial objects*, not raw provider chunks — a model that has emitted `{"ans` has produced no partial yet, which is why the default window is a generous 60s.

**Aborted attempts are ledgered.** Every timeout path writes a zero-token usage row before it throws, so a provider call that spent money but never returned still leaves an audit trail. Three error classes carry the diagnosis: `AttemptTimeoutError`, `DeadlineExceededError`, and `StreamStallError` (with `phase: "first-chunk" | "stall"`). A caller-initiated abort rethrows your own reason unwrapped — the gateway never disguises your cancellation as its own timeout.

### Task-based routing

Model ids use a scheme prefix; bare ids are Anthropic: `"claude-opus-4-8"`, `"openai:gpt-4.1"`, `"google:gemini-2.5-pro"`, `"openrouter:meta-llama/llama-3.3-70b"`, `"venice:mistral-31-24b"`.

```ts
const gw = new Gateway({
  usage,
  tasks: {
    defaults: {
      enrich: "claude-haiku-4-5-20251001",   // high volume, low reasoning
      editorial: "claude-opus-4-8",           // long-form quality
      translate: "google:gemini-2.0-flash",
    },
    store: myAdminOverrideStore, // optional: { getOverrides(): Promise<Record<string,TaskModelSpec>> }
  },
});

await gw.runStructured({ ...opts, task: "enrich" });
```

Precedence: `modelConfig.getOverride()` → `task` → chain → static default.

**Per-task failover chains.** A task's model can be a single id *or* an ordered chain the gateway walks on retryable errors and attempt timeouts:

```ts
defaults: {
  enrich: "claude-haiku-4-5-20251001",              // single model
  editorial: [                                       // primary → fallback → backup2
    "claude-opus-4-8",
    "openai:gpt-4.1",
    "google:gemini-2.5-pro",
  ],
},
```

The array form *is* the primary/fallback/backup role chain, with roles expressed as positions — so there's no separate role vocabulary to learn. The single-id form is unchanged and a store returning it stays assignable.

### Model discovery

```ts
import { listAllProviderModels } from "llm-governance-gateway";

// Every provider with a key: live model list from the vendor's models API.
const models = await listAllProviderModels(gw.registry);
// [{ provider: "anthropic", models: [...], source: "api", configured: true }, ...]
```

### Prompt test runs

```ts
const res = await gw.runPromptTest({
  slug: "summarize",
  body: "Summarize as haiku:\n\n{{text}}",   // unsaved editor draft
  variables: { text: "sample input" },
  model: "openai:gpt-4.1-mini",              // or task: "enrich", or omit for default
  userId: "admin-id",
});
// res.text, res.costCents, res.durationMs — spend logged as route "admin:prompt-test"
```

### Local / self-hosted endpoints

Ollama, vLLM, and LM Studio work zero-config via localhost presets; any OpenAI-compatible server works via the endpoint registry:

```ts
const gw = new Gateway({
  usage,
  providers: { endpoints: { gpubox: { baseURL: "http://gpu:8000/v1", apiKeyEnv: "VLLM_KEY" } } },
  modelConfig: {
    getOverride: async () => null,
    getChain: async () => [
      { endpoint: "gpubox", model: "qwen2.5-72b" },              // local first
      { provider: "anthropic", model: "claude-sonnet-4-6" },     // cloud fallback
    ],
  },
});
// Task ids too: defaults: { summarize: "ollama:llama3.3" }
```

Endpoint tokens are logged but cost $0 and never count against spend caps — caps are about real money. A flaky local vLLM gets the same schema-validated failover as a cloud API, so local-first/cloud-fallback chains work out of the box.

### Enterprise clouds (Bedrock, Azure, Vertex, watsonx)

Bring your own cloud SDK — the gateway takes a factory, keeping this package at zero cloud dependencies and leaving SigV4/Entra/ADC/IAM auth to the SDKs built for it:

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"; // your dependency

const bedrock = createAmazonBedrock({ region: "us-east-1" });
const gw = new Gateway({
  usage,
  providers: {
    factories: { bedrock: { model: (id) => bedrock(id) } },
    pricing: { "anthropic.claude-sonnet-4-6-v1:0": { in: 0.3, out: 1.5 } }, // region rates: yours to supply
    retention: { bedrock: { zdr: true, note: "in-region, no retention per AWS terms" } },
  },
  modelConfig: {
    getOverride: async () => null,
    getChain: async () => [
      { factory: "bedrock", model: "anthropic.claude-sonnet-4-6-v1:0" },
      { provider: "anthropic", model: "claude-sonnet-4-6" }, // direct-API fallback
    ],
  },
});
// Task ids too: "bedrock:anthropic.claude-...". Recipes for all four clouds
// (including a watsonx IAM token-refresh helper): examples/enterprise-recipes.md
```

Factory models cost real money: unknown pricing warns and estimates conservatively — never silent $0 — and factories are NOT ZDR until you assert your contract terms.

### ZDR-aware routing (zero data retention)

Route by where data is retained, not just what it costs:

```ts
const gw = new Gateway({
  usage,
  providers: {
    retention: {
      anthropic: { zdr: true, note: "org ZDR addendum signed 2026-05" },
      "openai:gpt-4.1-enterprise": { zdr: true }, // model-specific beats provider-level
    },
  },
  tasks: {
    defaults: { intake_summary: "claude-haiku-4-5-20251001" },
    constraints: { intake_summary: { requireZdr: true } },
  },
});

await gw.runStructured({ ...opts, requireZdr: true }); // or via the task constraint
```

Failover chains **skip** non-eligible links and error only when none remain; the usage log records `zdrEnforced` so audits can prove the constraint held. Two things stated plainly: retention status is **caller-asserted** — ZDR is a contractual property of *your* account (Anthropic ZDR addendum, OpenAI enterprise tiers, in-region Bedrock), and this library will not pretend to detect it; missing entries are treated as NOT ZDR (fail closed). Self-hosted endpoints default to ZDR — override if yours is shared infrastructure. Check your own contracts: [Anthropic Trust Center](https://trust.anthropic.com), [OpenAI enterprise privacy](https://openai.com/enterprise-privacy), provider DPAs generally.

### Native Anthropic features (opt-in)

Adaptive extended thinking, prompt-caching `cache_control`, and server-side web search need Anthropic's native API. Bring your own client — the package takes no dependency on `@anthropic-ai/sdk`:

```ts
import Anthropic from "@anthropic-ai/sdk";

const gw = new Gateway({
  usage,
  anthropic: { client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) },
});

await gw.runStructured({
  ...opts,
  system: "You are a meticulous analyst.",
  anthropic: {
    thinking: true,                 // adaptive; or { budgetTokens: 8000 }
    cacheSystem: true,              // ephemeral cache_control on the system block
    webSearch: { maxUses: 4 },      // server-side web search, billed per request
  },
});
```

Only Anthropic links use the native client — other chain providers stay on the AI SDK, and failover still works across the boundary (native link fails → AI SDK fallback link runs). Thinking is gated per model (sending it to Haiku would 400). Cache-write/cache-read tokens and web-search counts are captured in the usage log and included in cost estimates.

The same options work on `runText` for **web-search-grounded text generation** — no schema, no emit tool, the model's text blocks are the answer:

```ts
const res = await gw.runText({
  slug: "discovery",
  input: { town: "Springfield" },
  variables: (i) => ({ town: i.town }),
  cache: false,
  anthropic: { webSearch: { maxUses: 4 } },
});
// res.text is the grounded answer; res.webSearches says how many searches it used
```

One caveat stated plainly: an unsupported-temperature 4xx on a native link is deliberately non-retryable, and a grounded call that fails over to a non-Anthropic link produces an *ungrounded* answer from the fallback model. If grounding is a hard requirement, keep the chain Anthropic-only for that call.

### Governed embeddings

Embedding spend at document-pipeline volume is real money — it goes through the same front door (rate limit, caps, ZDR, ledger):

```ts
const { embeddings } = await gw.embed(texts, {
  model: "openai:text-embedding-3-small", // default; pricing built in
  dimensions: 1536,
  userId, route: "docs/pipeline",
});
// Mock mode: deterministic seeded unit vectors (identical input → identical
// vector). BYO any AI SDK EmbeddingModel via opts.embeddingModel.
```

**Providers.** OpenAI and Voyage are first-class (`EMBEDDING_PROVIDER_IDS`); Voyage speaks the same OpenAI-compatible embeddings shape, so it needs a base URL and a `VOYAGE_API_KEY`, not a new dependency:

```ts
await gw.embed(texts, { model: "voyage:voyage-3" }); // priced and attributed to voyage
```

Anything else — a self-hosted encoder, a provider the gateway doesn't model — still goes through the `embeddingModel` BYO seam, which stays an escape hatch rather than the only option.

Embedding calls take the same bounds as generation (`signal`, `attemptMs`, `deadlineMs`) and the same `orgId` scoping.

### Per-link temperature

Model temperature tolerance differs per chain link — claude-sonnet-5 rejects any non-default temperature (a 4xx, which is deliberately *not* retryable, so it fails the call rather than falling through). Override per link: `null` = never send, a number pins it, unset inherits the call level:

```ts
getChain: async () => [
  { provider: "anthropic", model: "claude-sonnet-5", temperature: null },
  { provider: "openai", model: "gpt-4o", temperature: 0.3 },
],
```

### Judge in the request path

```ts
const res = await gw.runStructured({
  ...opts,
  judge: {
    criteria: {
      grounded: "Every claim is supported by the provided context",
      brevity: "No filler or repetition",
    },
    sampleRate: 0.1,            // judge 10% of calls — bounded eval spend
    model: "claude-haiku-4-5-20251001", // cheap judge model
    mode: "gate", threshold: 3, // optional: throw JudgeGateError below 3/5
  },
});
```

Scores land in your `UsageStore` (`saveJudgeScore`) linked to the call's usage row; judge spend is logged under `route: "judge:<route>"` so eval cost is visible, not hidden. In mock mode, register `judge:<slug>` responders to test gating deterministically.

**The judge tier.** The judge runs in the request path on every sampled call, so which model it uses is a governance decision an operator makes deliberately — not something it should inherit from whichever provider happens to be the default. It is a first-class tier alongside `fast`/`power`, and an admin can pin it at runtime:

```ts
providers: { tiers: { anthropic: { fast: "...", power: "...", judge: "claude-haiku-4-5-20251001" } } },
modelConfig: { getJudgeModel: async (orgId) => "openai:gpt-4o-mini" }, // admin pin, per tenant
```

Resolution: per-call `judge.model` → `getJudgeModel()` → gateway `judge.model` → provider `judge` tier → provider `fast` tier. There is no built-in judge model for any provider; an unset judge tier falls back to `fast`, which is the pre-tier behavior.

**The judge can never fail your request.** It runs on its own small budget, and a judge that times out, errors, or exhausts its budget is skipped — the response it was scoring still returns. A governance check must never be the thing that breaks the request it was watching.

### Batch processing (50% token cost)

Anthropic Message Batches with two-phase spend accounting — see [the design doc](./docs/design/batch-processing.md):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropicBatchClient, MemoryBatchJobStore } from "llm-governance-gateway";

const gw = new Gateway({
  usage,
  batch: { client: anthropicBatchClient(new Anthropic({ apiKey })), store: jobStore },
});

const sub = await gw.submitBatch(ItemSchema, {
  slug: "menu_extract",
  model: "claude-haiku-4-5-20251001",
  items: pages.map((p) => ({ id: p.id, variables: { html: p.html } })),
  maxCostCents: 500, // optional hard ceiling — the ESTIMATE is not the guarantee
});
// sub.cached — items served from cache, never submitted
// Reservation logged at submit: a submitted batch is committed money.

// Later (cron): if ((await gw.pollBatch(sub.batchId)).ready) …
const { results, costCents } = await gw.reconcileBatch(sub.batchId, ItemSchema);
// per-item: { ok:true, object } | { ok:false, reason: "schema"|"errored"|"expired"|"canceled" }
```

Reconcile logs per-item discounted actuals, releases the reservation with a compensating row (net spend = actuals), and is idempotent by job state. Schema-invalid items are flagged, never silently re-run at sync prices.

### Streaming

`streamStructured` runs the same governance front door (rate limit → caps → cache), then streams partial objects:

```ts
const res = await gw.streamStructured({ ...opts });
for await (const partial of res.partialObjectStream) render(partial);
const final = await res.object; // resolves after usage logging + cache write
res.failovers; // links abandoned before this one — read after `object` settles
```

**Mid-stream failover.** When a link stalls or fails retryably, the gateway abandons it and restarts on the next link in the chain. Each abandoned attempt is ledgered as its own zero-token row, and `onStreamFailover` fires with `reason` (`"stall" | "retryable"`) and `hadPartialOutput`.

**The degradation contract, stated plainly:** the next link restarts the object from scratch. A consumer rendering partials will see the object *rebuild*, not continue — the partial sequence is **not monotonic across a failover**. No information is lost (every partial is a complete snapshot), but a UI that assumes fields only ever accumulate will flicker. `hadPartialOutput` is the flag that tells you it happened; if that matters to your UI, buffer until `object` settles instead of rendering partials.

Restarting rather than resuming is deliberate: no provider offers mid-object continuation, and stitching two partial JSON objects together produces a document neither model would have written.

Remaining constraints, stated plainly: no repair retry, no judge, no native-Anthropic options on the streaming path. Cache hits return a single-emission stream.

### Observability export (OTel, Langfuse, metrics)

The gateway is a governance library, not an observability platform — so it exports instead of competing. Three hooks fire after each durable write, fire-and-forget: a throwing or slow exporter can never break or block a governed call.

```ts
import { toOtelAttributes } from "llm-governance-gateway";

const gw = new Gateway({
  usage,
  observability: {
    onUsage: (entry) => span?.setAttributes(toOtelAttributes(entry)),
    onSpendCapEvent: (e) => meter.counter("llm_cap_blocks").add(1, { route: e.route ?? "" }),
    onJudgeScore: (s) => langfuse.score({ traceId: String(s.usageLogId), value: s.overallScore }),
  },
});
```

`toOtelAttributes` maps usage entries onto the OTel GenAI semantic conventions (`gen_ai.*`) plus `llm_gateway.*` extensions for cost, cache hits, web searches, and ZDR enforcement. No OTel or Langfuse dependency is taken; the hooks receive plain objects. One privacy note: when an encrypt hook is configured, `inputText`/`outputText` reach your exporter already encrypted, so the at-rest guarantee extends to telemetry.

### HTTP service (multi-app deployments)

Mount the pipeline as a service so apps in any language share one enforcement point. Hono (optional peer dep) runs on Cloudflare Workers, Node, Bun, and Deno:

```ts
import { createGatewayApp } from "llm-governance-gateway/http";

const app = createGatewayApp({
  gateway: gw,
  auth: { [env.APP_A_TOKEN]: "app-a", [env.APP_B_TOKEN]: "app-b" }, // token → appId tag
  adminTokens: [env.ADMIN_TOKEN], // gates POST /prompt-test
});

export default app; // Cloudflare Workers
// Node: import { serve } from "@hono/node-server"; serve(app);
```

Endpoints: `POST /run` (structured generation — send your Zod schema as JSON Schema via `z.toJSONSchema()`), `GET /models`, `GET /tasks`, `POST /prompt-test`, `GET /health`. Errors map to `429` (rate limit), `402` (spend cap — global-breaker responses say "at capacity", not "over your limit"), `400` (caller errors), `401`/`403`.

`POST /run` supports both prompt modes: `variables` renders the server-side prompt library entry for `slug`; `promptBody` sends a client-rendered template instead.

## Design notes

- **Fail-open rate limiting, fail-closed spend caps.** A Redis blip should not 500 every AI call — the limiter fails open with an alert, while the store-backed spend cap (independent of Redis) still bounds cost.
- **Global breaker before per-user caps.** Per-identity caps can't see N users × cap on a viral day.
- **Cache is opt-out per call**, and `cache: false` skips both read *and* write — required for PII-bearing calls.
- **In-memory defaults are for dev/single-process only.** On serverless they reset every cold start, which silently disables enforcement.

## Status

Extracted from a production system (three independent in-house implementations converged on this design). Pre-1.0, so the API may still shift — though in practice the store interfaces (`UsageStore`, `PromptStore`, `ModelConfigStore`, `TaskOverrideStore`, `RateLimiter`, `CacheStore`) have only ever gained capability through *optional* parameters, and existing implementations keep compiling. 1.0.0 is gated on a downstream integration proving that holds, not on a date. See [CHANGELOG.md](./CHANGELOG.md).

Next up ([ROADMAP](./ROADMAP.md)): pluggable guardrail hooks and an admin UI reference, both gated on real adopter demand rather than speculation.

## License

MIT
