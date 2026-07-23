# llm-governance-gateway

**The governance layer LLM proxies promised — as a TypeScript library you can read.**

Every call runs through one governed pipeline:

```
rate limit → spend caps (per-user + global circuit breaker) → cache
→ schema-validated provider failover → usage log → LLM-judge
```

No sidecar proxy to deploy. No hosted control plane. No sprawling dependency tree — five runtime deps (the [Vercel AI SDK](https://sdk.vercel.ai), three provider adapters, Zod), everything else optional peers. It runs *in your process*, enforces caps against *your* database, and the whole pipeline — caps, cache, failover, judge — runs deterministically in CI with zero API keys.

Providers: Anthropic, Google, OpenAI, OpenRouter, Venice — plus bring-your-own AI SDK model (Azure, Bedrock, custom endpoints) in any failover chain.

## Why

Spend controls in this space are usually observed (dashboards that tell you *after* the money is gone) or enforced by infrastructure you must operate and trust (proxies, gateways, hosted control planes). This library takes the third path: governance as code in your own runtime, checked before every call, type-safe from Zod schema to spend cap.

- **Spend caps that actually hold.** Per-user daily caps plus an app-wide daily circuit breaker, checked against your usage store before every call. Unset ≠ uncapped: defaults are conservative, and only an explicit `0` opts out.
- **Schema-validation-aware failover.** primary → fallback → backup providers, with 429/5xx-aware retries, `Retry-After` honoring, and equal-jitter backoff. When a model returns schema-invalid output, the validation error is fed back for one repair attempt, then the chain falls to the next provider — a different model often satisfies the schema where the first couldn't ([vercel/ai#9950](https://github.com/vercel/ai/issues/9950), [#9002](https://github.com/vercel/ai/issues/9002)). Chain links accept bring-your-own AI SDK models (Azure, Bedrock, custom base URLs).
- **Deterministic CI.** Mock mode replaces providers with registered responders — your AI-dependent test suite runs offline with zero keys.
- **Prompt library pattern.** Store-as-override, code-as-fallback: admins can edit prompts at runtime; a broken edit (missing `{{placeholder}}`) falls back to the code default instead of silently sending a malformed prompt.
- **Judge + telemetry.** Optional per-call rubric scoring and full usage accounting (tokens, cost, latency, trace IDs), with an optional at-rest encryption hook for logged prompt/output snapshots.
- **Task-based routing.** Name your call sites (`"enrich"`, `"dedup_judge"`, `"editorial"`), assign each a default model in code, and let an admin store override models per task at runtime — with TTL caching and graceful degradation to code defaults when the store is down.
- **Live model discovery.** `listAllProviderModels()` queries each vendor's models API for every provider with an API key configured; keyless or erroring providers fall back to static lists so admin UIs stay usable offline.
- **Prompt test runs.** `runPromptTest()` executes an edited (even unsaved) prompt body with sample variables against any model, bypassing the cache but *not* usage logging — test spend shows up in the cost dashboard under `admin:prompt-test`.

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

Keys resolve in order: `ProviderConfig.apiKeys` (programmatic) → shell env → `.env.local` / `.env` (loaded by the CLI and smoke script via `loadEnvFiles()`; call it yourself in dev servers if you want file-based keys there too). This is deliberately not a secrets manager — production keys belong in your deploy platform's secret store.

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
    store: myAdminOverrideStore, // optional: { getOverrides(): Promise<Record<string,string>> }
  },
});

await gw.runStructured({ ...opts, task: "enrich" });
```

Precedence: `modelConfig.getOverride()` → `task` → chain → static default.

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

Extracted from a production system (three independent in-house implementations converged on this design). API may shift before 1.0. Roadmap: standalone HTTP gateway (Hono/Workers) exposing `/run` for multi-app deployments, Drizzle/Postgres reference `UsageStore`, streaming support.

## License

MIT
